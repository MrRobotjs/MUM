package main

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"database/sql"
	"encoding/json"
	"time"
)

type preparedPlexCompletion struct {
	job, user, account, username, connection, service string
	server, revision, invite, credentialRevision      int64
	original, ciphertext                              []byte
	accountChecked                                    string
}

// Key-file I/O, authenticated cloud account reads and credential rewrap are
// outside the writer. The final transaction independently rechecks all gates.
func (a *App) preparePlexCompletion(ctx context.Context, job string, server, revision int64) (preparedPlexCompletion, error) {
	return a.preparePlexCompletionAs(ctx, job, server, revision, nil)
}
func (a *App) preparePlexCompletionAs(ctx context.Context, job string, server, revision int64, admin *plexJobAdministrator) (preparedPlexCompletion, error) {
	p := preparedPlexCompletion{job: job, server: server, revision: revision, connection: newUUID(), service: newUUID()}
	var purpose string
	err := a.store.write(ctx, func(tx *sql.Tx) error {
		if err := requirePlexJobAdministrator(ctx, tx, admin, job); err != nil {
			return err
		}

		if err := validatePlexCompletionEvidence(ctx, tx, job, server, revision); err != nil {
			return err
		}
		var proofID, digest string
		if err := tx.QueryRowContext(ctx, `SELECT j.user_uuid,j.invite_id,c.account_id,c.secret,c.revision,c.proof_id,r.invite_digest FROM provisioning_jobs j JOIN plex_invitation_credentials c ON c.job_id=j.id JOIN plex_invitation_authorizations r ON r.id=c.proof_id WHERE j.id=?`, job).Scan(&p.user, &p.invite, &p.account, &p.original, &p.credentialRevision, &proofID, &digest); err != nil {
			return err
		}
		proof, err := scanPlexInvitationAuthorization(tx.QueryRowContext(ctx, plexInvitationSelect, proofID, digest))
		if err != nil {
			return err
		}
		purpose = plexInvitationJobPurpose(job, p.user, p.account, proof)
		return nil
	})
	if err != nil {
		return p, err
	}
	secret, err := a.store.openPlexCredential(ctx, purpose, p.original)
	if err != nil {
		return p, err
	}
	if secret.AccountID != p.account || !secret.Expires.After(time.Now()) || !plexJWTShape(secret.Token) {
		return p, errPlexAuthentication
	}
	device, err := newPlexDeviceAuth(a.ProviderHTTP)
	if err != nil {
		return p, err
	}
	device.clientID = secret.ClientID
	device.keyID = secret.KeyID
	device.privateKey = ed25519.PrivateKey(secret.PrivateKey)
	result, err := device.verifyAccount(ctx, secret.Token, p.account)
	if err != nil {
		return p, err
	}
	p.username = result.Account.Username
	p.accountChecked = utcTimestamp(time.Now())
	secret.PINID = 0
	secret.PINCode = ""
	p.ciphertext, err = a.store.sealPlexCredential(ctx, plexConnectionPurpose(p.connection, p.user, p.account), secret)
	return p, err
}
func commitPlexCompletion(ctx context.Context, tx *sql.Tx, p preparedPlexCompletion) error {
	return commitPlexCompletionAs(ctx, tx, p, nil)
}
func commitPlexCompletionAs(ctx context.Context, tx *sql.Tx, p preparedPlexCompletion, admin *plexJobAdministrator) error {
	if err := requirePlexJobAdministrator(ctx, tx, admin, p.job); err != nil {
		return err
	}
	if !validProvisionedID(p.user) || !validProvisionedID(p.connection) || !validProvisionedID(p.service) || !plexNumericID(p.account) || p.username == "" || len(p.username) > 255 || len(p.ciphertext) == 0 {
		return ErrConflict
	}
	if err := validatePlexCompletionEvidence(ctx, tx, p.job, p.server, p.revision); err != nil {
		return err
	}
	var user, account string
	var invite, credentialRevision, jobRevision int64
	var original []byte
	if err := tx.QueryRowContext(ctx, `SELECT j.user_uuid,j.invite_id,j.revision,c.account_id,c.secret,c.revision FROM provisioning_jobs j JOIN plex_invitation_credentials c ON c.job_id=j.id WHERE j.id=?`, p.job).Scan(&user, &invite, &jobRevision, &account, &original, &credentialRevision); err != nil {
		return err
	}
	if user != p.user || invite != p.invite || account != p.account || credentialRevision != p.credentialRevision || !bytes.Equal(original, p.original) {
		return ErrConflict
	}
	checkpoint, err := loadPlexShareCheckpoint(ctx, tx, p.job, p.server)
	if err != nil {
		return err
	}
	ids, err := json.Marshal(checkpoint.grant.LibraryIDs)
	if err != nil {
		return err
	}
	settings, err := json.Marshal(map[string]any{"all_libraries": false, "library_policy_known": true, "download_policy_known": true, "download_policy_scope": "owner_allowSync", "verification_scope": plexLibraryVerificationScope})
	if err != nil {
		return err
	}
	now := utcTimestamp(time.Now())
	if _, err := tx.ExecContext(ctx, "INSERT INTO identities(uuid,kind) VALUES(?,'service')", p.service); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO service_accounts(uuid,server_id,external_user_id,external_username,allowed_library_ids,allow_downloads,service_settings,is_active,used_invite_id,created_at,updated_at) VALUES(?,?,?,?,?,0,?,1,?,?,?)`, p.service, p.server, p.account, p.username, string(ids), string(settings), p.invite, now, now); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, "INSERT INTO service_links(user_uuid,service_uuid,link_kind,created_at) VALUES(?,?,'owner',?)", p.user, p.service, now); err != nil {
		return err
	}
	result, err := tx.ExecContext(ctx, `UPDATE plex_invitation_credentials SET status='released',secret=NULL,refresh_token=NULL,refresh_expires_at=NULL,revision=revision+1 WHERE job_id=? AND status='active' AND revision=?`, p.job, p.credentialRevision)
	if err != nil {
		return err
	}
	if n, _ := result.RowsAffected(); n != 1 {
		return ErrConflict
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO plex_connections(id,owner_uuid,account_id,username,secret,status,created_at,verified_at) VALUES(?,?,?,?,?,'active',?,?)`, p.connection, p.user, p.account, p.username, p.ciphertext, now, p.accountChecked); err != nil {
		return err
	}
	result, err = tx.ExecContext(ctx, `UPDATE provisioning_steps SET status='completed',stage='completed',remote_id=?,remote_username=?,error_code=NULL WHERE job_id=? AND server_id=? AND status='pending' AND stage='pending' AND coalesce(remote_id,'')=''`, p.account, p.username, p.job, p.server)
	if err != nil {
		return err
	}
	if n, _ := result.RowsAffected(); n != 1 {
		return ErrConflict
	}
	result, err = tx.ExecContext(ctx, `UPDATE provisioning_jobs SET status='completed',reservation_held=0,error_code=NULL,revision=revision+1,updated_at=? WHERE id=? AND user_uuid=? AND invite_id=? AND status='running' AND reservation_held=1 AND resolution IS NULL AND review_token IS NULL`, now, p.job, p.user, p.invite)
	if err != nil {
		return err
	}
	if n, _ := result.RowsAffected(); n != 1 {
		return ErrConflict
	}
	result, err = tx.ExecContext(ctx, `UPDATE invites SET current_uses=current_uses+1,updated_at=? WHERE id=? AND is_active=1 AND archived_at IS NULL AND (expires_at IS NULL OR julianday(expires_at)>julianday('now')) AND (max_uses IS NULL OR current_uses<max_uses)`, now, p.invite)
	if err != nil {
		return err
	}
	if n, _ := result.RowsAffected(); n != 1 {
		return ErrConflict
	}
	result, err = tx.ExecContext(ctx, `UPDATE user_accounts SET is_active=1,updated_at=? WHERE uuid=? AND kind='local' AND is_active=0 AND used_invite_id=? AND password_hash IS NOT NULL AND NOT EXISTS(SELECT 1 FROM admin_privileges WHERE user_uuid=?)`, now, p.user, p.invite, p.user)
	if err != nil {
		return err
	}
	if n, _ := result.RowsAffected(); n != 1 {
		return ErrConflict
	}
	result, err = tx.ExecContext(ctx, `INSERT INTO plex_job_completions(job_id,server_id,user_uuid,service_uuid,connection_id,job_revision,checkpoint_revision,verification_scope,verified_at,completed_at) SELECT ?,?,?,?,?,?,?,scope,verified_at,? FROM plex_library_verifications WHERE job_id=? AND server_id=? AND julianday(valid_until)>julianday('now')`, p.job, p.server, p.user, p.service, p.connection, jobRevision+1, p.revision, now, p.job, p.server)
	if err != nil {
		return err
	}
	if n, _ := result.RowsAffected(); n != 1 {
		return ErrConflict
	}
	if _, err := tx.ExecContext(ctx, "UPDATE media_servers SET revision=revision+1 WHERE id=?", p.server); err != nil {
		return err
	}
	if err := auditPlexJobAdministrator(ctx, tx, admin, p.job, "plex.admin.finalize.completed"); err != nil {
		return err
	}
	return auditAction(ctx, tx, "", "plex.invitation.complete.verified_libraries")
}

// Private, explicit local finalization; no remote share write or startup replay.
func (a *App) completeVerifiedPlexJob(ctx context.Context, job string, server, revision int64) error {
	return a.completeVerifiedPlexJobAs(ctx, job, server, revision, nil)
}
func (a *App) completeVerifiedPlexJobAs(ctx context.Context, job string, server, revision int64, admin *plexJobAdministrator) error {
	a.provisionMu.Lock()
	if a.provisionClosing {
		a.provisionMu.Unlock()
		return ErrConflict
	}
	a.provisionWG.Add(1)
	a.provisionMu.Unlock()
	defer a.provisionWG.Done()
	select {
	case a.provisionSlots <- struct{}{}:
		defer func() { <-a.provisionSlots }()
	default:
		return ErrConflict
	}
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	stop := context.AfterFunc(a.provisionCtx, cancel)
	defer stop()
	p, err := a.preparePlexCompletionAs(ctx, job, server, revision, admin)
	if err != nil {
		return err
	}
	return a.store.write(ctx, func(tx *sql.Tx) error { return commitPlexCompletionAs(ctx, tx, p, admin) })
}
