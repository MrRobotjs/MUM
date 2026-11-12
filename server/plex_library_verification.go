package main

import (
	"context"
	"database/sql"
	"time"
)

const plexLibraryVerificationScope = "accepted_cloud_and_recipient_library_listing"

// Current authority is checked in the caller's transaction. This gate is not a
// public permit and does not activate a profile or complete a provisioning job.
func plexVerificationAuthority(ctx context.Context, tx *sql.Tx, p *plexShareCheckpoint) (int64, int64, error) {
	if p.grant.AllLibraries || p.grant.AllowDownloads || len(p.grant.LibraryIDs) == 0 {
		return 0, 0, ErrConflict
	}
	if err := plexShareJobEligible(ctx, tx, *p); err != nil {
		return 0, 0, err
	}
	if err := plexShareServerAuthority(ctx, tx, p); err != nil {
		return 0, 0, err
	}
	var jobRevision, credentialRevision int64
	var eligible bool
	err := tx.QueryRowContext(ctx, `SELECT j.revision,c.revision,j.status='running' AND j.review_token IS NULL AND c.refresh_token IS NULL AND (SELECT count(*) FROM provisioning_steps WHERE job_id=j.id)=1 AND NOT EXISTS(SELECT 1 FROM plex_connections WHERE status='active' AND (owner_uuid=j.user_uuid OR account_id=c.account_id)) AND NOT EXISTS(SELECT 1 FROM service_accounts WHERE server_id=? AND external_user_id=c.account_id) AND NOT EXISTS(SELECT 1 FROM service_accounts a JOIN media_servers m ON m.id=a.server_id JOIN service_links l ON l.service_uuid=a.uuid WHERE m.service_type='plex' AND a.external_user_id=c.account_id AND l.user_uuid!=j.user_uuid) FROM provisioning_jobs j JOIN plex_invitation_credentials c ON c.job_id=j.id WHERE j.id=?`, p.Server, p.Job).Scan(&jobRevision, &credentialRevision, &eligible)
	if err != nil {
		return 0, 0, err
	}
	if !eligible {
		return 0, 0, ErrConflict
	}
	var proofID, digest string
	if err := tx.QueryRowContext(ctx, "SELECT c.proof_id,p.invite_digest FROM plex_invitation_credentials c JOIN plex_invitation_authorizations p ON p.id=c.proof_id WHERE c.job_id=?", p.Job).Scan(&proofID, &digest); err != nil {
		return 0, 0, err
	}
	proof, err := scanPlexInvitationAuthorization(tx.QueryRowContext(ctx, plexInvitationSelect, proofID, digest))
	if err != nil {
		return 0, 0, err
	}
	scope, err := loadPlexInvitationScope(ctx, tx, proof.Digest, proof.InviteRevision, p.Job)
	if err != nil {
		return 0, 0, err
	}
	if scope.ID != proof.InviteID || scope.Fingerprint != proof.Fingerprint || len(scope.Grants) != 1 || canonicalPlexInvitationGrant(scope.Grants[0].Grant) != canonicalPlexInvitationGrant(p.grant) {
		return 0, 0, ErrConflict
	}
	return jobRevision, credentialRevision, nil
}
func validatePlexCompletionEvidence(ctx context.Context, tx *sql.Tx, job string, server, revision int64) error {
	p, err := loadPlexShareCheckpoint(ctx, tx, job, server)
	if err != nil {
		return err
	}
	if p.State != "access_observed" || p.Revision != revision || p.token != "" {
		return ErrConflict
	}
	jr, cr, err := plexVerificationAuthority(ctx, tx, &p)
	if err != nil {
		return err
	}
	var checkpointRev, jobRev, credentialRev, serverRev int64
	var fingerprint, grant, scope, verified, until string
	err = tx.QueryRowContext(ctx, `SELECT checkpoint_revision,job_revision,credential_revision,server_revision,provider_fingerprint,grant_digest,scope,verified_at,valid_until FROM plex_library_verifications WHERE job_id=? AND server_id=?`, job, server).Scan(&checkpointRev, &jobRev, &credentialRev, &serverRev, &fingerprint, &grant, &scope, &verified, &until)
	if err != nil {
		return err
	}
	checked, e1 := time.Parse(time.RFC3339Nano, verified)
	expires, e2 := time.Parse(time.RFC3339Nano, until)
	now := time.Now()
	if e1 != nil || e2 != nil || checked.After(now) || !expires.After(now) || expires.After(checked.Add(time.Minute)) || scope != plexLibraryVerificationScope || checkpointRev != revision || jobRev != jr || credentialRev != cr || serverRev != p.serverRevision || fingerprint != p.fingerprint || grant != tokenHash(canonicalPlexInvitationGrant(p.grant)) {
		return ErrConflict
	}
	return nil
}

// Reuses existing fixed-host authentication and exact recipient PMS verification.
// No sharing mutation, auto retry, public route or profile activation is added.
func (a *App) verifyPlexLibraryCompletion(ctx context.Context, job string, server, revision int64) error {
	return a.verifyPlexLibraryCompletionAs(ctx, job, server, revision, nil)
}
func (a *App) verifyPlexLibraryCompletionAs(ctx context.Context, job string, server, revision int64, admin *plexJobAdministrator) error {
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
	err := a.store.write(ctx, func(tx *sql.Tx) error {
		if err := requirePlexJobAdministrator(ctx, tx, admin, job); err != nil {
			return err
		}
		p, err := loadPlexShareCheckpoint(ctx, tx, job, server)
		if err != nil {
			return err
		}
		if p.Revision != revision || p.token != "" || p.State != "access_observed" && p.State != "awaiting_acceptance" {
			return ErrConflict
		}
		_, _, err = plexVerificationAuthority(ctx, tx, &p)
		return err
	})
	if err != nil {
		return err
	}
	claim, err := a.store.claimPlexShareAs(ctx, job, server, revision, "inspect", plexSharePreflight{}, admin)
	if err != nil {
		return err
	}
	secret, err := a.refreshPlexJobCredentialAs(ctx, claim, admin)
	if err != nil {
		return err
	}
	var config ProviderConfig
	var jobRevision, credentialRevision int64
	err = a.store.write(ctx, func(tx *sql.Tx) error {
		if err := requirePlexJobAdministrator(ctx, tx, admin, job); err != nil {
			return err
		}
		current, err := loadPlexShareCheckpoint(ctx, tx, job, server)
		if err != nil {
			return err
		}
		if current.token != claim.token || current.Revision != claim.Revision || current.expires <= utcTimestamp(time.Now()) {
			return ErrConflict
		}
		jobRevision, credentialRevision, err = plexVerificationAuthority(ctx, tx, &current)
		if err != nil {
			return err
		}
		if current.serverRevision != claim.serverRevision {
			return ErrConflict
		}
		managed, err := scanServer(tx.QueryRowContext(ctx, serverSelect+" WHERE s.id=?", server))
		if err != nil {
			return err
		}
		config = ProviderConfig{Type: managed.Type, URL: managed.URL, APIKey: managed.apiKey}
		return nil
	})
	if err != nil {
		return err
	}
	provider, err := newMediaProvider(config, a.ProviderHTTP)
	if err != nil {
		return err
	}
	observation, err := provider.(*jsonProvider).inspectPlexShare(ctx, claim.Account, claim.grant)
	if err != nil {
		return err
	}
	if !plexShareMatches(observation, claim.grant) || observation.ShareID != claim.Share || observation.Machine != claim.Machine || !samePlexSections(observation.Sections, claim.Sections) {
		return ErrConflict
	}
	if err := verifyPlexRecipientLibraries(ctx, a.ProviderHTTP, secret, config.URL, observation, claim.grant); err != nil {
		return err
	}
	checked := time.Now()
	until := checked.Add(time.Minute)
	return a.store.write(ctx, func(tx *sql.Tx) error {
		if err := requirePlexJobAdministrator(ctx, tx, admin, job); err != nil {
			return err
		}
		// Observation and provenance commit together or neither commits.
		if err := recordPlexShareObservationTx(ctx, tx, claim, observation); err != nil {
			return err
		}
		current, err := loadPlexShareCheckpoint(ctx, tx, job, server)
		if err != nil {
			return err
		}
		jr, cr, err := plexVerificationAuthority(ctx, tx, &current)
		if err != nil {
			return err
		}
		if jr != jobRevision || cr != credentialRevision || current.serverRevision != claim.serverRevision {
			return ErrConflict
		}
		_, err = tx.ExecContext(ctx, `INSERT INTO plex_library_verifications(job_id,server_id,checkpoint_revision,job_revision,credential_revision,server_revision,provider_fingerprint,grant_digest,scope,verified_at,valid_until) VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(job_id,server_id) DO UPDATE SET checkpoint_revision=excluded.checkpoint_revision,job_revision=excluded.job_revision,credential_revision=excluded.credential_revision,server_revision=excluded.server_revision,provider_fingerprint=excluded.provider_fingerprint,grant_digest=excluded.grant_digest,scope=excluded.scope,verified_at=excluded.verified_at,valid_until=excluded.valid_until`, job, server, current.Revision, jr, cr, current.serverRevision, current.fingerprint, tokenHash(canonicalPlexInvitationGrant(current.grant)), plexLibraryVerificationScope, utcTimestamp(checked), utcTimestamp(until))
		if err != nil {
			return err
		}
		if err := auditPlexJobAdministrator(ctx, tx, admin, job, "plex.admin.verify.completed"); err != nil {
			return err
		}
		return auditAction(ctx, tx, "", "plex.share.recipient_libraries.verified")
	})
}
