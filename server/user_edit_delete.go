package main

import (
	"database/sql"
	"errors"
	"net/http"
)

// Users list edit changes go through prepared edit operations
// (edit_operations.go, BULK_MANAGEMENT_DESIGN.md); the direct endpoint below
// only refuses. The helpers here are the database part of deletion:
//
// Deleting a local account retires it: it cannot sign in, its sessions end,
// it is unlinked from its service accounts, loses its visual roles, is hidden
// from the Users list and its username is freed. The row stays because
// provisioning jobs, audit events and activity history refer to it.
// editDeleteService removes a service account from MUM together with its play
// history and links; the edit coordinator calls it only after the remote
// access was verified removed.

type editUserResult struct {
	UUID    string `json:"uuid"`
	Outcome string `json:"outcome"` // deleted or skipped
	Reason  string `json:"reason"`  // why a selection was skipped
	local   bool
}

func (a *App) editUsers(w http.ResponseWriter, r *http.Request) {
	actor, ok := a.principal(w, r, true)
	if !ok {
		return
	}
	err := a.store.write(r.Context(), func(tx *sql.Tx) error { return editAuthorityTx(r.Context(), tx, actor.UUID, bearer(r)) })
	if err != nil {
		domainError(w, err)
		return
	}
	fail(w, 400, "PREPARED_EDIT_REQUIRED", "Prepare and confirm a current edit operation before changing users")
}

func editDeleteOne(r *http.Request, tx *sql.Tx, actor, id, now string) (editUserResult, error) {
	ctx := r.Context()
	skip := func(reason string) (editUserResult, error) {
		return editUserResult{UUID: id, Outcome: "skipped", Reason: reason}, nil
	}
	var kind string
	err := tx.QueryRowContext(ctx, "SELECT kind FROM identities WHERE uuid=?", id).Scan(&kind)
	if errors.Is(err, sql.ErrNoRows) {
		return skip("not_found")
	}
	if err != nil {
		return editUserResult{}, err
	}
	if kind == "service" {
		return editDeleteService(r, tx, actor, id)
	}
	var accountKind string
	var deleted, admin, running, plexConnected bool
	// Only a job that is executing right now (seconds) holds up a delete;
	// failed jobs awaiting review are closed below.
	err = tx.QueryRowContext(ctx, `SELECT u.kind,u.deleted_at IS NOT NULL,
	 EXISTS(SELECT 1 FROM admin_privileges WHERE user_uuid=u.uuid),
	 EXISTS(SELECT 1 FROM provisioning_jobs WHERE user_uuid=u.uuid AND resolution IS NULL AND (status IN ('pending','running') OR review_token IS NOT NULL)),
	 EXISTS(SELECT 1 FROM plex_connections WHERE owner_uuid=u.uuid AND status='active')
	 FROM user_accounts u WHERE u.uuid=?`, id).Scan(&accountKind, &deleted, &admin, &running, &plexConnected)
	if errors.Is(err, sql.ErrNoRows) {
		return skip("not_found")
	}
	if err != nil {
		return editUserResult{}, err
	}
	switch {
	case accountKind == "owner":
		return skip("protected_owner")
	case id == actor:
		return skip("protected_self")
	case deleted:
		return skip("already_deleted")
	case admin:
		// Administrators are changed through role management, never through Edit.
		return skip("administrator")
	case running:
		// An invitation is being processed this moment; its result would be
		// written to the account. It finishes within seconds.
		return skip("invite_in_progress")
	case plexConnected:
		return skip("plex_connection")
	}
	if _, err := tx.ExecContext(ctx, `UPDATE user_accounts SET deleted_at=?,deleted_username=local_username,local_username=NULL,email=NULL,password_hash=NULL,
	 discord_user_id=NULL,discord_access_token=NULL,discord_refresh_token=NULL,is_active=0,profile_revision=profile_revision+1,updated_at=? WHERE uuid=? AND deleted_at IS NULL`, now, now, id); err != nil {
		return editUserResult{}, err
	}
	// Failed invitation jobs for this account are closed as cancelled so they
	// no longer hold the username or the invite's capacity, and can no longer
	// be resumed into the deleted account.
	if _, err := tx.ExecContext(ctx, `UPDATE provisioning_jobs SET resolution='cancelled',reservation_held=0,error_code=coalesce(error_code,'CANCELLED'),revision=revision+1,updated_at=? WHERE user_uuid=? AND status='failed' AND resolution IS NULL`, now, id); err != nil {
		return editUserResult{}, err
	}
	if err := revokeHumanSignIn(ctx, tx, id, now); err != nil {
		return editUserResult{}, err
	}
	for _, statement := range []string{"DELETE FROM service_links WHERE user_uuid=?", "DELETE FROM identity_user_roles WHERE user_uuid=?"} {
		if _, err := tx.ExecContext(ctx, statement, id); err != nil {
			return editUserResult{}, err
		}
	}
	if err := auditAction(ctx, tx, actor, "account.delete"); err != nil {
		return editUserResult{}, err
	}
	return editUserResult{UUID: id, Outcome: "deleted", local: true}, nil
}

// editDeleteService removes a service account, its play history (including a
// session playing right now; the monitor no longer maps it) and its links
// (user decision 2026-11-07: deleting takes priority).
func editDeleteService(r *http.Request, tx *sql.Tx, actor, id string) (editUserResult, error) {
	ctx := r.Context()
	for _, statement := range []string{
		"DELETE FROM media_activity_current WHERE history_id IN (SELECT id FROM media_activity_history WHERE service_uuid=?)",
		"DELETE FROM plex_job_completions WHERE service_uuid=?",
		"DELETE FROM media_activity_history WHERE service_uuid=?",
		"DELETE FROM service_links WHERE service_uuid=?",
		"DELETE FROM service_accounts WHERE uuid=?",
		"DELETE FROM identities WHERE uuid=? AND kind='service'",
	} {
		if _, err := tx.ExecContext(ctx, statement, id); err != nil {
			return editUserResult{}, err
		}
	}
	if err := auditAction(ctx, tx, actor, "service_account.delete"); err != nil {
		return editUserResult{}, err
	}
	return editUserResult{UUID: id, Outcome: "deleted"}, nil
}
