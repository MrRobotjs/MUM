package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"app/server/providers/provider"
)

// Stopping a stream from the Streams page. Only the owner and full
// administrators may. MUM asks the stream's server
// to stop it once, never retries, and records every attempt with its outcome
// in the audit log. The server is contacted outside any transaction.

// sessionTerminator is the module feature that stops a stream.
type sessionTerminator interface {
	TerminateSession(ctx context.Context, session, message string) error
}

// startStreamOperation admits one provider request for a stream action and
// tracks it so shutdown waits for it and cancels it.
func (a *App) startStreamOperation(w http.ResponseWriter, r *http.Request) (context.Context, func(), bool) {
	a.provisionMu.Lock()
	if a.provisionClosing {
		a.provisionMu.Unlock()
		fail(w, 503, "SHUTTING_DOWN", "MUM is shutting down")
		return nil, nil, false
	}
	a.provisionWG.Add(1)
	a.provisionMu.Unlock()
	select {
	case a.provisionSlots <- struct{}{}:
	default:
		a.provisionWG.Done()
		fail(w, 503, "SERVER_BUSY", "MUM is busy with other server requests. Try again shortly.")
		return nil, nil, false
	}
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	stop := context.AfterFunc(a.provisionCtx, cancel)
	return ctx, func() { stop(); cancel(); <-a.provisionSlots; a.provisionWG.Done() }, true
}

// terminateOutcome names the result of one stop request for the audit log.
func terminateOutcome(err error) string {
	switch {
	case err == nil:
		return "terminated"
	case errors.Is(err, provider.ErrSessionGone):
		return "already_ended"
	case errors.Is(err, provider.ErrTerminateRefused):
		return "refused"
	}
	return "failed"
}

// validTerminateMessage accepts an optional message of printable text.
func validTerminateMessage(message string) bool {
	if !utf8.ValidString(message) || utf8.RuneCountInString(message) > provider.MaxTerminateMessage {
		return false
	}
	for _, c := range message {
		if unicode.IsControl(c) && c != '\n' {
			return false
		}
	}
	return true
}

func (a *App) terminateStream(w http.ResponseWriter, r *http.Request) {
	actor, ok := a.principal(w, r, true)
	if !ok {
		return
	}
	var input struct {
		Message string `json:"message"`
	}
	if !decodeStrictBody(w, r, &input) {
		return
	}
	message := strings.TrimSpace(input.Message)
	if !validTerminateMessage(message) {
		fail(w, 400, "INVALID_MESSAGE", "The message must be plain text of at most 500 characters")
		return
	}
	history, err := strconv.ParseInt(r.PathValue("observation"), 10, 64)
	if err != nil || history < 1 {
		fail(w, 400, "INVALID_ID", "Invalid stream")
		return
	}
	var serverID int64
	var session, kind string
	err = a.store.reader.QueryRowContext(r.Context(), `SELECT c.server_id,c.external_session_id,s.service_type FROM media_activity_current c
	 JOIN media_servers s ON s.id=c.server_id WHERE c.history_id=? AND s.is_active=1`, history).Scan(&serverID, &session, &kind)
	if errors.Is(err, sql.ErrNoRows) {
		fail(w, 404, "STREAM_NOT_FOUND", "This stream has ended or is no longer shown.")
		return
	}
	if err != nil {
		domainError(w, err)
		return
	}
	if kind == "tofa" && message != "" {
		fail(w, 400, "MESSAGE_UNSUPPORTED", "Tofa does not support a message when stopping a stream.")
		return
	}
	ctx, done, ok := a.startStreamOperation(w, r)
	if !ok {
		return
	}
	defer done()
	server, err := a.loadServer(ctx, serverID)
	if err != nil || !server.EffectiveActive {
		fail(w, 409, "SERVER_UNAVAILABLE", "This stream's server is not available.")
		return
	}
	connection, err := newServerConnection(ProviderConfig{server.Type, server.URL, server.apiKey}, a.ProviderHTTP)
	if err != nil {
		fail(w, 409, "SERVER_UNAVAILABLE", "This stream's server is not available.")
		return
	}
	terminator, supported := connection.module().(sessionTerminator)
	if !supported {
		fail(w, 409, "TERMINATE_UNSUPPORTED", "This server type cannot stop streams from MUM.")
		return
	}
	outcome := terminateOutcome(terminator.TerminateSession(ctx, session, message))
	// The attempt is recorded whatever happened; it is never retried.
	details, _ := json.Marshal(map[string]any{"server_id": serverID, "history_id": history, "provider": kind, "outcome": outcome, "message_sent": message != ""})
	record := context.WithoutCancel(ctx)
	if auditErr := a.store.write(record, func(tx *sql.Tx) error {
		_, err := tx.ExecContext(record, "INSERT INTO audit_events(actor_uuid,action,details,occurred_at) VALUES(?,'stream.terminate',?,?)", actor.UUID, string(details), utcTimestamp(time.Now()))
		return err
	}); auditErr != nil && outcome == "terminated" {
		domainError(w, auditErr)
		return
	}
	switch outcome {
	case "terminated":
		respond(w, 200, map[string]any{"id": strconv.FormatInt(history, 10), "status": "terminated"})
	case "already_ended":
		fail(w, 409, "STREAM_ENDED", "This stream has already ended.")
	case "refused":
		hint := "The server refused to stop this stream."
		switch kind {
		case "plex":
			hint += " Plex only allows this when the server owner has Plex Pass."
		case "tofa":
			hint += " Use a full-admin key or a read-only key allowed to stop streams."
		}
		fail(w, 409, "TERMINATE_REFUSED", hint)
	default:
		fail(w, 502, "TERMINATE_FAILED", "MUM could not reach the server. The stream may still be playing.")
	}
}
