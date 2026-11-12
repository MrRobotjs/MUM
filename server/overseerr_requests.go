package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"time"
)

// Overseerr MediaRequestStatus values.
const (
	overseerrPending  = 1
	overseerrApproved = 2
	overseerrDeclined = 3
)

type overseerrRequestState struct {
	ID          int64 `json:"id"`
	Status      int   `json:"status"`
	RequestedBy *struct {
		ID int64 `json:"id"`
	} `json:"requestedBy"`
}

func (c *overseerrClient) request(ctx context.Context, id int64) (overseerrRequestState, error) {
	var state overseerrRequestState
	if err := c.get(ctx, "/api/v1/request/"+strconv.FormatInt(id, 10), nil, &state); err != nil {
		return state, err
	}
	if state.ID != id || state.RequestedBy == nil || state.RequestedBy.ID < 1 {
		return state, errors.New("Overseerr request record is incomplete")
	}
	return state, nil
}

func (c *overseerrClient) post(ctx context.Context, path string) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.base+path, nil)
	if err != nil {
		return err
	}
	req.Header.Set("X-Api-Key", c.key)
	req.Header.Set("Accept", "application/json")
	response, err := c.client.Do(req)
	if err != nil {
		return errors.New("Overseerr request failed or timed out")
	}
	defer response.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 1<<20))
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return &providerHTTPError{StatusCode: response.StatusCode}
	}
	return nil
}

// overseerrRequestAction approves or declines one pending Overseerr request
// made by a user MUM has linked on that server. It inspects first, writes at
// most once, verifies the resulting status and never replays a lost write.
func (a *App) overseerrRequestAction(w http.ResponseWriter, r *http.Request) {
	p, ok := a.principal(w, r, true)
	if !ok {
		return
	}
	server, ok := pathID(w, r, "server")
	if !ok {
		return
	}
	request, err := strconv.ParseInt(r.PathValue("request"), 10, 64)
	action := r.PathValue("action")
	if err != nil || request < 1 || (action != "approve" && action != "decline") || r.URL.RawQuery != "" {
		fail(w, 400, "INVALID_OVERSEERR_ACTION", "Approve or decline one positive request ID")
		return
	}
	want := overseerrApproved
	if action == "decline" {
		want = overseerrDeclined
	}
	tx, err := a.store.reader.BeginTx(r.Context(), &sql.TxOptions{ReadOnly: true})
	if err != nil {
		domainError(w, err)
		return
	}
	defer tx.Rollback()
	err = notificationAuthority(r.Context(), tx, p.UUID, bearer(r))
	var config overseerrConfig
	enabled := false
	if err == nil {
		config, enabled, err = readOverseerrConfig(r.Context(), tx, server)
	}
	if err == nil && !enabled {
		err = ErrConflict
	}
	if err == nil {
		err = tx.Commit()
	}
	if err != nil {
		domainError(w, err)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()
	client, err := newOverseerrClient(config.URL, config.key, a.ProviderHTTP)
	if err != nil {
		domainError(w, err)
		return
	}
	state, err := client.request(ctx, request)
	if err != nil {
		fail(w, 502, "OVERSEERR_UNAVAILABLE", overseerrMessage(err))
		return
	}
	var linked bool
	if err = a.store.reader.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM overseerr_links WHERE server_id=? AND overseerr_user_id=?)", server, state.RequestedBy.ID).Scan(&linked); err != nil {
		domainError(w, err)
		return
	}
	if !linked {
		fail(w, 409, "OVERSEERR_USER_NOT_LINKED", "This request was not made by a linked MUM account")
		return
	}
	outcome, code := "", ""
	switch {
	case state.Status == want:
		outcome = "unchanged"
	case state.Status != overseerrPending:
		fail(w, 409, "OVERSEERR_REQUEST_NOT_PENDING", "Only pending requests can be approved or declined")
		return
	default:
		if err = client.post(ctx, "/api/v1/request/"+strconv.FormatInt(request, 10)+"/"+action); err != nil {
			outcome, code = "unknown", "OVERSEERR_OUTCOME_UNCERTAIN"
		} else if after, err := client.request(ctx, request); err != nil {
			outcome, code = "unknown", "OVERSEERR_OUTCOME_UNCERTAIN"
		} else if after.Status == want {
			outcome = action + "d"
		} else {
			outcome, code = "failed", "OVERSEERR_ACTION_NOT_VERIFIED"
		}
	}
	details, _ := json.Marshal(map[string]any{"server_id": server, "request_id": request, "action": action, "outcome": outcome, "error_code": code})
	// The attempt is audited even if the client disconnected after dispatch.
	auditCtx, cancelAudit := context.WithTimeout(context.WithoutCancel(ctx), 3*time.Second)
	defer cancelAudit()
	auditErr := a.store.write(auditCtx, func(tx *sql.Tx) error {
		_, err := tx.ExecContext(auditCtx, "INSERT INTO audit_events(actor_uuid,action,details,occurred_at) VALUES(?,?,?,?)", p.UUID, "overseerr.request."+action, string(details), utcTimestamp(time.Now()))
		return err
	})
	switch {
	case code == "OVERSEERR_OUTCOME_UNCERTAIN" || auditErr != nil:
		fail(w, 503, "OVERSEERR_OUTCOME_UNCERTAIN", "The Overseerr outcome is unknown; reload the profile before another change")
	case code != "":
		fail(w, 409, code, "Overseerr did not confirm the change")
	default:
		respond(w, 200, map[string]any{"request_id": request, "status": want, "outcome": outcome})
	}
}
