package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"time"
)

// Sign in with a media server login: one switch for every supported server
// type, and a second switch for accounts with admin access. The owner always
// signs in with a MUM password.

var (
	errServiceLoginDisabled = errors.New("media server sign-in is turned off")
	errServiceAdminPassword = errors.New("administrators sign in with their MUM password")
)

// serviceSignInTypesSQL lists the server types whose logins sign in to MUM.
const serviceSignInTypesSQL = `('plex','jellyfin','emby','audiobookshelf','kavita')`

// serviceSignInSettings reads both switches; anything but "true" is off, and
// the administrator switch means nothing while the main switch is off.
func serviceSignInSettings(ctx context.Context, db queryRower) (enabled, admins bool) {
	var e, a string
	if db.QueryRowContext(ctx, "SELECT coalesce((SELECT value FROM settings WHERE key='SERVICE_SIGN_IN'),''),coalesce((SELECT value FROM settings WHERE key='SERVICE_SIGN_IN_ADMINS'),'')").Scan(&e, &a) != nil {
		return false, false
	}
	return e == "true", e == "true" && a == "true"
}

// serviceSignInPermitted applies the switches to an account: the owner never
// signs in through a server login, administrators only when allowed.
func serviceSignInPermitted(ctx context.Context, db queryRower, p Principal) error {
	enabled, admins := serviceSignInSettings(ctx, db)
	if !enabled {
		return errServiceLoginDisabled
	}
	if p.Kind == "owner" || (p.Admin && !admins) {
		return errServiceAdminPassword
	}
	return nil
}

// sessionOriginAllowed decides whether a session signed in through origin may
// be used by p now. Password sessions are governed by loadPrincipal alone. A
// session from a Plex connection the account linked itself needs that
// connection and the Plex provider, as before media server sign-in existed;
// a media server session also needs the switches and the administrator rule.
func sessionOriginAllowed(ctx context.Context, db queryRower, p Principal, origin sessionOrigin) error {
	if origin.Kind == "password" {
		return nil
	}
	if origin.Kind == "service" && serviceSignInPermitted(ctx, db, p) != nil {
		return ErrForbidden
	}
	if origin.Kind == "discord" {
		if discordSignInPermitted(ctx, db, p) != nil {
			return ErrForbidden
		}
		// The account must still have the Discord account it signed in with.
		var linked bool
		if err := db.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM user_accounts WHERE uuid=? AND discord_user_id=?)", p.UUID, origin.Discord).Scan(&linked); err != nil || !linked {
			return ErrForbidden
		}
		return nil
	}
	var allowed bool
	var err error
	switch origin.Kind {
	case "service":
		err = db.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM service_accounts sa
		 JOIN service_links l ON l.service_uuid=sa.uuid AND l.link_kind='owner' AND l.user_uuid=?
		 JOIN media_servers m ON m.id=sa.server_id JOIN provider_settings ps ON ps.provider_id=m.service_type
		 WHERE sa.uuid=? AND sa.is_active=1 AND sa.removed_at IS NULL AND m.is_active=1 AND ps.enabled=1 AND m.service_type IN `+serviceSignInTypesSQL+`)`, p.UUID, origin.Service).Scan(&allowed)
	case "plex_connection":
		err = db.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM plex_connections WHERE id=? AND owner_uuid=? AND status='active')
		 AND EXISTS(SELECT 1 FROM provider_settings WHERE provider_id='plex' AND enabled=1)`, origin.PlexConnection, p.UUID).Scan(&allowed)
	}
	if err != nil || !allowed {
		return ErrForbidden
	}
	return nil
}

func (a *App) signInSettingsBody(ctx context.Context) (map[string]any, error) {
	enabled, admins := serviceSignInSettings(ctx, a.store.reader)
	var accounts, adminAccounts int
	err := a.store.reader.QueryRowContext(ctx, `SELECT count(*),count(CASE WHEN EXISTS(SELECT 1 FROM admin_privileges ap JOIN admin_role_permissions rp ON rp.role_id=ap.role_id
	 JOIN admin_permissions perm ON perm.id=rp.permission_id WHERE ap.user_uuid=u.uuid AND perm.name='administrator') THEN 1 END)
	 FROM user_accounts u WHERE u.password_hash IS NULL AND u.is_active=1 AND u.kind='local'`).Scan(&accounts, &adminAccounts)
	return map[string]any{"service_sign_in": enabled, "service_sign_in_admins": admins, "passwordless_accounts": accounts, "passwordless_admins": adminAccounts}, err
}

func (a *App) signInSettings(w http.ResponseWriter, r *http.Request) {
	p, ok := a.principal(w, r, true)
	if !ok {
		return
	}
	if err := a.store.write(r.Context(), func(tx *sql.Tx) error { return notificationAuthority(r.Context(), tx, p.UUID, bearer(r)) }); err != nil {
		domainError(w, err)
		return
	}
	body, err := a.signInSettingsBody(r.Context())
	if err != nil {
		domainError(w, err)
		return
	}
	respond(w, 200, body)
}

func (a *App) saveSignInSettings(w http.ResponseWriter, r *http.Request) {
	p, ok := a.principal(w, r, true)
	if !ok {
		return
	}
	var input struct {
		Enabled *bool `json:"service_sign_in"`
		Admins  *bool `json:"service_sign_in_admins"`
	}
	if !decodeStrictBody(w, r, &input) {
		return
	}
	if input.Enabled == nil || input.Admins == nil {
		fail(w, 400, "INVALID_SETTINGS", "Send service_sign_in and service_sign_in_admins")
		return
	}
	value := func(b bool) string {
		if b {
			return "true"
		}
		return "false"
	}
	err := a.store.write(r.Context(), func(tx *sql.Tx) error {
		if err := notificationAuthority(r.Context(), tx, p.UUID, bearer(r)); err != nil {
			return err
		}
		if err := putSetting(r.Context(), tx, "SERVICE_SIGN_IN", value(*input.Enabled)); err != nil {
			return err
		}
		if err := putSetting(r.Context(), tx, "SERVICE_SIGN_IN_ADMINS", value(*input.Admins)); err != nil {
			return err
		}
		details, _ := json.Marshal(map[string]bool{"service_sign_in": *input.Enabled, "service_sign_in_admins": *input.Admins})
		_, err := tx.ExecContext(r.Context(), "INSERT INTO audit_events(actor_uuid,action,details,occurred_at) VALUES(?,'settings.sign_in.save',?,?)", p.UUID, string(details), utcTimestamp(time.Now()))
		return err
	})
	if err != nil {
		domainError(w, err)
		return
	}
	body, err := a.signInSettingsBody(r.Context())
	if err != nil {
		domainError(w, err)
		return
	}
	respond(w, 200, body)
}
