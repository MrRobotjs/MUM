package main

import (
	"database/sql"
	"net/http"
)

// Current personal view exposes protected password and contact-email capabilities.
// Bulk profile/preferences editing remains unavailable until its own handlers exist.
func (a *App) accountProfile(w http.ResponseWriter, r *http.Request) {
	owner, ok := a.principal(w, r, false)
	if !ok {
		return
	}
	var username string
	var email, lastLogin sql.NullString
	var hasPassword, forcePassword, plexEnabled bool
	var revision int64
	err := a.store.reader.QueryRowContext(r.Context(), `SELECT coalesce(local_username,''),email,last_login_at,password_hash IS NOT NULL,force_password_change,(SELECT enabled FROM provider_settings WHERE provider_id='plex'),profile_revision FROM user_accounts WHERE uuid=?`, owner.UUID).Scan(&username, &email, &lastLogin, &hasPassword, &forcePassword, &plexEnabled, &revision)
	if err != nil {
		domainError(w, err)
		return
	}
	var address, login any
	if email.Valid {
		address = email.String
	}
	if lastLogin.Valid {
		login = lastLogin.String
	}
	respond(w, 200, map[string]any{"uuid": owner.UUID, "username": username, "email": address, "user_type": owner.Kind, "has_password": hasPassword, "force_password_change": forcePassword, "last_login_at": login, "plex_authorization_enabled": plexEnabled, "profile_changes_available": false, "password_change_available": hasPassword, "email_change_available": hasPassword, "profile_revision": revision, "email_verified": false})
}
