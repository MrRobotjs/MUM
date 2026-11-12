package main

import (
	"context"
	"crypto/ed25519"
	"database/sql"
	"errors"
	"net"
	"net/http"
	"time"
)

func plexInvitationAuthorizationError(w http.ResponseWriter, err error) {
	if errors.Is(err, ErrForbidden) || errors.Is(err, ErrConflict) || errors.Is(err, errPlexRateLimit) {
		plexAuthorizationError(w, err)
		return
	}
	fail(w, 502, "PLEX_INVITATION_AUTHORIZATION_UNAVAILABLE", "Invitation authorization could not be verified. No share acceptance has been confirmed.")
}
func plexInvitationCookieName(id string) string { return "mum_plex_invite_" + id }
func (a *App) setPlexInvitationCookie(w http.ResponseWriter, r *http.Request, id, value string, maxAge int) {
	http.SetCookie(w, &http.Cookie{Name: plexInvitationCookieName(id), Value: value, Path: "/api/public/invitations/" + r.PathValue("token"), HttpOnly: true, Secure: a.secureCookie(r), SameSite: http.SameSiteStrictMode, MaxAge: maxAge})
}
func plexInvitationView(p plexInvitationAuthorization) map[string]any {
	view := plexAuthorizationView(p.plexAuthorization)
	view["invitation_revision"] = p.InviteRevision
	if p.Status == "confirmed" {
		view["account"] = map[string]string{"id": p.AccountID, "username": p.Username}
	}
	return view
}
func validPlexInvitationToken(token string) bool {
	return len(token) == 43 && validProvisionedID(token)
}
func (a *App) startInvitationPlexAuthorization(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Revision int64 `json:"invitation_revision"`
	}
	if !decodeStrictBody(w, r, &input) {
		return
	}
	token := r.PathValue("token")
	if !validPlexInvitationToken(token) || input.Revision < 1 {
		domainError(w, ErrForbidden)
		return
	}
	ctx, done, ok := a.startReviewOperation(w, r)
	if !ok {
		return
	}
	defer done()
	var scope plexInvitationScope
	err := a.store.write(ctx, func(tx *sql.Tx) error {
		var err error
		scope, err = loadPlexInvitationScope(ctx, tx, tokenHash(token), input.Revision, "")
		return err
	})
	if err != nil {
		plexInvitationAuthorizationError(w, err)
		return
	}
	if _, err := a.store.plexAEAD(ctx, true); err != nil {
		plexInvitationAuthorizationError(w, err)
		return
	}
	device, err := newPlexDeviceAuth(a.ProviderHTTP)
	if err != nil {
		plexInvitationAuthorizationError(w, err)
		return
	}
	now := time.Now()
	browser := randomToken()
	p := plexInvitationAuthorization{plexAuthorization: plexAuthorization{ID: newUUID(), Browser: tokenHash(browser), Status: "creating", Expires: utcTimestamp(now.Add(15 * time.Minute)), PollAfter: utcTimestamp(now), Revision: 1}, InviteID: scope.ID, InviteRevision: scope.Revision, Digest: scope.Digest, Fingerprint: scope.Fingerprint}
	source, _, splitErr := net.SplitHostPort(r.RemoteAddr)
	if splitErr != nil {
		source = r.RemoteAddr
	}
	sourceHash := tokenHash(source)
	err = a.store.write(ctx, func(tx *sql.Tx) error {
		if err := verifyPlexInvitationScope(ctx, tx, p, ""); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `DELETE FROM plex_invitation_authorizations WHERE expires_at<? AND (operation_token IS NULL OR operation_expires_at<?) AND NOT EXISTS(SELECT 1 FROM plex_invitation_credentials c WHERE c.proof_id=plex_invitation_authorizations.id)`, utcTimestamp(now.Add(-24*time.Hour)), utcTimestamp(now)); err != nil {
			return err
		}
		var perInvite, active, total, recentSource, recentGlobal int
		if err := tx.QueryRowContext(ctx, `SELECT count(CASE WHEN invite_id=? AND status IN ('creating','pending','verified','confirmed') AND expires_at>? THEN 1 END),count(CASE WHEN status IN ('creating','pending','verified','confirmed') AND expires_at>? THEN 1 END),count(CASE WHEN status!='consumed' THEN 1 END),count(CASE WHEN source_hash=? AND created_at>? THEN 1 END),count(CASE WHEN created_at>? THEN 1 END) FROM plex_invitation_authorizations`, p.InviteID, utcTimestamp(now), utcTimestamp(now), sourceHash, utcTimestamp(now.Add(-time.Minute)), utcTimestamp(now.Add(-time.Minute))).Scan(&perInvite, &active, &total, &recentSource, &recentGlobal); err != nil {
			return err
		}
		if perInvite >= 20 || active >= 100 || total >= 5000 || recentSource >= 10 || recentGlobal >= 60 {
			return errPlexRateLimit
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO plex_invitation_authorizations(id,invite_id,invite_digest,invite_revision,grant_fingerprint,browser_hash,source_hash,status,expires_at,poll_after,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'creating',?,?,?,?)`, p.ID, p.InviteID, p.Digest, p.InviteRevision, p.Fingerprint, p.Browser, sourceHash, p.Expires, p.PollAfter, utcTimestamp(now), utcTimestamp(now)); err != nil {
			return err
		}
		return auditAction(ctx, tx, "", "plex.invitation.authorization.start")
	})
	if err != nil {
		plexInvitationAuthorizationError(w, err)
		return
	}
	committed := false
	defer func() {
		if !committed {
			cleanup, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			_ = a.store.write(cleanup, func(tx *sql.Tx) error {
				_, err := tx.ExecContext(cleanup, "UPDATE plex_invitation_authorizations SET status='failed',secret=NULL WHERE id=? AND status='creating'", p.ID)
				return err
			})
		}
	}()
	pin, err := device.beginPIN(ctx)
	if err != nil {
		plexInvitationAuthorizationError(w, err)
		return
	}
	// An invitation without an expiry (Flask "never expires") leaves the PIN's
	// own lifetime in place.
	if scope.Expires != "" {
		inviteExpires, err := time.Parse(time.RFC3339Nano, scope.Expires)
		if err != nil {
			plexInvitationAuthorizationError(w, err)
			return
		}
		if pin.expires.After(inviteExpires) {
			pin.expires = inviteExpires
		}
	}
	p.Expires = utcTimestamp(pin.expires)
	secret := plexStoredCredential{ClientID: device.clientID, KeyID: device.keyID, PrivateKey: []byte(device.privateKey), PINID: pin.id, PINCode: pin.code, Expires: pin.expires}
	encoded, err := a.store.sealPlexCredential(ctx, plexInvitationPurpose(p), secret)
	if err != nil {
		plexInvitationAuthorizationError(w, err)
		return
	}
	err = a.store.write(ctx, func(tx *sql.Tx) error {
		if err := verifyPlexInvitationScope(ctx, tx, p, ""); err != nil {
			return err
		}
		updated, err := tx.ExecContext(ctx, "UPDATE plex_invitation_authorizations SET status='pending',secret=?,expires_at=?,revision=revision+1,updated_at=? WHERE id=? AND status='creating' AND expires_at>?", encoded, p.Expires, utcTimestamp(time.Now()), p.ID, utcTimestamp(time.Now()))
		if err != nil {
			return err
		}
		count, _ := updated.RowsAffected()
		if count != 1 {
			return ErrConflict
		}
		return nil
	})
	if err != nil {
		plexInvitationAuthorizationError(w, err)
		return
	}
	committed = true
	p.Status = "pending"
	p.Revision++
	a.setPlexInvitationCookie(w, r, p.ID, browser, int(time.Until(pin.expires).Seconds()))
	view := plexInvitationView(p)
	view["authorization_url"] = pin.authorizationURL
	respond(w, 201, view)
}
func (a *App) pollInvitationPlexAuthorization(w http.ResponseWriter, r *http.Request) {
	var input struct{}
	if !decodeStrictBody(w, r, &input) {
		return
	}
	token, id := r.PathValue("token"), r.PathValue("authorization")
	cookie, err := r.Cookie(plexInvitationCookieName(id))
	if !validPlexInvitationToken(token) || !validProvisionedID(id) || err != nil || len(cookie.Value) != 43 {
		domainError(w, ErrForbidden)
		return
	}
	ctx, done, ok := a.startReviewOperation(w, r)
	if !ok {
		return
	}
	defer done()
	var p plexInvitationAuthorization
	lease := randomToken()
	err = a.store.write(ctx, func(tx *sql.Tx) error {
		var err error
		p, err = scanPlexInvitationAuthorization(tx.QueryRowContext(ctx, plexInvitationSelect, id, tokenHash(token)))
		if err != nil {
			return err
		}
		if !plexAuthorizationBound(p.plexAuthorization, cookie.Value) {
			return ErrForbidden
		}
		if err := verifyPlexInvitationScope(ctx, tx, p, ""); err != nil {
			return err
		}
		if p.Status == "verified" || p.Status == "confirmed" {
			return nil
		}
		if p.Status != "pending" {
			return ErrConflict
		}
		now := time.Now()
		if p.PollAfter > utcTimestamp(now) {
			return errPlexRateLimit
		}
		result, err := tx.ExecContext(ctx, "UPDATE plex_invitation_authorizations SET operation_token=?,operation_expires_at=?,poll_after=?,revision=revision+1,updated_at=? WHERE id=? AND revision=? AND (operation_token IS NULL OR operation_expires_at<?)", lease, utcTimestamp(now.Add(30*time.Second)), utcTimestamp(now.Add(2*time.Second)), utcTimestamp(now), id, p.Revision, utcTimestamp(now))
		if err != nil {
			return err
		}
		count, _ := result.RowsAffected()
		if count != 1 {
			return ErrConflict
		}
		p.Revision++
		return nil
	})
	if err != nil {
		plexInvitationAuthorizationError(w, err)
		return
	}
	if p.Status == "verified" || p.Status == "confirmed" {
		respond(w, 200, plexInvitationView(p))
		return
	}
	defer func() {
		cleanup, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = a.store.write(cleanup, func(tx *sql.Tx) error {
			_, err := tx.ExecContext(cleanup, "UPDATE plex_invitation_authorizations SET operation_token=NULL,operation_expires_at=NULL WHERE id=? AND operation_token=?", id, lease)
			return err
		})
	}()
	secret, err := a.store.openPlexCredential(ctx, plexInvitationPurpose(p), p.Secret)
	if err != nil {
		plexInvitationAuthorizationError(w, err)
		return
	}
	device, err := newPlexDeviceAuth(a.ProviderHTTP)
	if err != nil {
		plexInvitationAuthorizationError(w, err)
		return
	}
	device.clientID = secret.ClientID
	device.keyID = secret.KeyID
	device.privateKey = ed25519.PrivateKey(secret.PrivateKey)
	result, err := device.pollPIN(ctx, plexPIN{secret.PINID, secret.PINCode, secret.Expires, secret.ClientID, ""})
	if err != nil {
		plexInvitationAuthorizationError(w, err)
		return
	}
	encoded := p.Secret
	if !result.Pending {
		if result.Account == nil {
			plexInvitationAuthorizationError(w, errPlexAuthentication)
			return
		}
		secret.AccountID = result.Account.ID
		secret.Token = result.authToken
		secret.PINCode = ""
		secret.PINID = 0
		encoded, err = a.store.sealPlexCredential(ctx, plexInvitationPurpose(p), secret)
		if err != nil {
			plexInvitationAuthorizationError(w, err)
			return
		}
	}
	err = a.store.write(ctx, func(tx *sql.Tx) error {
		if err := verifyPlexInvitationScope(ctx, tx, p, ""); err != nil {
			return err
		}
		status, account, username := "pending", "", ""
		if !result.Pending {
			status = "verified"
			account = result.Account.ID
			username = result.Account.Username
		}
		updated, err := tx.ExecContext(ctx, `UPDATE plex_invitation_authorizations SET status=?,secret=?,account_id=?,username=?,operation_token=NULL,operation_expires_at=NULL,revision=revision+1,updated_at=? WHERE id=? AND invite_digest=? AND revision=? AND browser_hash=? AND status='pending' AND operation_token=? AND operation_expires_at>? AND expires_at>?`, status, encoded, account, username, utcTimestamp(time.Now()), id, p.Digest, p.Revision, p.Browser, lease, utcTimestamp(time.Now()), utcTimestamp(time.Now()))
		if err != nil {
			return err
		}
		count, _ := updated.RowsAffected()
		if count != 1 {
			return ErrConflict
		}
		p.Status = status
		p.AccountID = account
		p.Username = username
		p.Revision++
		if !result.Pending {
			return auditAction(ctx, tx, "", "plex.invitation.authorization.verified")
		}
		return nil
	})
	if err != nil {
		plexInvitationAuthorizationError(w, err)
		return
	}
	respond(w, 200, plexInvitationView(p))
}
func (a *App) confirmInvitationPlexAuthorization(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Revision int64  `json:"invitation_revision"`
		Account  string `json:"expected_account_id"`
	}
	if !decodeStrictBody(w, r, &input) {
		return
	}
	token, id := r.PathValue("token"), r.PathValue("authorization")
	cookie, err := r.Cookie(plexInvitationCookieName(id))
	if !validPlexInvitationToken(token) || !validProvisionedID(id) || err != nil || len(cookie.Value) != 43 || input.Revision < 1 {
		domainError(w, ErrForbidden)
		return
	}
	p, err := scanPlexInvitationAuthorization(a.store.reader.QueryRowContext(r.Context(), plexInvitationSelect, id, tokenHash(token)))
	if err != nil {
		plexInvitationAuthorizationError(w, err)
		return
	}
	if (p.Status != "verified" && p.Status != "confirmed") || !plexAuthorizationBound(p.plexAuthorization, cookie.Value) || p.InviteRevision != input.Revision || p.AccountID != input.Account {
		domainError(w, ErrForbidden)
		return
	}
	secret, err := a.store.openPlexCredential(r.Context(), plexInvitationPurpose(p), p.Secret)
	if err != nil || !secret.Expires.After(time.Now()) || secret.AccountID != p.AccountID || !plexJWTShape(secret.Token) {
		plexInvitationAuthorizationError(w, errPlexAuthentication)
		return
	}
	expectedRevision := p.Revision
	err = a.store.write(r.Context(), func(tx *sql.Tx) error {
		var err error
		p, err = scanPlexInvitationAuthorization(tx.QueryRowContext(r.Context(), plexInvitationSelect, id, tokenHash(token)))
		if err != nil {
			return err
		}
		if p.Revision != expectedRevision {
			return ErrConflict
		}
		if !plexAuthorizationBound(p.plexAuthorization, cookie.Value) || p.InviteRevision != input.Revision || p.AccountID != input.Account {
			return ErrForbidden
		}
		if err := verifyPlexInvitationScope(r.Context(), tx, p, ""); err != nil {
			return err
		}
		if p.Status == "confirmed" {
			return nil
		}
		if p.Status != "verified" || p.Operation != "" {
			return ErrConflict
		}
		result, err := tx.ExecContext(r.Context(), "UPDATE plex_invitation_authorizations SET status='confirmed',revision=revision+1,updated_at=? WHERE id=? AND revision=? AND status='verified'", utcTimestamp(time.Now()), id, p.Revision)
		if err != nil {
			return err
		}
		count, _ := result.RowsAffected()
		if count != 1 {
			return ErrConflict
		}
		p.Status = "confirmed"
		p.Revision++
		return auditAction(r.Context(), tx, "", "plex.invitation.authorization.confirm")
	})
	if err != nil {
		plexInvitationAuthorizationError(w, err)
		return
	}
	respond(w, 200, plexInvitationView(p))
}
