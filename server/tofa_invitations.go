package main

import (
	"context"
	"database/sql"
	"errors"
	"net/mail"
	"strings"
	"time"

	"app/server/providers/tofa"
)

var errTofaEmailRequired = errors.New("valid email address required for Tofa invitations")

type tofaInviteReceipt struct {
	State          string `json:"state"`
	RemoteInviteID string `json:"remote_invite_id,omitempty"`
	RequiresReview bool   `json:"requires_review"`
}

func validTofaInviteEmail(email string) bool {
	if email == "" || len(email) > 320 || email != strings.TrimSpace(email) {
		return false
	}
	address, err := mail.ParseAddress(email)
	return err == nil && address.Address == email
}

func validTofaInviteState(state string) bool {
	switch state {
	case "queued", "waiting", "invited", "joined", "failed", "revoked":
		return true
	default:
		return false
	}
}

// beginTofaInvitation records send intent and a unique idempotency key before
// contacting Tofa, so interrupted or duplicate requests never create a second
// remote invitation.
func (a *App) beginTofaInvitation(ctx context.Context, jobID string, inviteID int64, s ManagedServer, email string) (string, error) {
	if s.Type != "tofa" || !validTofaInviteEmail(email) {
		return "", ErrConflict
	}
	key := newUUID()
	now := utcTimestamp(time.Now())
	fp := providerFingerprint(s)
	err := a.store.write(ctx, func(tx *sql.Tx) error {
		if err := provisionStillAllowed(ctx, tx, inviteID, s); err != nil {
			return err
		}
		var eligible bool
		if err := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM provisioning_jobs j JOIN provisioning_steps s ON s.job_id=j.id WHERE j.id=? AND j.invite_id=? AND j.status='running' AND s.server_id=? AND s.status IN ('pending','running') AND NOT EXISTS(SELECT 1 FROM tofa_invitation_receipts r WHERE r.job_id=j.id AND r.server_id=s.server_id))`, jobID, inviteID, s.ID).Scan(&eligible); err != nil {
			return err
		}
		if !eligible {
			return ErrConflict
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO tofa_invitation_receipts(job_id,server_id,idempotency_key,recipient_email,provider_fingerprint,state,revision,created_at,updated_at) VALUES(?,?,?,?,?,'submitting',1,?,?)`, jobID, s.ID, key, email, fp, now, now); err != nil {
			return err
		}
		result, err := tx.ExecContext(ctx, `UPDATE provisioning_steps SET stage='tofa_invite_submitting',status='running' WHERE job_id=? AND server_id=? AND status IN ('pending','running')`, jobID, s.ID)
		if err != nil {
			return err
		}
		if count, _ := result.RowsAffected(); count != 1 {
			return ErrConflict
		}
		return nil
	})
	if err != nil {
		return "", err
	}
	return key, nil
}

// recordTofaInvitation persists the remote invitation ID and state separately
// from provisioning_steps.remote_id (which is reserved for service user IDs).
// Like provisionCheckpoint, it persists a returned ID even if revocation raced
// the request, then returns ErrConflict.
func (a *App) recordTofaInvitation(requestCtx context.Context, jobID string, inviteID int64, s ManagedServer, remote tofa.OnboardingInvite) error {
	if s.Type != "tofa" || !validProvisionedID(remote.ID) || !validTofaInviteState(remote.State) {
		return ErrConflict
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	now := utcTimestamp(time.Now())
	fp := providerFingerprint(s)
	var validation error
	err := a.store.write(ctx, func(tx *sql.Tx) error {
		result, err := tx.ExecContext(ctx, `UPDATE tofa_invitation_receipts SET remote_invite_id=?,state=?,revision=revision+1,updated_at=? WHERE job_id=? AND server_id=? AND provider_fingerprint=?`, remote.ID, remote.State, now, jobID, s.ID, fp)
		if err != nil {
			return err
		}
		if count, _ := result.RowsAffected(); count != 1 {
			return ErrConflict
		}
		stage := "tofa_invite_" + remote.State
		if _, err := tx.ExecContext(ctx, `UPDATE provisioning_steps SET stage=?,status='running' WHERE job_id=? AND server_id=? AND status IN ('pending','running') AND EXISTS(SELECT 1 FROM provisioning_jobs WHERE id=? AND status='running')`, stage, jobID, s.ID, jobID); err != nil {
			return err
		}
		validation = provisionStillAllowed(ctx, tx, inviteID, s)
		return nil
	})
	if err != nil {
		return err
	}
	if requestCtx.Err() != nil {
		return requestCtx.Err()
	}
	return validation
}

func (a *App) commitTofaInvitationStep(ctx context.Context, jobID string, inviteID int64, s ManagedServer) error {
	return a.store.write(ctx, func(tx *sql.Tx) error {
		if err := provisionStillAllowed(ctx, tx, inviteID, s); err != nil {
			return err
		}
		var ok bool
		if err := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM tofa_invitation_receipts WHERE job_id=? AND server_id=? AND remote_invite_id IS NOT NULL AND state IN ('queued','waiting','invited','joined'))`, jobID, s.ID).Scan(&ok); err != nil {
			return err
		}
		if !ok {
			return ErrConflict
		}
		result, err := tx.ExecContext(ctx, `UPDATE provisioning_steps SET status='completed',stage='completed' WHERE job_id=? AND server_id=? AND status='running'`, jobID, s.ID)
		if err != nil {
			return err
		}
		if count, _ := result.RowsAffected(); count != 1 {
			return ErrConflict
		}
		return nil
	})
}

func (a *App) sendTofaInvitation(ctx context.Context, jobID string, inviteID int64, s ManagedServer, email string, grant InvitationGrant) error {
	key, err := a.beginTofaInvitation(ctx, jobID, inviteID, s, email)
	if err != nil {
		return err
	}
	conn, err := newServerConnection(ProviderConfig{s.Type, s.URL, s.apiKey}, a.ProviderHTTP)
	if err != nil {
		return err
	}
	m, ok := conn.module().(*tofa.Server)
	if !ok {
		return errors.New("unsupported Tofa provider")
	}
	remote, err := m.CreateOnboardingInvite(ctx, key, email, grant.AllLibraries, grant.LibraryIDs)
	if err != nil {
		return err
	}
	if err := a.recordTofaInvitation(ctx, jobID, inviteID, s, remote); err != nil {
		return err
	}
	if remote.State == "failed" || remote.State == "revoked" {
		return errors.New("tofa invitation " + remote.State)
	}
	return a.commitTofaInvitationStep(ctx, jobID, inviteID, s)
}

func readTofaReceiptsForJob(ctx context.Context, tx *sql.Tx, jobID string) (map[int64]tofaInviteReceipt, error) {
	rows, err := tx.QueryContext(ctx, `SELECT server_id,state,coalesce(remote_invite_id,'') FROM tofa_invitation_receipts WHERE job_id=?`, jobID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	receipts := map[int64]tofaInviteReceipt{}
	for rows.Next() {
		var serverID int64
		var r tofaInviteReceipt
		if err := rows.Scan(&serverID, &r.State, &r.RemoteInviteID); err != nil {
			return nil, err
		}
		r.RequiresReview = r.State == "submitting" || r.State == "unknown" || r.State == "failed"
		receipts[serverID] = r
	}
	return receipts, rows.Err()
}

func (a *App) updateTofaReceiptState(ctx context.Context, actor, jobID, token string, target *reviewTarget, state string) error {
	return a.store.write(ctx, func(tx *sql.Tx) error {
		if err := reviewPermission(ctx, tx, actor, jobID, token); err != nil {
			return err
		}
		_, err := tx.ExecContext(ctx, `UPDATE tofa_invitation_receipts SET state=?,revision=revision+1,updated_at=? WHERE job_id=? AND server_id=? AND provider_fingerprint=?`, state, utcTimestamp(time.Now()), jobID, target.Server.ID, target.Fingerprint)
		return err
	})
}
