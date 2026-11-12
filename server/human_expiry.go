package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"net/http"
	"strconv"
	"time"
)

type humanExpiryRecord struct {
	Actor              string  `json:"actor_uuid"`
	Target             string  `json:"user_uuid"`
	Kind               string  `json:"user_type"`
	Username           string  `json:"username"`
	Active             bool    `json:"is_active"`
	Expires            *string `json:"access_expires_at"`
	Revision           string  `json:"expiry_revision"`
	ProfileRevision    string  `json:"profile_revision"`
	ActivationRevision string  `json:"activation_revision"`
	RoleRevision       string  `json:"role_revision"`
	CanEdit            bool    `json:"can_edit"`
	Reason             string  `json:"availability"`
	SessionsRevoked    bool    `json:"sessions_revoked"`
}

func readHumanExpiry(ctx context.Context, tx *sql.Tx, actor, access, target string) (humanExpiryRecord, error) {
	// Reuse the live hierarchy, exact session and conservative work barriers.
	activation, err := readHumanActivation(ctx, tx, actor, access, target)
	if err != nil {
		return humanExpiryRecord{}, err
	}
	out := humanExpiryRecord{Actor: actor, Target: target, Kind: activation.Kind, Username: activation.Username, Active: activation.Active,
		ProfileRevision: activation.ProfileRevision, ActivationRevision: activation.ActivationRevision, RoleRevision: activation.RoleRevision, Reason: activation.Reason}
	var expires sql.NullString
	var revision int64
	if err = tx.QueryRowContext(ctx, `SELECT u.access_expires_at,e.revision FROM user_accounts u JOIN human_expiry_state e ON e.uuid=u.uuid WHERE u.uuid=?`, target).Scan(&expires, &revision); err != nil {
		return out, err
	}
	if expires.Valid {
		if _, err = time.Parse(time.RFC3339Nano, expires.String); err != nil {
			return out, ErrConflict
		}
		out.Expires = &expires.String
	}
	out.Revision = strconv.FormatInt(revision, 10)
	// Expired accounts can be extended/cleared without changing activation.
	if out.Reason == "expired" {
		out.Reason = "available"
	}
	out.CanEdit = out.Reason == "available"
	return out, nil
}

func sameHumanExpiry(a, b *string) bool {
	return a == nil && b == nil || a != nil && b != nil && *a == *b
}

func (a *App) humanExpiry(w http.ResponseWriter, r *http.Request) {
	actor, ok := a.principal(w, r, true)
	if !ok {
		return
	}
	if r.URL.RawQuery != "" {
		fail(w, 400, "INVALID_SELECTION", "Select one human profile")
		return
	}
	if r.Method == http.MethodGet {
		tx, err := a.store.reader.BeginTx(r.Context(), &sql.TxOptions{ReadOnly: true})
		if err != nil {
			domainError(w, err)
			return
		}
		defer tx.Rollback()
		out, err := readHumanExpiry(r.Context(), tx, actor.UUID, bearer(r), r.PathValue("user"))
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
		Actor              string          `json:"expected_actor_uuid"`
		Target             string          `json:"expected_user_uuid"`
		Revision           string          `json:"expiry_revision"`
		ProfileRevision    string          `json:"profile_revision"`
		ActivationRevision string          `json:"activation_revision"`
		RoleRevision       string          `json:"role_revision"`
		Active             *bool           `json:"expected_is_active"`
		Expected           json.RawMessage `json:"expected_access_expires_at"`
		Expires            json.RawMessage `json:"access_expires_at"`
		Revoke             bool            `json:"acknowledge_revoke_sessions"`
		LocalOnly          bool            `json:"acknowledge_local_only"`
	}
	if !decodeStrictBody(w, r, &input) {
		return
	}
	var expected, expires *string
	if input.Active == nil || !input.Revoke || !input.LocalOnly || len(input.Expected) == 0 || len(input.Expires) == 0 || json.Unmarshal(input.Expected, &expected) != nil || json.Unmarshal(input.Expires, &expires) != nil {
		fail(w, 400, "INVALID_EXPIRY", "Provide explicit saved/new expiry and acknowledge local-only changes and signing out all MUM sessions")
		return
	}
	var deadline time.Time
	if expires != nil {
		var err error
		deadline, err = time.Parse(time.RFC3339, *expires)
		if err != nil || len(*expires) != 20 || deadline.UTC().Format(time.RFC3339) != *expires || !deadline.After(time.Now()) {
			fail(w, 400, "INVALID_EXPIRY", "Use a future UTC timestamp YYYY-MM-DDTHH:MM:SSZ or null to clear")
			return
		}
	}
	var out humanExpiryRecord
	err := a.store.write(r.Context(), func(tx *sql.Tx) error {
		current, err := readHumanExpiry(r.Context(), tx, actor.UUID, bearer(r), r.PathValue("user"))
		if err != nil {
			return err
		}
		if input.Actor != actor.UUID {
			return ErrForbidden
		}
		if input.Target != current.Target || input.Revision != current.Revision || input.ProfileRevision != current.ProfileRevision || input.ActivationRevision != current.ActivationRevision || input.RoleRevision != current.RoleRevision || *input.Active != current.Active || !sameHumanExpiry(expected, current.Expires) || sameHumanExpiry(expires, current.Expires) {
			return ErrConflict
		}
		if !current.CanEdit {
			if current.Reason == "protected_owner" || current.Reason == "protected_self" {
				return ErrForbidden
			}
			return ErrConflict
		}
		if expires != nil && !deadline.After(time.Now()) {
			return ErrConflict
		}
		now := utcTimestamp(time.Now())
		if _, err = tx.ExecContext(r.Context(), "UPDATE user_accounts SET access_expires_at=?,profile_revision=profile_revision+1,updated_at=? WHERE uuid=?", expires, now, current.Target); err != nil {
			return err
		}
		if err = revokeHumanSignIn(r.Context(), tx, current.Target, now); err != nil {
			return err
		}
		if _, err = tx.ExecContext(r.Context(), `INSERT INTO audit_events(actor_uuid,action,details,occurred_at) VALUES(?,'account.expiry.change',json_object('target_uuid',?,'before',?,'after',?,'sessions_revoked',json('true')),?)`, actor.UUID, current.Target, current.Expires, expires, now); err != nil {
			return err
		}
		out, err = readHumanExpiry(r.Context(), tx, actor.UUID, bearer(r), current.Target)
		out.SessionsRevoked = true
		return err
	})
	if err != nil {
		domainError(w, err)
		return
	}
	a.hub.closeAccountConnections(out.Target)
	respond(w, 200, out)
}
