package main

import (
	"context"
	"database/sql"
	"errors"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// Linking a Discord account and signing in with it (DISCORD_SIGN_IN_DESIGN.md,
// user decisions 2026-11-16). Every account, admin or user, links its own
// Discord account on the account page. With sign-in on, a linked account signs
// in with Discord; a Discord account never creates a MUM account. The owner
// always uses the MUM password, and accounts with admin access sign in this
// way only when the second switch allows it. Accounts are matched only by the
// Discord user ID, and no Discord token is kept.
//
// An attempt is bound to the browser that started it by an HttpOnly cookie
// holding its ID and a secret whose digest is stored; the callback needs the
// cookie, the OAuth state and a pending attempt, and runs once.

const discordAuthCookie = "mum_discord_auth"

var (
	errDiscordSignInOff = errors.New("signing in with Discord is turned off")
	errDiscordPassword  = errors.New("this account signs in with its MUM password")
)

func (a *App) setDiscordAuthCookie(w http.ResponseWriter, r *http.Request, value string, maxAge int) {
	http.SetCookie(w, &http.Cookie{Name: discordAuthCookie, Value: value, Path: "/api/discord/", HttpOnly: true, Secure: a.secureCookie(r), SameSite: http.SameSiteLaxMode, MaxAge: maxAge})
}

// discordSignInPermitted applies the switches to an account.
func discordSignInPermitted(ctx context.Context, db queryRower, p Principal) error {
	s, err := readDiscordSettings(ctx, db)
	if err != nil {
		return err
	}
	if !discordReady(s) || !s.SignIn {
		return errDiscordSignInOff
	}
	if p.Kind == "owner" || p.Admin && !s.SignInAdmins {
		return errDiscordPassword
	}
	return nil
}

// discordSignInOffered tells the login page whether to show Sign in with Discord.
func (a *App) discordSignInOffered(ctx context.Context) bool {
	s, err := readDiscordSettings(ctx, a.store.reader)
	return err == nil && discordReady(s) && s.SignIn && a.discordRedirect(ctx, s) != ""
}

// startDiscordAttempt records a pending attempt and returns Discord's
// authorize address. Only the "identify" scope is asked for.
func (a *App) startDiscordAttempt(w http.ResponseWriter, r *http.Request, kind, user, session string, remember bool) {
	settings, err := readDiscordSettings(r.Context(), a.store.reader)
	if err != nil {
		domainError(w, err)
		return
	}
	redirect := a.discordRedirect(r.Context(), settings)
	if !discordReady(settings) || redirect == "" {
		fail(w, 409, "DISCORD_UNAVAILABLE", "Discord is not set up on this server")
		return
	}
	if kind == "login" && !settings.SignIn {
		fail(w, 409, "DISCORD_SIGN_IN_DISABLED", "Signing in with Discord is turned off")
		return
	}
	id, state, secret := newUUID(), randomToken(), randomToken()
	expires := time.Now().Add(discordPendingTTL)
	err = a.store.write(r.Context(), func(tx *sql.Tx) error {
		if _, err := tx.ExecContext(r.Context(), "DELETE FROM discord_auth_attempts WHERE julianday(expires_at)<julianday('now','-1 day')"); err != nil {
			return err
		}
		var pending int
		if err := tx.QueryRowContext(r.Context(), "SELECT count(*) FROM discord_auth_attempts WHERE status IN ('pending','exchanging') AND julianday(expires_at)>julianday('now')").Scan(&pending); err != nil {
			return err
		}
		if pending >= 500 {
			return errDiscordRate
		}
		var userValue, sessionValue any
		if kind == "link" {
			userValue, sessionValue = user, session
		}
		now := utcTimestamp(time.Now())
		_, err := tx.ExecContext(r.Context(), "INSERT INTO discord_auth_attempts(id,kind,state_hash,browser_hash,user_uuid,session_id,remember,settings_revision,status,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,'pending',?,?)",
			id, kind, tokenHash(state), tokenHash(secret), userValue, sessionValue, remember, settings.Revision, now, utcTimestamp(expires))
		return err
	})
	if err != nil {
		discordInvitationError(w, err)
		return
	}
	query := url.Values{"response_type": {"code"}, "client_id": {settings.ClientID}, "scope": {"identify"}, "state": {state}, "redirect_uri": {redirect}, "prompt": {"consent"}}
	a.setDiscordAuthCookie(w, r, id+"."+secret, int(discordPendingTTL/time.Second))
	respond(w, 201, map[string]any{"redirect_url": discordAuthorizeURL + "?" + query.Encode(), "expires_at": utcTimestamp(expires)})
}

// startDiscordLogin begins Sign in with Discord.
func (a *App) startDiscordLogin(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Remember bool `json:"remember"`
	}
	if !decodeStrictBody(w, r, &input) {
		return
	}
	a.startDiscordAttempt(w, r, "login", "", "", input.Remember)
}

// currentSessionID is the session the request's access token belongs to.
func (a *App) currentSessionID(ctx context.Context, r *http.Request) (string, error) {
	var id string
	err := a.store.reader.QueryRowContext(ctx, "SELECT session_id FROM session_access_tokens WHERE token_hash=?", tokenHash(bearer(r))).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		return "", ErrForbidden
	}
	return id, err
}

// startDiscordLink begins linking a Discord account to the signed-in account.
func (a *App) startDiscordLink(w http.ResponseWriter, r *http.Request) {
	p, ok := a.principal(w, r, false)
	if !ok {
		return
	}
	var input struct {
		Remember bool `json:"remember"`
	}
	if !decodeStrictBody(w, r, &input) {
		return
	}
	session, err := a.currentSessionID(r.Context(), r)
	if err != nil {
		domainError(w, err)
		return
	}
	a.startDiscordAttempt(w, r, "link", p.UUID, session, false)
}

// accountDiscord reports whether Discord can be linked, what is linked, and
// whether this account may sign in with it.
func (a *App) accountDiscord(w http.ResponseWriter, r *http.Request) {
	p, ok := a.principal(w, r, false)
	if !ok {
		return
	}
	settings, err := readDiscordSettings(r.Context(), a.store.reader)
	if err != nil {
		domainError(w, err)
		return
	}
	var id, name, hash string
	var identity int64
	if err := a.store.reader.QueryRowContext(r.Context(), "SELECT coalesce(u.discord_user_id,''),coalesce(u.discord_username,''),coalesce(u.discord_avatar_hash,''),i.id FROM user_accounts u JOIN identities i ON i.uuid=u.uuid WHERE u.uuid=?", p.UUID).Scan(&id, &name, &hash, &identity); err != nil {
		domainError(w, err)
		return
	}
	out := map[string]any{"available": discordReady(settings) && a.discordRedirect(r.Context(), settings) != "", "linked": id != "",
		"username": nullableText(name), "sign_in": discordSignInPermitted(r.Context(), a.store.reader, p) == nil}
	// The linked account's picture, through MUM (account_avatars.go).
	if discordAvatarValid(id, hash) {
		session, err := a.requestSession(r.Context(), r)
		if err != nil {
			domainError(w, err)
			return
		}
		out["avatar_url"] = a.signedImageURL(discordAvatarPurpose, "/api/discord-avatars", session, identity, time.Now())
	}
	respond(w, 200, out)
}

// unlinkDiscord removes the account's Discord link and ends the sessions it
// signed in with Discord.
func (a *App) unlinkDiscord(w http.ResponseWriter, r *http.Request) {
	p, ok := a.principal(w, r, false)
	if !ok {
		return
	}
	err := a.store.write(r.Context(), func(tx *sql.Tx) error {
		if _, err := tx.ExecContext(r.Context(), "UPDATE user_accounts SET discord_user_id=NULL,discord_username=NULL,discord_avatar_hash=NULL,discord_email=NULL,discord_access_token=NULL,discord_refresh_token=NULL,profile_revision=profile_revision+1,updated_at=? WHERE uuid=?", utcTimestamp(time.Now()), p.UUID); err != nil {
			return err
		}
		if _, err := tx.ExecContext(r.Context(), "DELETE FROM app_sessions WHERE user_uuid=? AND sign_in_origin='discord'", p.UUID); err != nil {
			return err
		}
		return auditAction(r.Context(), tx, p.UUID, "account.discord_unlink")
	})
	if err != nil {
		domainError(w, err)
		return
	}
	respond(w, 200, map[string]any{"linked": false})
}

type discordAuthAttempt struct {
	ID, Kind, Browser, Status, User, Session string
	Remember                                 bool
	Settings                                 int64
}

// discordAuthCallback completes a link or sign-in attempt. It reports false
// when the state belongs to no such attempt, so the invitation callback runs.
func (a *App) discordAuthCallback(w http.ResponseWriter, r *http.Request) bool {
	query := r.URL.Query()
	state, code := query.Get("state"), query.Get("code")
	if len(state) != 43 {
		return false
	}
	var at discordAuthAttempt
	err := a.store.reader.QueryRowContext(r.Context(), "SELECT id,kind,browser_hash,status,coalesce(user_uuid,''),coalesce(session_id,''),remember,settings_revision FROM discord_auth_attempts WHERE state_hash=?", tokenHash(state)).
		Scan(&at.ID, &at.Kind, &at.Browser, &at.Status, &at.User, &at.Session, &at.Remember, &at.Settings)
	if err != nil {
		return false
	}
	w.Header().Set("Cache-Control", "no-store")
	// Back to the login page, or to the account page's tab with the Discord card.
	page := "/login?discord="
	if at.Kind == "link" {
		page = "/account?tab=linked-accounts&discord="
	}
	back := func(outcome string) {
		a.setDiscordAuthCookie(w, r, "", -1)
		http.Redirect(w, r, page+outcome, http.StatusSeeOther)
	}
	cookie, err := r.Cookie(discordAuthCookie)
	if err != nil {
		back("failed")
		return true
	}
	id, secret, ok := strings.Cut(cookie.Value, ".")
	if !ok || id != at.ID || tokenHash(secret) != at.Browser {
		back("failed")
		return true
	}
	// Claim the pending attempt once; a replayed callback finds it no longer pending.
	err = a.store.write(r.Context(), func(tx *sql.Tx) error {
		result, err := tx.ExecContext(r.Context(), "UPDATE discord_auth_attempts SET status='exchanging' WHERE id=? AND status='pending' AND julianday(expires_at)>julianday('now')", at.ID)
		if err != nil {
			return err
		}
		if count, _ := result.RowsAffected(); count != 1 {
			return ErrConflict
		}
		return nil
	})
	if err != nil {
		back("failed")
		return true
	}
	// finish ends the attempt with outcome, or with what apply decides inside
	// the same transaction (linking).
	finish := func(outcome string, apply func(ctx context.Context, tx *sql.Tx) (string, error)) {
		ctx, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), 3*time.Second)
		defer cancel()
		err := a.store.write(ctx, func(tx *sql.Tx) error {
			status := "failed"
			if apply != nil {
				result, err := apply(ctx, tx)
				if err != nil {
					return err
				}
				outcome = result
			}
			if outcome == "linked" || outcome == "signed_in" {
				status = "done"
			}
			_, err := tx.ExecContext(ctx, "UPDATE discord_auth_attempts SET status=?,error_code=nullif(?,'') WHERE id=? AND status='exchanging'", status, map[bool]string{true: "", false: outcome}[status == "done"], at.ID)
			return err
		})
		if err != nil {
			back("failed")
			return
		}
		back(outcome)
	}
	if query.Get("error") != "" || code == "" || len(code) > 512 {
		finish("denied", nil)
		return true
	}
	settings, err := readDiscordSettings(r.Context(), a.store.reader)
	if err != nil || settings.Revision != at.Settings || !discordReady(settings) {
		finish("failed", nil)
		return true
	}
	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()
	stop := context.AfterFunc(a.provisionCtx, cancel)
	defer stop()
	identity, _, err := a.readDiscordIdentity(ctx, settings, a.discordRedirect(r.Context(), settings), code, false)
	if err != nil {
		finish("failed", nil)
		return true
	}
	if at.Kind == "link" {
		finish("", func(ctx context.Context, tx *sql.Tx) (string, error) {
			return linkDiscordIdentity(ctx, tx, at, identity)
		})
		return true
	}
	// Sign-in: the session is issued in the same transaction that finishes the attempt.
	var issued sessionTokens
	signedIn := false
	ctx2, cancel2 := context.WithTimeout(context.WithoutCancel(r.Context()), 3*time.Second)
	defer cancel2()
	outcome := "failed"
	err = a.store.write(ctx2, func(tx *sql.Tx) error {
		var err error
		outcome, issued, err = signInDiscordIdentity(ctx2, tx, at, identity)
		if err != nil {
			return err
		}
		status, codeValue := "failed", outcome
		if outcome == "signed_in" {
			status, codeValue, signedIn = "done", "", true
		}
		_, err = tx.ExecContext(ctx2, "UPDATE discord_auth_attempts SET status=?,error_code=nullif(?,'') WHERE id=? AND status='exchanging'", status, codeValue, at.ID)
		return err
	})
	if err != nil {
		back("failed")
		return true
	}
	if signedIn {
		a.setRefreshCookie(w, r, issued)
	}
	back(outcome)
	return true
}

// linkDiscordIdentity stores the Discord account on the account that started
// the attempt, if that account and its session still exist and no other
// account has this Discord account.
func linkDiscordIdentity(ctx context.Context, tx *sql.Tx, at discordAuthAttempt, identity discordIdentity) (string, error) {
	var live bool
	if err := tx.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM app_sessions WHERE id=? AND user_uuid=? AND julianday(refresh_expires_at)>julianday('now'))", at.Session, at.User).Scan(&live); err != nil {
		return "", err
	}
	if !live {
		return "failed", nil
	}
	var used bool
	if err := tx.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM user_accounts WHERE discord_user_id=? AND uuid<>?)", identity.ID, at.User).Scan(&used); err != nil {
		return "", err
	}
	if used {
		return "in_use", nil
	}
	var avatar any
	if identity.Avatar != "" {
		avatar = identity.Avatar
	}
	result, err := tx.ExecContext(ctx, "UPDATE user_accounts SET discord_user_id=?,discord_username=?,discord_avatar_hash=?,profile_revision=profile_revision+1,updated_at=? WHERE uuid=? AND deleted_at IS NULL",
		identity.ID, identity.Username, avatar, utcTimestamp(time.Now()), at.User)
	if err != nil {
		return "", err
	}
	if count, _ := result.RowsAffected(); count != 1 {
		return "failed", nil
	}
	return "linked", auditAction(ctx, tx, at.User, "account.discord_link")
}

// signInDiscordIdentity signs in the account that linked this Discord
// account, under the switches and the owner and administrator rules.
func signInDiscordIdentity(ctx context.Context, tx *sql.Tx, at discordAuthAttempt, identity discordIdentity) (string, sessionTokens, error) {
	var user string
	err := tx.QueryRowContext(ctx, "SELECT uuid FROM user_accounts WHERE discord_user_id=? AND deleted_at IS NULL", identity.ID).Scan(&user)
	if errors.Is(err, sql.ErrNoRows) {
		return "not_linked", sessionTokens{}, nil
	}
	if err != nil {
		return "", sessionTokens{}, err
	}
	p, err := loadPrincipal(ctx, tx, user)
	if err != nil {
		return "not_allowed", sessionTokens{}, nil
	}
	switch err := discordSignInPermitted(ctx, tx, p); {
	case errors.Is(err, errDiscordPassword):
		return "password_required", sessionTokens{}, nil
	case errors.Is(err, errDiscordSignInOff):
		return "turned_off", sessionTokens{}, nil
	case err != nil:
		return "", sessionTokens{}, err
	}
	tokens, err := insertSession(ctx, tx, user, sessionOrigin{Kind: "discord", Discord: identity.ID}, at.Remember)
	if err != nil {
		if errors.Is(err, ErrForbidden) {
			return "not_allowed", sessionTokens{}, nil
		}
		return "", sessionTokens{}, err
	}
	return "signed_in", tokens, auditAction(ctx, tx, user, "auth.discord_sign_in")
}
