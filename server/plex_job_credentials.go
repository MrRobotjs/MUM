package main

import (
	"app/server/providers/plex"
	"context"
	"crypto/ed25519"
	"database/sql"
	"net/http"
	"time"
)

// The recipient device belongs to the consumed job proof, not the owner token
// used by the provider adapter. A job-wide lease serializes refreshes across
// multiple server checkpoints sharing this device.
func (a *App) refreshPlexJobCredential(ctx context.Context, claim plexShareCheckpoint) (plexStoredCredential, error) {
	return a.refreshPlexJobCredentialAs(ctx, claim, nil)
}
func (a *App) refreshPlexJobCredentialAs(ctx context.Context, claim plexShareCheckpoint, admin *plexJobAdministrator) (plexStoredCredential, error) {
	var secret plexStoredCredential
	var encrypted []byte
	var purpose string
	var revision int64
	lease := randomToken()
	check := func(tx *sql.Tx) error {
		if err := requirePlexJobAdministrator(ctx, tx, admin, claim.Job); err != nil {
			return err
		}
		current, err := loadPlexShareCheckpoint(ctx, tx, claim.Job, claim.Server)
		if err != nil {
			return err
		}
		if claim.token == "" || current.token != claim.token || current.Revision != claim.Revision || current.expires <= utcTimestamp(time.Now()) {
			return ErrConflict
		}
		if err := plexShareJobEligible(ctx, tx, current); err != nil {
			return err
		}
		if err := plexShareServerAuthority(ctx, tx, &current); err != nil {
			return err
		}
		if current.serverRevision != claim.serverRevision {
			return ErrConflict
		}
		return nil
	}
	err := a.store.write(ctx, func(tx *sql.Tx) error {
		if err := check(tx); err != nil {
			return err
		}
		var proofID, digest, user string
		if err := tx.QueryRowContext(ctx, `SELECT c.proof_id,p.invite_digest,c.user_uuid,c.secret,c.revision FROM plex_invitation_credentials c JOIN plex_invitation_authorizations p ON p.id=c.proof_id WHERE c.job_id=? AND c.status='active' AND (c.refresh_token IS NULL OR c.refresh_expires_at<=?)`, claim.Job, utcTimestamp(time.Now())).Scan(&proofID, &digest, &user, &encrypted, &revision); err != nil {
			return err
		}
		proof, err := scanPlexInvitationAuthorization(tx.QueryRowContext(ctx, plexInvitationSelect, proofID, digest))
		if err != nil {
			return err
		}
		purpose = plexInvitationJobPurpose(claim.Job, user, claim.Account, proof)
		_, err = tx.ExecContext(ctx, "UPDATE plex_invitation_credentials SET refresh_token=?,refresh_expires_at=?,revision=revision+1 WHERE job_id=?", lease, utcTimestamp(time.Now().Add(30*time.Second)), claim.Job)
		revision++
		return err
	})
	if err != nil {
		return secret, err
	}
	defer func() {
		cleanup, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = a.store.write(cleanup, func(tx *sql.Tx) error {
			_, err := tx.ExecContext(cleanup, "UPDATE plex_invitation_credentials SET refresh_token=NULL,refresh_expires_at=NULL,revision=revision+1 WHERE job_id=? AND refresh_token=?", claim.Job, lease)
			return err
		})
	}()
	secret, err = a.store.openPlexCredential(ctx, purpose, encrypted)
	if err != nil {
		return plexStoredCredential{}, err
	}
	if secret.AccountID != claim.Account {
		return plexStoredCredential{}, errPlexAuthentication
	}
	device, err := plex.NewDevice(a.ProviderHTTP)
	if err != nil {
		return plexStoredCredential{}, err
	}
	device.ClientID = secret.ClientID
	device.KeyID = secret.KeyID
	device.PrivateKey = ed25519.PrivateKey(secret.PrivateKey)
	result, err := device.RefreshAccount(ctx, claim.Account)
	if err != nil {
		return plexStoredCredential{}, err
	}
	secret.Token = result.AuthToken
	secret.PINID = 0
	secret.PINCode = ""
	// A conservative local verification window, not a claim about cloud JWT TTL.
	secret.Expires = time.Now().Add(15 * time.Minute)
	encrypted, err = a.store.sealPlexCredential(ctx, purpose, secret)
	if err != nil {
		return plexStoredCredential{}, err
	}
	err = a.store.write(ctx, func(tx *sql.Tx) error {
		if err := check(tx); err != nil {
			return err
		}
		result, err := tx.ExecContext(ctx, `UPDATE plex_invitation_credentials SET secret=?,refresh_token=NULL,refresh_expires_at=NULL,revision=revision+1 WHERE job_id=? AND status='active' AND revision=? AND refresh_token=? AND refresh_expires_at>?`, encrypted, claim.Job, revision, lease, utcTimestamp(time.Now()))
		if err != nil {
			return err
		}
		count, _ := result.RowsAffected()
		if count != 1 {
			return ErrConflict
		}
		return auditAction(ctx, tx, "", "plex.invitation.credential.refresh")
	})
	if err != nil {
		return plexStoredCredential{}, err
	}
	return secret, nil
}

// Private, shutdown-tracked read work. There is no route, scheduler or sharing
// mutation here. Admission and cancellation use the existing provision bounds.
func (a *App) inspectPlexRecipient(ctx context.Context, claim plexShareCheckpoint) error {
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
	secret, err := a.refreshPlexJobCredential(ctx, claim)
	if err != nil {
		return err
	}
	var config ProviderConfig
	err = a.store.write(ctx, func(tx *sql.Tx) error {
		current, err := loadPlexShareCheckpoint(ctx, tx, claim.Job, claim.Server)
		if err != nil {
			return err
		}
		if current.token != claim.token || current.Revision != claim.Revision || current.expires <= utcTimestamp(time.Now()) {
			return ErrConflict
		}
		if err := plexShareJobEligible(ctx, tx, current); err != nil {
			return err
		}
		if err := plexShareServerAuthority(ctx, tx, &current); err != nil {
			return err
		}
		if current.serverRevision != claim.serverRevision {
			return ErrConflict
		}
		server, err := scanServer(tx.QueryRowContext(ctx, serverSelect+" WHERE s.id=?", claim.Server))
		if err != nil {
			return err
		}
		config = ProviderConfig{Type: server.Type, URL: server.URL, APIKey: server.apiKey}
		return nil
	})
	if err != nil {
		return err
	}
	owner, err := newServerConnection(config, a.ProviderHTTP)
	if err != nil {
		return err
	}
	observation, err := owner.inspectPlexShare(ctx, claim.Account, claim.grant)
	if err != nil {
		return err
	}
	if observation.State == "accepted" {
		if err := verifyPlexRecipientLibraries(ctx, a.ProviderHTTP, secret, config.URL, observation, claim.grant); err != nil {
			return err
		}
	}
	return a.store.recordPlexShareObservation(ctx, claim, observation)
}

// Plex documents separate per-resource PMS credentials. Only the administrator's
// configured PMS URL is used; resource-supplied connection URLs are ignored.
func verifyPlexRecipientLibraries(ctx context.Context, client *http.Client, secret plexStoredCredential, serverURL string, observation plexSharePreflight, grant InvitationGrant) error {
	if !secret.Expires.After(time.Now()) || secret.AccountID != observation.Account || !plexShareMatches(observation, grant) {
		return errPlexShare
	}
	device, err := plex.NewDevice(client)
	if err != nil {
		return errPlexShare
	}
	device.ClientID = secret.ClientID
	device.KeyID = secret.KeyID
	device.PrivateKey = ed25519.PrivateKey(secret.PrivateKey)
	if _, err := device.VerifyAccount(ctx, secret.Token, secret.AccountID); err != nil {
		return errPlexShare
	}
	var resources []struct {
		Machine     string `json:"clientIdentifier"`
		Owned       *bool  `json:"owned"`
		Provides    string `json:"provides"`
		AccessToken string `json:"accessToken"`
	}
	if err := device.Request(ctx, http.MethodGet, "https://clients.plex.tv/api/v2/resources?includeHttps=1&includeRelay=1&includeIPv6=1", secret.Token, nil, &resources); err != nil || resources == nil {
		return errPlexShare
	}
	token := ""
	for _, resource := range resources {
		if resource.Machine != observation.Machine {
			continue
		}
		if token != "" || resource.Owned == nil || *resource.Owned || resource.Provides != "server" || resource.AccessToken == "" {
			return errPlexShare
		}
		token = resource.AccessToken
	}
	if token == "" {
		return errPlexShare
	}
	provider, err := newServerConnection(ProviderConfig{Type: "plex", URL: serverURL, APIKey: token}, client)
	if err != nil {
		return errPlexShare
	}
	recipient := provider
	recipient.plexClientID = secret.ClientID
	identity, err := recipient.plexIdentity(ctx)
	if err != nil || identity.Machine != observation.Machine {
		return errPlexShare
	}
	libraries, err := recipient.plexLibraries(ctx)
	if err != nil {
		return errPlexShare
	}
	want := map[string]bool{}
	for _, section := range observation.Sections {
		want[section.Key] = true
	}
	if len(libraries) != len(want) {
		return errPlexShare
	}
	for _, library := range libraries {
		if !want[library.ID] {
			return errPlexShare
		}
		delete(want, library.ID)
	}
	if len(want) != 0 {
		return errPlexShare
	}
	return nil
}
