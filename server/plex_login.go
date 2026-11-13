package main

import (
	"app/server/providers/plex"
	"context"
	"crypto/ed25519"
	"database/sql"
	"errors"
	"net"
	"net/http"
	"time"
)

// Sign in with Plex. An anonymous Plex PIN authorization, bound to the browser
// that started it, signs in the MUM account whose active Plex connection
// (linked on the account page) matches the Plex account Plex verifies. The
// Plex token only proves the account during the attempt: it is never stored,
// and the attempt ends in at most one session.

var (
	errPlexLoginDisabled = errors.New("Plex sign-in is disabled")
	errPlexLoginUnlinked = errors.New("Plex account is not linked to a MUM account")
)

type plexLoginAttempt struct {
	ID, Browser, Status, Expires, PollAfter string
	Revision                                int64
	Remember                                bool
	Secret                                  []byte
}

const plexLoginSelect = `SELECT id,browser_hash,status,expires_at,poll_after,revision,remember,secret FROM plex_login_attempts WHERE id=?`

func scanPlexLogin(row *sql.Row) (plexLoginAttempt, error) {
	var p plexLoginAttempt
	err := row.Scan(&p.ID, &p.Browser, &p.Status, &p.Expires, &p.PollAfter, &p.Revision, &p.Remember, &p.Secret)
	if errors.Is(err, sql.ErrNoRows) {
		err = ErrForbidden
	}
	return p, err
}

func plexLoginPurpose(p plexLoginAttempt) string { return "login:" + p.ID + ":" + p.Browser }
func plexLoginCookieName(id string) string       { return "mum_plex_login_" + id }
func (a *App) setPlexLoginCookie(w http.ResponseWriter, r *http.Request, id, value string, maxAge int) {
	http.SetCookie(w, &http.Cookie{Name: plexLoginCookieName(id), Value: value, Path: "/api/auth/plex/" + id, HttpOnly: true, Secure: a.secureCookie(r), SameSite: http.SameSiteStrictMode, MaxAge: maxAge})
}
func plexLoginBound(p plexLoginAttempt, browser string) bool {
	return len(browser) == 43 && tokenHash(browser) == p.Browser && p.Expires > utcTimestamp(time.Now())
}

func plexLoginError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, errPlexRateLimit):
		w.Header().Set("Retry-After", "2")
		fail(w, 429, "PLEX_SIGN_IN_LIMIT", "Wait before starting or checking Plex sign-in")
	case errors.Is(err, errPlexLoginDisabled):
		fail(w, 409, "PLEX_SIGN_IN_DISABLED", "Plex sign-in is turned off because the Plex provider is disabled")
	case errors.Is(err, errPlexLoginUnlinked):
		fail(w, 403, "PLEX_ACCOUNT_NOT_LINKED", "This Plex account is not linked to a MUM account. Sign in with your password, then link Plex on your account page under Credentials.")
	case errors.Is(err, ErrForbidden):
		fail(w, 403, "PLEX_SIGN_IN_EXPIRED", "This Plex sign-in has expired or belongs to another browser. Start again.")
	case errors.Is(err, ErrConflict):
		fail(w, 409, "PLEX_SIGN_IN_CONFLICT", "This Plex sign-in is already finished or being checked. Start again if you are not signed in.")
	default:
		fail(w, 502, "PLEX_SIGN_IN_UNAVAILABLE", "Plex sign-in could not be completed. Try again.")
	}
}

func plexLoginEnabled(ctx context.Context, tx *sql.Tx) error {
	if err := plexProviderEnabled(ctx, tx); errors.Is(err, ErrConflict) {
		return errPlexLoginDisabled
	} else if err != nil {
		return err
	}
	return nil
}

// startPlexLogin begins a Plex PIN authorization and returns the Plex page to
// approve it on.
func (a *App) startPlexLogin(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Remember bool `json:"remember"`
	}
	if !decodeStrictBody(w, r, &input) {
		return
	}
	ctx, done, ok := a.startReviewOperation(w, r)
	if !ok {
		return
	}
	defer done()
	if _, err := a.store.plexAEAD(ctx, true); err != nil {
		plexLoginError(w, err)
		return
	}
	device, err := plex.NewDevice(a.ProviderHTTP)
	if err != nil {
		plexLoginError(w, err)
		return
	}
	now := time.Now()
	browser := randomToken()
	p := plexLoginAttempt{ID: newUUID(), Browser: tokenHash(browser), Status: "creating", Expires: utcTimestamp(now.Add(15 * time.Minute)), PollAfter: utcTimestamp(now), Revision: 1, Remember: input.Remember}
	source, _, splitErr := net.SplitHostPort(r.RemoteAddr)
	if splitErr != nil {
		source = r.RemoteAddr
	}
	sourceHash := tokenHash(source)
	err = a.store.write(ctx, func(tx *sql.Tx) error {
		if err := plexLoginEnabled(ctx, tx); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, "DELETE FROM plex_login_attempts WHERE expires_at<? AND (operation_token IS NULL OR operation_expires_at<?)", utcTimestamp(now.Add(-24*time.Hour)), utcTimestamp(now)); err != nil {
			return err
		}
		var active, total, recentSource, recentGlobal int
		if err := tx.QueryRowContext(ctx, `SELECT count(CASE WHEN status IN ('creating','pending') AND expires_at>? THEN 1 END),count(*),count(CASE WHEN source_hash=? AND created_at>? THEN 1 END),count(CASE WHEN created_at>? THEN 1 END) FROM plex_login_attempts`,
			utcTimestamp(now), sourceHash, utcTimestamp(now.Add(-time.Minute)), utcTimestamp(now.Add(-time.Minute))).Scan(&active, &total, &recentSource, &recentGlobal); err != nil {
			return err
		}
		if active >= 100 || total >= 5000 || recentSource >= 10 || recentGlobal >= 60 {
			return errPlexRateLimit
		}
		_, err := tx.ExecContext(ctx, `INSERT INTO plex_login_attempts(id,browser_hash,source_hash,status,remember,expires_at,poll_after,created_at,updated_at) VALUES(?,?,?,'creating',?,?,?,?,?)`,
			p.ID, p.Browser, sourceHash, p.Remember, p.Expires, p.PollAfter, utcTimestamp(now), utcTimestamp(now))
		return err
	})
	if err != nil {
		plexLoginError(w, err)
		return
	}
	committed := false
	defer func() {
		if !committed {
			cleanup, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			_ = a.store.write(cleanup, func(tx *sql.Tx) error {
				_, err := tx.ExecContext(cleanup, "UPDATE plex_login_attempts SET status='failed',secret=NULL WHERE id=? AND status='creating'", p.ID)
				return err
			})
		}
	}()
	pin, err := device.BeginPIN(ctx)
	if err != nil {
		plexLoginError(w, err)
		return
	}
	p.Expires = utcTimestamp(pin.Expires)
	secret := plexStoredCredential{ClientID: device.ClientID, KeyID: device.KeyID, PrivateKey: []byte(device.PrivateKey), PINID: pin.ID, PINCode: pin.Code, Expires: pin.Expires}
	encoded, err := a.store.sealPlexCredential(ctx, plexLoginPurpose(p), secret)
	if err != nil {
		plexLoginError(w, err)
		return
	}
	err = a.store.write(ctx, func(tx *sql.Tx) error {
		if err := plexLoginEnabled(ctx, tx); err != nil {
			return err
		}
		updated, err := tx.ExecContext(ctx, "UPDATE plex_login_attempts SET status='pending',secret=?,expires_at=?,revision=revision+1,updated_at=? WHERE id=? AND status='creating' AND expires_at>?", encoded, p.Expires, utcTimestamp(time.Now()), p.ID, utcTimestamp(time.Now()))
		if err != nil {
			return err
		}
		if count, _ := updated.RowsAffected(); count != 1 {
			return ErrConflict
		}
		return nil
	})
	if err != nil {
		plexLoginError(w, err)
		return
	}
	committed = true
	a.setPlexLoginCookie(w, r, p.ID, browser, int(time.Until(pin.Expires).Seconds()))
	respond(w, 201, map[string]any{"id": p.ID, "status": "pending", "expires_at": p.Expires, "authorization_url": pin.AuthorizationURL})
}

// pollPlexLogin checks the authorization once. When Plex has verified the
// account, the attempt is consumed and, if that account is linked to an active
// MUM account, a session is issued exactly as a password sign-in issues one.
func (a *App) pollPlexLogin(w http.ResponseWriter, r *http.Request) {
	var input struct{}
	if !decodeStrictBody(w, r, &input) {
		return
	}
	id := r.PathValue("attempt")
	cookie, err := r.Cookie(plexLoginCookieName(id))
	if !validProvisionedID(id) || err != nil || len(cookie.Value) != 43 {
		plexLoginError(w, ErrForbidden)
		return
	}
	ctx, done, ok := a.startReviewOperation(w, r)
	if !ok {
		return
	}
	defer done()
	var p plexLoginAttempt
	lease := randomToken()
	err = a.store.write(ctx, func(tx *sql.Tx) error {
		if err := plexLoginEnabled(ctx, tx); err != nil {
			return err
		}
		var err error
		if p, err = scanPlexLogin(tx.QueryRowContext(ctx, plexLoginSelect, id)); err != nil {
			return err
		}
		if !plexLoginBound(p, cookie.Value) {
			return ErrForbidden
		}
		if p.Status != "pending" {
			return ErrConflict
		}
		now := time.Now()
		if p.PollAfter > utcTimestamp(now) {
			return errPlexRateLimit
		}
		result, err := tx.ExecContext(ctx, `UPDATE plex_login_attempts SET operation_token=?,operation_expires_at=?,poll_after=?,revision=revision+1,updated_at=? WHERE id=? AND revision=? AND (operation_token IS NULL OR operation_expires_at<?)`,
			lease, utcTimestamp(now.Add(30*time.Second)), utcTimestamp(now.Add(2*time.Second)), utcTimestamp(now), p.ID, p.Revision, utcTimestamp(now))
		if err != nil {
			return err
		}
		if count, _ := result.RowsAffected(); count != 1 {
			return ErrConflict
		}
		p.Revision++
		return nil
	})
	if err != nil {
		plexLoginError(w, err)
		return
	}
	release := func() {
		cleanup, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = a.store.write(cleanup, func(tx *sql.Tx) error {
			_, err := tx.ExecContext(cleanup, "UPDATE plex_login_attempts SET operation_token=NULL,operation_expires_at=NULL WHERE id=? AND operation_token=?", id, lease)
			return err
		})
	}
	secret, err := a.store.openPlexCredential(ctx, plexLoginPurpose(p), p.Secret)
	if err != nil {
		release()
		plexLoginError(w, err)
		return
	}
	device, err := plex.NewDevice(a.ProviderHTTP)
	if err != nil {
		release()
		plexLoginError(w, err)
		return
	}
	device.ClientID, device.KeyID, device.PrivateKey = secret.ClientID, secret.KeyID, ed25519.PrivateKey(secret.PrivateKey)
	result, err := device.PollPIN(ctx, plex.PIN{ID: secret.PINID, Code: secret.PINCode, Expires: secret.Expires, ClientID: secret.ClientID})
	if err != nil || !result.Pending && result.Account == nil {
		release()
		plexLoginError(w, errors.Join(errPlexAuthentication, err))
		return
	}
	if result.Pending {
		release()
		respond(w, 200, map[string]any{"id": id, "status": "pending", "expires_at": p.Expires})
		return
	}
	// Plex verified the account: the attempt is consumed either way, and its
	// device secret is discarded.
	var owner string
	err = a.store.write(ctx, func(tx *sql.Tx) error {
		if err := plexLoginEnabled(ctx, tx); err != nil {
			return err
		}
		lookup := tx.QueryRowContext(ctx, "SELECT owner_uuid FROM plex_connections WHERE account_id=? AND status='active'", result.Account.ID).Scan(&owner)
		if lookup != nil && !errors.Is(lookup, sql.ErrNoRows) {
			return lookup
		}
		next, action := "consumed", "auth.login.plex"
		if errors.Is(lookup, sql.ErrNoRows) {
			next, action, owner = "failed", "auth.login.plex.unlinked", ""
		}
		updated, err := tx.ExecContext(ctx, `UPDATE plex_login_attempts SET status=?,secret=NULL,operation_token=NULL,operation_expires_at=NULL,revision=revision+1,updated_at=? WHERE id=? AND browser_hash=? AND revision=? AND status='pending' AND operation_token=? AND operation_expires_at>? AND expires_at>?`,
			next, utcTimestamp(time.Now()), id, tokenHash(cookie.Value), p.Revision, lease, utcTimestamp(time.Now()), utcTimestamp(time.Now()))
		if err != nil {
			return err
		}
		if count, _ := updated.RowsAffected(); count != 1 {
			return ErrConflict
		}
		return auditAction(ctx, tx, owner, action)
	})
	if err != nil {
		release()
		plexLoginError(w, err)
		return
	}
	a.setPlexLoginCookie(w, r, id, "", -1)
	if owner == "" {
		plexLoginError(w, errPlexLoginUnlinked)
		return
	}
	// Plex has proved the linked account, which stands in for the password
	// proof; the session rechecks that the account is active and unexpired.
	tokens, err := a.store.issueSession(ctx, owner, p.Remember)
	if err != nil {
		fail(w, 401, "INVALID_CREDENTIALS", "Account is unavailable")
		return
	}
	principal, err := loadPrincipal(ctx, a.store.reader, owner)
	if err != nil {
		fail(w, 401, "INVALID_CREDENTIALS", "Account is unavailable")
		return
	}
	a.setRefreshCookie(w, r, tokens)
	respond(w, 200, map[string]any{"id": id, "status": "signed_in", "access_token": tokens.Access, "user": principal})
}
