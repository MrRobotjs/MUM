package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"net/http"
	"strconv"
	"time"
)

type serviceExpiryRecord struct {
	Actor     string  `json:"actor_uuid"`
	Target    string  `json:"service_uuid"`
	Username  string  `json:"username"`
	Server    string  `json:"server_id"`
	Owner     *string `json:"owner_uuid"`
	Active    bool    `json:"is_active"`
	Expires   *string `json:"access_expires_at"`
	Revision  string  `json:"expiry_revision"`
	Link      string  `json:"link_revision"`
	Source    string  `json:"server_revision"`
	CanEdit   bool    `json:"can_edit"`
	Reason    string  `json:"availability"`
	LocalOnly bool    `json:"local_only"`
}

func readServiceExpiry(ctx context.Context, tx *sql.Tx, actor, access, target string) (serviceExpiryRecord, error) {
	out := serviceExpiryRecord{Actor: actor, Target: target, Reason: "available", LocalOnly: true}
	if err := notificationAuthority(ctx, tx, actor, access); err != nil {
		return out, err
	}
	p, err := loadPrincipal(ctx, tx, actor)
	if err != nil {
		return out, err
	}
	if p.Kind != "owner" {
		return out, ErrForbidden
	}
	if !validAdminMemberCursor(target) {
		return out, ErrNotFound
	}
	var server, revision, link, source int64
	err = tx.QueryRowContext(ctx, `SELECT coalesce(a.external_username,''),a.server_id,a.is_active,a.access_expires_at,(SELECT user_uuid FROM service_links WHERE service_uuid=a.uuid AND link_kind='owner'),e.revision,s.revision,(SELECT revision FROM account_link_state WHERE singleton=1) FROM service_accounts a JOIN service_expiry_state e ON e.uuid=a.uuid JOIN media_servers s ON s.id=a.server_id WHERE a.uuid=?`, target).Scan(&out.Username, &server, &out.Active, &out.Expires, &out.Owner, &revision, &source, &link)
	if err != nil {
		return out, err
	}
	if out.Expires != nil {
		if _, err = time.Parse(time.RFC3339Nano, *out.Expires); err != nil {
			return out, ErrConflict
		}
	}
	out.Server = strconv.FormatInt(server, 10)
	out.Revision = strconv.FormatInt(revision, 10)
	out.Link = strconv.FormatInt(link, 10)
	out.Source = strconv.FormatInt(source, 10)
	pending, err := servicePendingWork(ctx, tx, server)
	if err != nil {
		return out, err
	}
	if pending {
		out.Reason = "pending_work"
	}
	out.CanEdit = !pending
	return out, nil
}

// Service-account policy changes wait for provisioning, review/resume, Plex
// share/credential work and remote access operations that could race them.
func servicePendingWork(ctx context.Context, tx *sql.Tx, server int64) (bool, error) {
	busy, err := bulkSourceBusy(ctx, tx, server, "")
	if err != nil || busy {
		return busy, err
	}
	var pending bool
	err = tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM provisioning_steps s JOIN provisioning_jobs j ON j.id=s.job_id WHERE s.server_id=? AND ((j.status<>'completed' AND j.resolution IS NULL) OR j.reservation_held=1)) OR EXISTS(SELECT 1 FROM provisioning_jobs WHERE review_token IS NOT NULL) OR EXISTS(SELECT 1 FROM plex_share_checkpoints WHERE operation_token IS NOT NULL) OR EXISTS(SELECT 1 FROM plex_invitation_credentials WHERE refresh_token IS NOT NULL) OR EXISTS(SELECT 1 FROM service_remote_access o JOIN service_accounts a ON a.uuid=o.service_uuid WHERE a.server_id=? AND o.operation_token IS NOT NULL)`, server, server).Scan(&pending)
	return pending, err
}

func (a *App) serviceExpiry(w http.ResponseWriter, r *http.Request) {
	p, ok := a.principal(w, r, true)
	if !ok {
		return
	}
	if r.URL.RawQuery != "" {
		domainError(w, ErrConflict)
		return
	}
	if r.Method == http.MethodGet {
		tx, err := a.store.reader.BeginTx(r.Context(), &sql.TxOptions{ReadOnly: true})
		if err != nil {
			domainError(w, err)
			return
		}
		defer tx.Rollback()
		out, err := readServiceExpiry(r.Context(), tx, p.UUID, bearer(r), r.PathValue("service"))
		if err == nil {
			err = tx.Commit()
		}
		if err != nil {
			domainError(w, err)
			return
		}
		respond(w, 200, out)
		return
	}
	var input struct {
		Actor     string          `json:"expected_actor_uuid"`
		Target    string          `json:"expected_service_uuid"`
		Revision  string          `json:"expiry_revision"`
		Link      string          `json:"link_revision"`
		Source    string          `json:"server_revision"`
		Active    *bool           `json:"expected_is_active"`
		Owner     json.RawMessage `json:"expected_owner_uuid"`
		Before    json.RawMessage `json:"expected_access_expires_at"`
		After     json.RawMessage `json:"access_expires_at"`
		LocalOnly bool            `json:"acknowledge_local_only"`
	}
	if !decodeStrictBody(w, r, &input) {
		return
	}
	var owner, before, after *string
	if !input.LocalOnly || input.Active == nil || len(input.Owner) == 0 || len(input.Before) == 0 || len(input.After) == 0 || json.Unmarshal(input.Owner, &owner) != nil || json.Unmarshal(input.Before, &before) != nil || json.Unmarshal(input.After, &after) != nil {
		domainError(w, ErrConflict)
		return
	}
	var deadline time.Time
	if after != nil {
		var err error
		deadline, err = time.Parse(time.RFC3339, *after)
		if err != nil || len(*after) != 20 || deadline.UTC().Format(time.RFC3339) != *after || !deadline.After(time.Now()) {
			domainError(w, ErrConflict)
			return
		}
	}
	var out serviceExpiryRecord
	err := a.store.write(r.Context(), func(tx *sql.Tx) error {
		current, err := readServiceExpiry(r.Context(), tx, p.UUID, bearer(r), r.PathValue("service"))
		if err != nil {
			return err
		}
		if input.Actor != p.UUID {
			return ErrForbidden
		}
		if !current.CanEdit || input.Target != current.Target || input.Revision != current.Revision || input.Link != current.Link || input.Source != current.Source || *input.Active != current.Active || !sameHumanExpiry(owner, current.Owner) || !sameHumanExpiry(before, current.Expires) || sameHumanExpiry(after, current.Expires) || after != nil && !deadline.After(time.Now()) {
			return ErrConflict
		}
		if _, err = tx.ExecContext(r.Context(), "UPDATE service_accounts SET access_expires_at=?,updated_at=? WHERE uuid=?", after, utcTimestamp(time.Now()), current.Target); err != nil {
			return err
		}
		if _, err = tx.ExecContext(r.Context(), `INSERT INTO audit_events(actor_uuid,action,details,occurred_at) VALUES(?,'service.expiry.change',json_object('target_uuid',?,'before',?,'after',?,'local_only',json('true'),'remote_access_changed',json('false')),?)`, p.UUID, current.Target, current.Expires, after, utcTimestamp(time.Now())); err != nil {
			return err
		}
		out, err = readServiceExpiry(r.Context(), tx, p.UUID, bearer(r), current.Target)
		return err
	})
	if err != nil {
		domainError(w, err)
		return
	}
	if out.Owner != nil {
		a.hub.closeAccountConnections(*out.Owner)
	}
	respond(w, 200, out)
}
