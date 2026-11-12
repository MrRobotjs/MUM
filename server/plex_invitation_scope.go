package main

import (
	"app/server/providers/plex"
	"context"
	"database/sql"
	"encoding/json"
	"slices"
	"strconv"
	"time"
)

type plexInvitationGrantSnapshot struct {
	Grant                 InvitationGrant
	ServerRevision        int64
	Provider, Fingerprint string
}
type plexInvitationScope struct {
	ID, Revision                 int64
	Digest, Fingerprint, Expires string
	Grants                       []plexInvitationGrantSnapshot
}

func canonicalPlexInvitationGrant(g InvitationGrant) string {
	g.LibraryIDs = slices.Clone(g.LibraryIDs)
	slices.Sort(g.LibraryIDs)
	data, _ := json.Marshal(g)
	return string(data)
}

// This auth-only scope is not a provisioning capability. It deliberately needs
// an existing Plex grant; normal admin creation still rejects such invitations
// until pending sharing/acceptance is implemented.
func loadPlexInvitationScope(ctx context.Context, tx *sql.Tx, digest string, revision int64, heldJob string) (plexInvitationScope, error) {
	scope := plexInvitationScope{Digest: digest, Revision: revision}
	var valid bool
	err := tx.QueryRowContext(ctx, `SELECT i.id,i.revision,coalesce(i.expires_at,''),i.is_active=1 AND i.archived_at IS NULL AND (i.expires_at IS NULL OR julianday(i.expires_at)>julianday('now')) AND i.current_uses+(SELECT count(*) FROM provisioning_jobs j WHERE j.invite_id=i.id AND j.reservation_held=1 AND j.id!=?)<coalesce(i.max_uses,9223372036854775807) FROM invites i WHERE i.token=?`, heldJob, digest).Scan(&scope.ID, &scope.Revision, &scope.Expires, &valid)
	if err != nil {
		return scope, ErrForbidden
	}
	if !valid || scope.Revision != revision {
		return scope, ErrConflict
	}
	grants, err := loadInvitationGrants(ctx, tx, scope.ID)
	if err != nil {
		return scope, err
	}
	if len(grants) == 0 || len(grants) > 20 {
		return scope, ErrConflict
	}
	hasPlex := false
	for _, grant := range grants {
		server, err := scanServer(tx.QueryRowContext(ctx, serverSelect+" WHERE s.id=?", grant.ServerID))
		if err != nil {
			return scope, err
		}
		if !server.EffectiveActive {
			return scope, ErrConflict
		}
		if server.Type != "plex" {
			if _, err := validateInvitationGrant(ctx, tx, grant); err != nil {
				return scope, err
			}
		} else {
			hasPlex = true
			if len(grant.LibraryIDs) > 10000 || grant.AllLibraries && len(grant.LibraryIDs) != 0 || !grant.AllLibraries && len(grant.LibraryIDs) == 0 {
				return scope, ErrConflict
			}
			seen := map[string]bool{}
			for _, id := range grant.LibraryIDs {
				if id == "" || len(id) > 255 || seen[id] {
					return scope, ErrConflict
				}
				seen[id] = true
				var present bool
				if err := tx.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM media_libraries WHERE server_id=? AND external_id=? AND is_available=1)", server.ID, id).Scan(&present); err != nil {
					return scope, err
				}
				if !present {
					return scope, ErrConflict
				}
			}
		}
		grant.LibraryIDs = slices.Clone(grant.LibraryIDs)
		slices.Sort(grant.LibraryIDs)
		scope.Grants = append(scope.Grants, plexInvitationGrantSnapshot{grant, server.Revision, server.Type, providerFingerprint(server)})
	}
	if !hasPlex {
		return scope, ErrConflict
	}
	data, _ := json.Marshal(scope.Grants)
	scope.Fingerprint = tokenHash(string(data))
	return scope, nil
}

type plexInvitationAuthorization struct {
	plexAuthorization
	InviteID, InviteRevision int64
	Digest, Fingerprint      string
}

const plexInvitationSelect = `SELECT id,invite_id,invite_revision,invite_digest,grant_fingerprint,browser_hash,status,expires_at,poll_after,coalesce(account_id,''),coalesce(username,''),coalesce(operation_token,''),revision,secret FROM plex_invitation_authorizations WHERE id=? AND invite_digest=?`

func scanPlexInvitationAuthorization(row *sql.Row) (plexInvitationAuthorization, error) {
	var p plexInvitationAuthorization
	err := row.Scan(&p.ID, &p.InviteID, &p.InviteRevision, &p.Digest, &p.Fingerprint, &p.Browser, &p.Status, &p.Expires, &p.PollAfter, &p.AccountID, &p.Username, &p.Operation, &p.Revision, &p.Secret)
	if err == sql.ErrNoRows {
		err = ErrForbidden
	}
	return p, err
}
func plexInvitationPurpose(p plexInvitationAuthorization) string {
	return "invitation-authorization:" + p.ID + ":" + strconv.FormatInt(p.InviteID, 10) + ":" + p.Digest + ":" + strconv.FormatInt(p.InviteRevision, 10) + ":" + p.Fingerprint + ":" + p.Browser
}
func plexInvitationJobPurpose(job, user, account string, p plexInvitationAuthorization) string {
	return "invitation-job:" + job + ":" + user + ":" + account + ":" + p.Digest + ":" + p.Fingerprint
}
func verifyPlexInvitationScope(ctx context.Context, tx *sql.Tx, p plexInvitationAuthorization, heldJob string) error {
	scope, err := loadPlexInvitationScope(ctx, tx, p.Digest, p.InviteRevision, heldJob)
	if err != nil {
		return err
	}
	if scope.ID != p.InviteID || scope.Fingerprint != p.Fingerprint {
		return ErrConflict
	}
	return nil
}

// Preparation decrypts and rewraps outside the writer. The actual single-use
// consumption runs in the caller's reservation/profile transaction.
type preparedPlexInvitationProof struct {
	row        plexInvitationAuthorization
	job, user  string
	ciphertext []byte
}

func (a *App) preparePlexInvitationProof(ctx context.Context, token, id, browser, job, user string) (preparedPlexInvitationProof, error) {
	var prepared preparedPlexInvitationProof
	if len(token) != 43 || len(browser) != 43 || !validProvisionedID(id) || !validProvisionedID(job) || !validProvisionedID(user) {
		return prepared, ErrForbidden
	}
	err := a.store.write(ctx, func(tx *sql.Tx) error {
		var err error
		prepared.row, err = scanPlexInvitationAuthorization(tx.QueryRowContext(ctx, plexInvitationSelect, id, tokenHash(token)))
		if err != nil {
			return err
		}
		if prepared.row.Status != "confirmed" || !plexAuthorizationBound(prepared.row.plexAuthorization, browser) {
			return ErrForbidden
		}
		return verifyPlexInvitationScope(ctx, tx, prepared.row, "")
	})
	if err != nil {
		return prepared, err
	}
	secret, err := a.store.openPlexCredential(ctx, plexInvitationPurpose(prepared.row), prepared.row.Secret)
	if err != nil {
		return prepared, err
	}
	if !secret.Expires.After(time.Now()) || secret.AccountID != prepared.row.AccountID || !plex.JWTShape(secret.Token) {
		return prepared, errPlexAuthentication
	}
	prepared.job = job
	prepared.user = user
	prepared.ciphertext, err = a.store.sealPlexCredential(ctx, plexInvitationJobPurpose(job, user, secret.AccountID, prepared.row), secret)
	return prepared, err
}
func consumePlexInvitationProof(ctx context.Context, tx *sql.Tx, p preparedPlexInvitationProof) error {
	if p.job == "" || p.user == "" || len(p.ciphertext) == 0 || p.row.Expires <= utcTimestamp(time.Now()) {
		return ErrConflict
	}
	var eligible bool
	if err := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM provisioning_jobs j JOIN user_accounts u ON u.uuid=j.user_uuid WHERE j.id=? AND j.user_uuid=? AND j.invite_id=? AND j.status='running' AND j.reservation_held=1 AND u.kind='local' AND u.is_active=0 AND u.used_invite_id=j.invite_id AND u.password_hash IS NOT NULL AND NOT EXISTS(SELECT 1 FROM admin_privileges WHERE user_uuid=u.uuid))`, p.job, p.user, p.row.InviteID).Scan(&eligible); err != nil {
		return err
	}
	if !eligible {
		return ErrConflict
	}
	if err := verifyPlexInvitationScope(ctx, tx, p.row, p.job); err != nil {
		return err
	}
	scope, err := loadPlexInvitationScope(ctx, tx, p.row.Digest, p.row.InviteRevision, p.job)
	if err != nil {
		return err
	}
	var steps int
	if err := tx.QueryRowContext(ctx, "SELECT count(*) FROM provisioning_steps WHERE job_id=?", p.job).Scan(&steps); err != nil {
		return err
	}
	if steps != len(scope.Grants) {
		return ErrConflict
	}
	for _, snapshot := range scope.Grants {
		var encoded, status, stage, fingerprint string
		var revision int64
		if err := tx.QueryRowContext(ctx, "SELECT coalesce(grant_snapshot,''),status,stage,coalesce(server_revision,0),coalesce(provider_fingerprint,'') FROM provisioning_steps WHERE job_id=? AND server_id=?", p.job, snapshot.Grant.ServerID).Scan(&encoded, &status, &stage, &revision, &fingerprint); err != nil {
			return err
		}
		var grant InvitationGrant
		if json.Unmarshal([]byte(encoded), &grant) != nil || canonicalPlexInvitationGrant(grant) != canonicalPlexInvitationGrant(snapshot.Grant) || status != "pending" || stage != "pending" || revision != snapshot.ServerRevision || fingerprint != snapshot.Fingerprint {
			return ErrConflict
		}
	}
	var owned bool
	if err := tx.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM plex_connections WHERE status='active' AND (account_id=? OR owner_uuid=?)) OR EXISTS(SELECT 1 FROM plex_invitation_credentials WHERE status='active' AND account_id=?)", p.row.AccountID, p.user, p.row.AccountID).Scan(&owned); err != nil {
		return err
	}
	if owned {
		return ErrConflict
	}
	result, err := tx.ExecContext(ctx, `UPDATE plex_invitation_authorizations SET status='consumed',secret=NULL,revision=revision+1,updated_at=? WHERE id=? AND invite_digest=? AND browser_hash=? AND revision=? AND status='confirmed' AND expires_at>? AND operation_token IS NULL`, utcTimestamp(time.Now()), p.row.ID, p.row.Digest, p.row.Browser, p.row.Revision, utcTimestamp(time.Now()))
	if err != nil {
		return err
	}
	count, _ := result.RowsAffected()
	if count != 1 {
		return ErrConflict
	}
	if _, err := tx.ExecContext(ctx, "INSERT INTO plex_invitation_credentials(job_id,proof_id,user_uuid,account_id,secret,status,created_at) VALUES(?,?,?,?,?,'active',?)", p.job, p.row.ID, p.user, p.row.AccountID, p.ciphertext, utcTimestamp(time.Now())); err != nil {
		return err
	}
	for _, snapshot := range scope.Grants {
		if snapshot.Provider == "plex" {
			if _, err := tx.ExecContext(ctx, "INSERT INTO plex_share_checkpoints(job_id,server_id,updated_at) VALUES(?,?,?)", p.job, snapshot.Grant.ServerID, utcTimestamp(time.Now())); err != nil {
				return err
			}
		}
	}
	return auditAction(ctx, tx, "", "plex.invitation.proof.consume")
}
