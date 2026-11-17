package main

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net"
	"net/http"
	"strings"
	"time"

	"app/server/providers/mediabrowser"
	"app/server/providers/provider"
)

// Sign in with a media server login. The server checks the user's own
// username and password; MUM keeps neither the password nor the server's
// token. The verified server account is matched only by its user ID on that
// server, and a synced account without a MUM account gets one.

var (
	errServiceLoginFailed     = errors.New("media server sign-in failed")
	errServiceLoginLimit      = errors.New("too many media server sign-in attempts")
	errServiceLoginServer     = errors.New("media server is not available for sign-in")
	errServiceAccountUnknown  = errors.New("server account is not in MUM")
	errServiceAccountInactive = errors.New("server account is inactive in MUM")
	errServiceAccountClaimed  = errors.New("server account belongs to another MUM account")
	errServiceLoginBusy       = errors.New("media server sign-in is busy")
)

// loginVerifier is the module feature that checks a user's own login.
type loginVerifier interface {
	VerifyLogin(ctx context.Context, username, password string) (provider.VerifiedLogin, error)
}

// serviceCredentialTypesSQL are the server types whose username and password
// MUM checks; Plex signs in through its own PIN flow.
const serviceCredentialTypesSQL = `('jellyfin','emby','audiobookshelf','kavita')`

func serviceLoginError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, errServiceLoginLimit):
		w.Header().Set("Retry-After", "60")
		fail(w, 429, "SERVICE_SIGN_IN_LIMIT", "Too many sign-in attempts. Wait a minute and try again.")
	case errors.Is(err, errServiceLoginBusy):
		w.Header().Set("Retry-After", "2")
		fail(w, 429, "SERVICE_SIGN_IN_BUSY", "Sign-in is busy. Try again in a moment.")
	case errors.Is(err, errServiceLoginDisabled):
		fail(w, 409, "SERVICE_SIGN_IN_DISABLED", "Signing in with a media server login is turned off.")
	case errors.Is(err, errServiceLoginServer):
		fail(w, 404, "SERVICE_SIGN_IN_SERVER", "This server is not available for sign-in.")
	case errors.Is(err, errServiceLoginFailed):
		fail(w, 401, "SERVICE_SIGN_IN_FAILED", "Sign-in failed. Check the server, username and password.")
	case errors.Is(err, errServiceAccountUnknown):
		fail(w, 403, "SERVICE_ACCOUNT_NOT_IN_MUM", "This account is not in MUM yet. Ask your administrator to sync the server.")
	case errors.Is(err, errServiceAccountInactive):
		fail(w, 403, "SERVICE_ACCOUNT_INACTIVE", "This server account is disabled in MUM.")
	case errors.Is(err, errServiceAccountClaimed):
		fail(w, 409, "SERVICE_ACCOUNT_CLAIMED", "This server account belongs to another MUM account. Ask your administrator.")
	case errors.Is(err, errServiceAdminPassword):
		fail(w, 403, "ADMIN_PASSWORD_REQUIRED", "Administrators sign in with their MUM password.")
	case errors.Is(err, errAccountChangeUnderway):
		fail(w, 409, "ACCOUNT_CHANGE_IN_PROGRESS", "An administrator is changing this server. Try again shortly.")
	case errors.Is(err, ErrForbidden):
		fail(w, 403, "ACCOUNT_UNAVAILABLE", "This MUM account is disabled or expired.")
	default:
		fail(w, 502, "SERVICE_SIGN_IN_UNAVAILABLE", "The server could not check this sign-in. Try again.")
	}
}

// startSignInOperation tracks a sign-in for shutdown, in its own bounded
// slots so sign-ins never take provisioning capacity.
func (a *App) startSignInOperation(w http.ResponseWriter, r *http.Request) (context.Context, func(), bool) {
	a.provisionMu.Lock()
	if a.provisionClosing {
		a.provisionMu.Unlock()
		fail(w, 503, "SHUTTING_DOWN", "MUM is shutting down")
		return nil, nil, false
	}
	a.provisionWG.Add(1)
	a.provisionMu.Unlock()
	select {
	case a.signInSlots <- struct{}{}:
	default:
		a.provisionWG.Done()
		serviceLoginError(w, errServiceLoginBusy)
		return nil, nil, false
	}
	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	stop := context.AfterFunc(a.provisionCtx, cancel)
	return ctx, func() { stop(); cancel(); <-a.signInSlots; a.provisionWG.Done() }, true
}

func requestSource(r *http.Request) string {
	source, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return source
}

// serviceSignInAdmission enforces the attempt limits and records the attempt
// (hashed source and username only). It runs before any server is contacted.
func serviceSignInAdmission(ctx context.Context, tx *sql.Tx, source string, serverID int64, username string) error {
	now := time.Now()
	if _, err := tx.ExecContext(ctx, "DELETE FROM service_login_attempts WHERE created_at<?", utcTimestamp(now.Add(-time.Hour))); err != nil {
		return err
	}
	sourceHash := tokenHash(source)
	nameHash := tokenHash(fmt.Sprintf("%d\x00%s", serverID, strings.ToLower(strings.TrimSpace(username))))
	var bySource, byName, overall int
	if err := tx.QueryRowContext(ctx, `SELECT count(CASE WHEN source_hash=? AND created_at>? THEN 1 END),count(CASE WHEN server_id=? AND username_hash=? AND created_at>? THEN 1 END),count(CASE WHEN created_at>? THEN 1 END) FROM service_login_attempts`,
		sourceHash, utcTimestamp(now.Add(-time.Minute)), serverID, nameHash, utcTimestamp(now.Add(-15*time.Minute)), utcTimestamp(now.Add(-time.Minute))).Scan(&bySource, &byName, &overall); err != nil {
		return err
	}
	if bySource >= 10 || byName >= 5 || overall >= 60 {
		return errServiceLoginLimit
	}
	_, err := tx.ExecContext(ctx, "INSERT INTO service_login_attempts(source_hash,server_id,username_hash,created_at) VALUES(?,?,?,?)", sourceHash, serverID, nameHash, utcTimestamp(now))
	return err
}

// resolveServiceAccount finds the active synced account with externalID on
// serverID and returns the MUM account that owns it. With create, an account
// without an owner gets a new passwordless MUM account, linked as its owner.
// The caller's writer transaction serializes this with every other link.
func resolveServiceAccount(ctx context.Context, tx *sql.Tx, serverID int64, externalID string, create bool) (user, service string, err error) {
	var kind string
	if err = tx.QueryRowContext(ctx, "SELECT service_type FROM media_servers WHERE id=?", serverID).Scan(&kind); err != nil {
		return "", "", errServiceLoginServer
	}
	match, id := "sa.external_user_id=?", externalID
	if kind == "jellyfin" || kind == "emby" {
		match, id = "lower(replace(sa.external_user_id,'-',''))=?", mediabrowser.CanonicalUserID(externalID)
	}
	if id == "" || (kind == "plex" && id == plexOwnerAccountID) {
		return "", "", errServiceAccountUnknown
	}
	var active bool
	err = tx.QueryRowContext(ctx, `SELECT sa.uuid,sa.is_active=1 AND sa.removed_at IS NULL,coalesce((SELECT l.user_uuid FROM service_links l WHERE l.service_uuid=sa.uuid AND l.link_kind='owner'),'')
	 FROM service_accounts sa WHERE sa.server_id=? AND `+match+` ORDER BY sa.is_active DESC, sa.removed_at IS NULL DESC LIMIT 1`, serverID, id).Scan(&service, &active, &user)
	if errors.Is(err, sql.ErrNoRows) {
		return "", "", errServiceAccountUnknown
	}
	if err != nil {
		return "", "", err
	}
	if !active {
		return "", "", errServiceAccountInactive
	}
	if user != "" || !create {
		return user, service, nil
	}
	if busy, err := editSourceBusy(ctx, tx, serverID, ""); err != nil {
		return "", "", err
	} else if busy {
		return "", "", errAccountChangeUnderway
	}
	user = newUUID()
	now := utcTimestamp(time.Now())
	if _, err = tx.ExecContext(ctx, "INSERT INTO identities(uuid,kind) VALUES(?,'local')", user); err != nil {
		return "", "", err
	}
	if _, err = tx.ExecContext(ctx, "INSERT INTO user_accounts(uuid,kind,created_at,updated_at) VALUES(?,'local',?,?)", user, now, now); err != nil {
		return "", "", err
	}
	if _, err = tx.ExecContext(ctx, "INSERT INTO service_links(user_uuid,service_uuid,link_kind,created_at) VALUES(?,?,'owner',?)", user, service, now); err != nil {
		return "", "", err
	}
	if err = auditAction(ctx, tx, user, "auth.account.created.service"); err != nil {
		return "", "", err
	}
	return user, service, nil
}

// serverSignInAvailable checks that media server sign-in is on and that
// serverID is an active, enabled server of one of types.
func serverSignInAvailable(ctx context.Context, db queryRower, serverID int64, types string) error {
	if enabled, _ := serviceSignInSettings(ctx, db); !enabled {
		return errServiceLoginDisabled
	}
	var available bool
	if err := db.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM media_servers s JOIN provider_settings p ON p.provider_id=s.service_type
	 WHERE s.id=? AND s.is_active=1 AND p.enabled=1 AND s.service_type IN `+types+`)`, serverID).Scan(&available); err != nil {
		return err
	}
	if !available {
		return errServiceLoginServer
	}
	return nil
}

// admitServerSignIn checks the server is available for sign-in and admits
// the attempt under the attempt limits, before any server is contacted.
func (a *App) admitServerSignIn(ctx context.Context, r *http.Request, serverID int64, types, username string) error {
	return a.store.write(ctx, func(tx *sql.Tx) error {
		if err := serverSignInAvailable(ctx, tx, serverID, types); err != nil {
			return err
		}
		return serviceSignInAdmission(ctx, tx, requestSource(r), serverID, username)
	})
}

// signInModule returns the provider module of serverID for a sign-in.
func (a *App) signInModule(ctx context.Context, serverID int64) (any, error) {
	server, err := a.loadServer(ctx, serverID)
	if err != nil || !server.EffectiveActive {
		return nil, errServiceLoginServer
	}
	connection, err := newServerConnection(ProviderConfig{server.Type, server.URL, server.apiKey}, a.ProviderHTTP)
	if err != nil {
		return nil, errServiceLoginServer
	}
	return connection.module(), nil
}

// verifyServiceLogin admits the attempt, then checks the login with the
// server outside any transaction. It returns the verified server account.
func (a *App) verifyServiceLogin(ctx context.Context, r *http.Request, serverID int64, username, password string) (provider.VerifiedLogin, error) {
	if err := a.admitServerSignIn(ctx, r, serverID, serviceCredentialTypesSQL, username); err != nil {
		return provider.VerifiedLogin{}, err
	}
	module, err := a.signInModule(ctx, serverID)
	if err != nil {
		return provider.VerifiedLogin{}, err
	}
	verifier, ok := module.(loginVerifier)
	if !ok {
		return provider.VerifiedLogin{}, errServiceLoginServer
	}
	login, err := verifier.VerifyLogin(ctx, username, password)
	if errors.Is(err, provider.ErrInvalidLogin) {
		return login, errServiceLoginFailed
	}
	return login, err
}

type serviceCredentials struct {
	ServerID int64  `json:"server_id"`
	Username string `json:"username"`
	Password string `json:"password"`
}

// valid checks the sizes before anything reaches a server.
func (c *serviceCredentials) valid() bool {
	c.Username = strings.TrimSpace(c.Username)
	return c.ServerID > 0 && c.Username != "" && len(c.Username) <= 255 && c.Password != "" && len(c.Password) <= 1024
}

// signInMethods tells the login page which media server logins it may offer.
func (a *App) signInMethods(w http.ResponseWriter, r *http.Request) {
	servers := []map[string]any{}
	enabled, _ := serviceSignInSettings(r.Context(), a.store.reader)
	// A Plex account linked on the account page signs in whenever the Plex
	// provider is enabled, with or without media server sign-in.
	var plexAvailable bool
	if err := a.store.reader.QueryRowContext(r.Context(), "SELECT EXISTS(SELECT 1 FROM provider_settings WHERE provider_id='plex' AND enabled=1)").Scan(&plexAvailable); err != nil {
		domainError(w, err)
		return
	}
	if enabled {
		rows, err := a.store.reader.QueryContext(r.Context(), `SELECT s.id,s.server_nickname,s.service_type FROM media_servers s JOIN provider_settings p ON p.provider_id=s.service_type
		 WHERE s.is_active=1 AND p.enabled=1 AND s.service_type IN `+serviceSignInTypesSQL+` ORDER BY s.server_nickname COLLATE NOCASE,s.id`)
		if err != nil {
			domainError(w, err)
			return
		}
		defer rows.Close()
		for rows.Next() {
			var id int64
			var name, kind string
			if err := rows.Scan(&id, &name, &kind); err != nil {
				domainError(w, err)
				return
			}
			if kind == "plex" {
				continue
			}
			servers = append(servers, map[string]any{"id": id, "name": name, "type": kind})
		}
		if err := rows.Err(); err != nil {
			domainError(w, err)
			return
		}
	}
	respond(w, 200, map[string]any{"service_sign_in": enabled, "plex": plexAvailable, "servers": servers})
}

// serviceLogin signs in with a media server login.
func (a *App) serviceLogin(w http.ResponseWriter, r *http.Request) {
	var input struct {
		serviceCredentials
		Remember bool `json:"remember"`
	}
	if !decodeStrictBody(w, r, &input) {
		return
	}
	if !input.valid() {
		fail(w, 400, "INVALID_SIGN_IN", "Choose a server and enter its username and password (up to 1024 characters)")
		return
	}
	ctx, done, ok := a.startSignInOperation(w, r)
	if !ok {
		return
	}
	defer done()
	login, err := a.verifyServiceLogin(ctx, r, input.ServerID, input.Username, input.Password)
	if err != nil {
		serviceLoginError(w, err)
		return
	}
	tokens, principal, err := a.issueServiceSession(ctx, input.ServerID, login, input.Remember, "auth.login.service")
	if err != nil {
		serviceLoginError(w, err)
		return
	}
	a.setRefreshCookie(w, r, tokens)
	respond(w, 200, map[string]any{"access_token": tokens.Access, "user": principal})
}

// issueServiceSession signs in the MUM account that owns the verified server
// account, creating one on first sign-in, after rechecking the switch and the
// administrator rule. action names the audit event.
func (a *App) issueServiceSession(ctx context.Context, serverID int64, login provider.VerifiedLogin, remember bool, action string) (sessionTokens, Principal, error) {
	var tokens sessionTokens
	var principal Principal
	err := a.store.write(ctx, func(tx *sql.Tx) error {
		if enabled, _ := serviceSignInSettings(ctx, tx); !enabled {
			return errServiceLoginDisabled
		}
		user, service, err := resolveServiceAccount(ctx, tx, serverID, login.ID, true)
		if err != nil {
			return err
		}
		if principal, err = loadPrincipal(ctx, tx, user); err != nil {
			return err
		}
		if err := serviceSignInPermitted(ctx, tx, principal); err != nil {
			return err
		}
		if tokens, err = insertSession(ctx, tx, user, sessionOrigin{Kind: "service", Service: service}, remember); err != nil {
			return err
		}
		return auditAction(ctx, tx, user, action)
	})
	return tokens, principal, err
}
