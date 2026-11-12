package main

import (
	"context"
	"database/sql"
	"errors"
	"net/http"
	"strconv"
	"time"
)

type humanActivationRecord struct {
	Actor              string `json:"actor_uuid"`
	Target             string `json:"user_uuid"`
	Kind               string `json:"user_type"`
	Username           string `json:"username"`
	Active             bool   `json:"is_active"`
	ActivationRevision string `json:"activation_revision"`
	ProfileRevision    string `json:"profile_revision"`
	RoleRevision       string `json:"role_revision"`
	CanActivate        bool   `json:"can_activate"`
	CanDeactivate      bool   `json:"can_deactivate"`
	Reason             string `json:"availability"`
	SessionsRevoked    bool   `json:"sessions_revoked"`
}

// Keep activation serialized with review claims. Session revocation cannot
// cancel a provider request already dispatched by an administrator, so all
// outstanding claims (including unattributed/private Plex work) remain barriers.
func readHumanActivation(ctx context.Context, tx *sql.Tx, actor, access, target string) (humanActivationRecord, error) {
	out := humanActivationRecord{Actor: actor, Target: target, Reason: "available"}
	if !validAdminMemberCursor(target) {
		return out, ErrNotFound
	}
	if err := accountPreferenceAuthority(ctx, tx, actor, access); err != nil {
		return out, err
	}
	authority, err := readAdminRoleHierarchyActor(ctx, tx, actor)
	if err != nil {
		return out, err
	}
	var activation, profile, role int64
	var hasPassword, deleted bool
	var expires sql.NullString
	err = tx.QueryRowContext(ctx, `SELECT u.kind,coalesce(u.local_username,u.deleted_username,''),u.is_active,u.profile_revision,a.revision,u.password_hash IS NOT NULL,u.access_expires_at,u.deleted_at IS NOT NULL
 FROM user_accounts u JOIN human_activation_state a ON a.uuid=u.uuid WHERE u.uuid=?`, target).Scan(&out.Kind, &out.Username, &out.Active, &profile, &activation, &hasPassword, &expires, &deleted)
	if errors.Is(err, sql.ErrNoRows) {
		err = ErrNotFound
	}
	if err != nil {
		return out, err
	}
	if out.Kind == "owner" {
		out.Reason = "protected_owner"
	} else if target == actor {
		out.Reason = "protected_self"
	} else if err = checkAdminRoleHierarchyTarget(ctx, tx, authority, target); err != nil {
		return out, err
	}
	if err = tx.QueryRowContext(ctx, "SELECT revision FROM admin_role_state WHERE singleton=1").Scan(&role); err != nil {
		return out, err
	}
	out.ActivationRevision = strconv.FormatInt(activation, 10)
	out.ProfileRevision = strconv.FormatInt(profile, 10)
	out.RoleRevision = strconv.FormatInt(role, 10)
	if deleted {
		// A deleted (retired) account is never reactivated.
		out.Reason = "deleted"
	}
	if out.Reason != "available" {
		return out, nil
	}
	var pending bool
	err = tx.QueryRowContext(ctx, `SELECT
 EXISTS(SELECT 1 FROM provisioning_jobs WHERE user_uuid=? AND (status!='completed' OR reservation_held=1 OR review_token IS NOT NULL))
 OR EXISTS(SELECT 1 FROM provisioning_jobs WHERE review_token IS NOT NULL)
 OR EXISTS(SELECT 1 FROM plex_share_checkpoints WHERE operation_token IS NOT NULL)
 OR EXISTS(SELECT 1 FROM plex_invitation_credentials WHERE refresh_token IS NOT NULL)
 OR EXISTS(SELECT 1 FROM plex_authorizations WHERE owner_uuid=? AND (status='creating' OR operation_token IS NOT NULL))`, target, target).Scan(&pending)
	if err != nil {
		return out, err
	}
	if pending {
		out.Reason = "pending_work"
		return out, nil
	}
	if !hasPassword {
		out.Reason = "credentials_unavailable"
		return out, nil
	}
	if !out.Active && expires.Valid {
		deadline, e := time.Parse(time.RFC3339Nano, expires.String)
		if e != nil || !deadline.After(time.Now()) {
			out.Reason = "expired"
			return out, nil
		}
	}
	out.CanActivate = !out.Active
	out.CanDeactivate = out.Active
	return out, nil
}

func (a *App) humanActivation(w http.ResponseWriter, r *http.Request) {
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
		out, err := readHumanActivation(r.Context(), tx, actor.UUID, bearer(r), r.PathValue("user"))
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
		Actor              string `json:"expected_actor_uuid"`
		Target             string `json:"expected_user_uuid"`
		ActivationRevision string `json:"activation_revision"`
		ProfileRevision    string `json:"profile_revision"`
		RoleRevision       string `json:"role_revision"`
		Expected           *bool  `json:"expected_is_active"`
		Active             *bool  `json:"is_active"`
		Revoke             bool   `json:"acknowledge_revoke_sessions"`
		LocalOnly          bool   `json:"acknowledge_local_only"`
	}
	if !decodeStrictBody(w, r, &input) {
		return
	}
	if input.Expected == nil || input.Active == nil || !input.Revoke || !input.LocalOnly {
		fail(w, 400, "INVALID_ACTIVATION", "Provide explicit current/new state and acknowledge local-only changes and signing out all MUM sessions")
		return
	}
	var out humanActivationRecord
	err := a.store.write(r.Context(), func(tx *sql.Tx) error {
		current, err := readHumanActivation(r.Context(), tx, actor.UUID, bearer(r), r.PathValue("user"))
		if err != nil {
			return err
		}
		if input.Actor != actor.UUID {
			return ErrForbidden
		}
		if input.Target != current.Target || input.ActivationRevision != current.ActivationRevision || input.ProfileRevision != current.ProfileRevision || input.RoleRevision != current.RoleRevision || *input.Expected != current.Active || *input.Active == current.Active {
			return ErrConflict
		}
		if !current.CanActivate && *input.Active || !current.CanDeactivate && !*input.Active {
			if current.Reason == "protected_owner" || current.Reason == "protected_self" {
				return ErrForbidden
			}
			return ErrConflict
		}
		now := utcTimestamp(time.Now())
		if _, err = tx.ExecContext(r.Context(), "UPDATE user_accounts SET is_active=?,profile_revision=profile_revision+1,updated_at=? WHERE uuid=?", *input.Active, now, current.Target); err != nil {
			return err
		}
		if err = revokeHumanSignIn(r.Context(), tx, current.Target, now); err != nil {
			return err
		}
		if _, err = tx.ExecContext(r.Context(), `INSERT INTO audit_events(actor_uuid,action,details,occurred_at) VALUES(?,'account.activation.change',json_object('target_uuid',?,'before',json(?),'after',json(?),'sessions_revoked',json('true')),?)`, actor.UUID, current.Target, strconv.FormatBool(current.Active), strconv.FormatBool(*input.Active), now); err != nil {
			return err
		}
		out, err = readHumanActivation(r.Context(), tx, actor.UUID, bearer(r), current.Target)
		out.SessionsRevoked = true
		return err
	})
	if err != nil {
		domainError(w, err)
		return
	}
	// Closing sockets is deliberately outside SQLite's writer transaction.
	a.hub.closeAccountConnections(out.Target)
	respond(w, 200, out)
}

// Both activation and expiry changes invalidate dormant sessions/proofs, so
// extending access later cannot revive an earlier sign-in or authorization.
func revokeHumanSignIn(ctx context.Context, tx *sql.Tx, target, now string) error {
	if _, err := tx.ExecContext(ctx, "DELETE FROM app_sessions WHERE user_uuid=?", target); err != nil {
		return err
	}
	_, err := tx.ExecContext(ctx, `UPDATE plex_authorizations SET status='failed',secret=NULL,operation_token=NULL,operation_expires_at=NULL,revision=revision+1,updated_at=? WHERE owner_uuid=? AND status IN ('creating','pending','verified')`, now, target)
	return err
}
