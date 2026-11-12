package main

import (
	"context"
	"database/sql"
	"errors"
	"net/http"
	"time"
)

var errCurrentAccountPassword = errors.New("current local password is invalid")

type preparedAccountPassword struct{ user, access, previous, replacement string }

func accountPasswordAuthority(ctx context.Context, tx *sql.Tx, user, access string) (string, error) {
	if len(access) != 43 {
		return "", ErrForbidden
	}
	now := utcTimestamp(time.Now())
	var hash string
	err := tx.QueryRowContext(ctx, `SELECT coalesce(u.password_hash,'') FROM app_sessions s JOIN session_access_tokens t ON t.session_id=s.id JOIN user_accounts u ON u.uuid=s.user_uuid WHERE u.uuid=? AND t.token_hash=? AND t.expires_at>? AND s.refresh_expires_at>?`, user, tokenHash(access), now, now).Scan(&hash)
	if err != nil || hash == "" {
		return "", ErrForbidden
	}
	if _, err := loadPrincipal(ctx, tx, user); err != nil {
		return "", err
	}
	return hash, nil
}

func (a *App) prepareAccountPassword(ctx context.Context, user, access, current, replacement string) (preparedAccountPassword, error) {
	p := preparedAccountPassword{user: user, access: access}
	err := a.store.write(ctx, func(tx *sql.Tx) error {
		var err error
		p.previous, err = accountPasswordAuthority(ctx, tx, user, access)
		return err
	})
	if err != nil {
		return p, err
	}
	if !verifyPassword(p.previous, current) {
		return p, errCurrentAccountPassword
	}
	// Both KDF operations remain outside the serialized SQLite writer.
	p.replacement, err = hashPassword(replacement)
	return p, err
}

func commitAccountPassword(ctx context.Context, tx *sql.Tx, p preparedAccountPassword) error {
	current, err := accountPasswordAuthority(ctx, tx, p.user, p.access)
	if err != nil {
		return err
	}
	if current != p.previous || p.replacement == "" {
		return ErrConflict
	}
	result, err := tx.ExecContext(ctx, "UPDATE user_accounts SET password_hash=?,force_password_change=0,profile_revision=profile_revision+1,updated_at=? WHERE uuid=? AND password_hash=?", p.replacement, utcTimestamp(time.Now()), p.user, p.previous)
	if err != nil {
		return err
	}
	if n, _ := result.RowsAffected(); n != 1 {
		return ErrConflict
	}
	if _, err := tx.ExecContext(ctx, "DELETE FROM app_sessions WHERE user_uuid=?", p.user); err != nil {
		return err
	}
	return auditAction(ctx, tx, p.user, "account.password.change")
}

func (a *App) changeAccountPassword(w http.ResponseWriter, r *http.Request) {
	actor, ok := a.principal(w, r, false)
	if !ok {
		return
	}
	var input struct {
		User        string `json:"expected_user_uuid"`
		Current     string `json:"current_password"`
		Replacement string `json:"new_password"`
		Confirm     string `json:"confirm_password"`
		Revoke      bool   `json:"acknowledge_revoke_sessions"`
	}
	if !decodeStrictBody(w, r, &input) {
		return
	}
	if input.User != actor.UUID {
		domainError(w, ErrForbidden)
		return
	}
	if !input.Revoke || len(input.Current) < 12 || len(input.Current) > 1024 || len(input.Replacement) < 12 || len(input.Replacement) > 1024 || input.Replacement != input.Confirm || input.Replacement == input.Current {
		fail(w, 400, "INVALID_PASSWORD_CHANGE", "Provide matching different passwords of 12–1024 bytes and acknowledge signing out all sessions")
		return
	}
	if !a.passwordAdmission(w, r) {
		return
	}
	defer func() { <-a.passwordSlots }()
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()
	p, err := a.prepareAccountPassword(ctx, actor.UUID, bearer(r), input.Current, input.Replacement)
	if err == nil {
		err = a.store.write(ctx, func(tx *sql.Tx) error { return commitAccountPassword(ctx, tx, p) })
	}
	if errors.Is(err, errCurrentAccountPassword) {
		fail(w, 403, "CURRENT_PASSWORD_INVALID", "Current local password could not be verified")
		return
	}
	if err != nil {
		domainError(w, err)
		return
	}
	a.hub.closeAccountConnections(actor.UUID)
	http.SetCookie(w, &http.Cookie{Name: "mum_refresh", Path: "/api/auth", Value: "", MaxAge: -1, HttpOnly: true, Secure: a.secureCookie(r), SameSite: http.SameSiteStrictMode})
	respond(w, 200, map[string]any{"user_uuid": actor.UUID, "password_changed": true, "sessions_revoked": true, "reauthentication_required": true})
}
