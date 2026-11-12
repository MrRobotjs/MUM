package main

import (
	"context"
	"database/sql"
	"errors"
	"net/http"
	"strings"
	"time"
)

func normalizeAccountUsername(value string) (string, error) {
	value = strings.TrimSpace(value)
	if len(value) < 1 || len(value) > 255 {
		return "", ErrConflict
	}
	// SQLite's existing NOCASE uniqueness folds ASCII, not Unicode case pairs.
	for _, c := range []byte(value) {
		if c < 32 || c > 126 {
			return "", ErrConflict
		}
	}
	return value, nil
}

type accountUsernameRecord struct {
	User      string `json:"user_uuid"`
	Username  string `json:"username"`
	Revision  int64  `json:"profile_revision"`
	Available bool   `json:"username_change_available"`
	Initial   bool   `json:"initial_credentials_available"`
}

func (a *App) accountUsername(w http.ResponseWriter, r *http.Request) {
	actor, ok := a.principal(w, r, false)
	if !ok {
		return
	}
	tx, err := a.store.reader.BeginTx(r.Context(), &sql.TxOptions{ReadOnly: true})
	if err != nil {
		domainError(w, err)
		return
	}
	defer tx.Rollback()
	if err := accountPreferenceAuthority(r.Context(), tx, actor.UUID, bearer(r)); err != nil {
		domainError(w, err)
		return
	}
	p := accountUsernameRecord{User: actor.UUID}
	err = tx.QueryRowContext(r.Context(), "SELECT coalesce(local_username,''),profile_revision,password_hash IS NOT NULL AND password_hash<>'' AND local_username IS NOT NULL AND local_username<>'' FROM user_accounts WHERE uuid=?", actor.UUID).Scan(&p.Username, &p.Revision, &p.Available)
	if err == nil {
		err = tx.Commit()
	}
	if err != nil {
		domainError(w, err)
		return
	}
	// No current HTTP authentication path establishes passwordless ownership.
	// A connected provider account is not an initial-credential authorization.
	respond(w, 200, p)
}

type preparedAccountUsername struct {
	user, access, credential, previous, replacement string
	revision                                        int64
}

func (a *App) prepareAccountUsername(ctx context.Context, user, access, password, replacement string, revision int64) (preparedAccountUsername, error) {
	p := preparedAccountUsername{user: user, access: access, replacement: replacement, revision: revision}
	err := a.store.write(ctx, func(tx *sql.Tx) error {
		var err error
		p.credential, err = accountPasswordAuthority(ctx, tx, user, access)
		if err != nil {
			return err
		}
		var current int64
		if err := tx.QueryRowContext(ctx, "SELECT coalesce(local_username,''),profile_revision FROM user_accounts WHERE uuid=?", user).Scan(&p.previous, &current); err != nil {
			return err
		}
		if current != revision || p.previous == "" {
			return ErrConflict
		}
		return nil
	})
	if err == nil && !verifyPassword(p.credential, password) {
		err = errCurrentAccountPassword
	}
	return p, err
}

func commitAccountUsername(ctx context.Context, tx *sql.Tx, p preparedAccountUsername) error {
	credential, err := accountPasswordAuthority(ctx, tx, p.user, p.access)
	if err != nil {
		return err
	}
	canonical, err := normalizeAccountUsername(p.replacement)
	if err != nil || canonical != p.replacement || credential != p.credential || p.revision < 1 || p.previous == "" || p.previous == p.replacement {
		return ErrConflict
	}
	var previous string
	var revision int64
	if err := tx.QueryRowContext(ctx, "SELECT coalesce(local_username,''),profile_revision FROM user_accounts WHERE uuid=?", p.user).Scan(&previous, &revision); err != nil {
		return err
	}
	if previous != p.previous || revision != p.revision {
		return ErrConflict
	}
	var duplicate bool
	if err := tx.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM user_accounts WHERE local_username=? AND uuid<>?)", p.replacement, p.user).Scan(&duplicate); err != nil {
		return err
	}
	if duplicate {
		return ErrConflict
	}
	result, err := tx.ExecContext(ctx, "UPDATE user_accounts SET local_username=?,profile_revision=profile_revision+1,updated_at=? WHERE uuid=? AND profile_revision=? AND password_hash=?", p.replacement, utcTimestamp(time.Now()), p.user, p.revision, p.credential)
	if err != nil {
		return err
	}
	if n, _ := result.RowsAffected(); n != 1 {
		return ErrConflict
	}
	if _, err := tx.ExecContext(ctx, "DELETE FROM app_sessions WHERE user_uuid=?", p.user); err != nil {
		return err
	}
	return auditAction(ctx, tx, p.user, "account.username.change")
}

func (a *App) changeAccountUsername(w http.ResponseWriter, r *http.Request) {
	actor, ok := a.principal(w, r, false)
	if !ok {
		return
	}
	var input struct {
		User     string `json:"expected_user_uuid"`
		Revision int64  `json:"profile_revision"`
		Password string `json:"current_password"`
		Username string `json:"username"`
		Revoke   bool   `json:"acknowledge_revoke_sessions"`
	}
	if !decodeStrictBody(w, r, &input) {
		return
	}
	if input.User != actor.UUID {
		domainError(w, ErrForbidden)
		return
	}
	username, err := normalizeAccountUsername(input.Username)
	if err != nil || input.Revision < 1 || len(input.Password) < 12 || len(input.Password) > 1024 || !input.Revoke {
		fail(w, 400, "INVALID_USERNAME_CHANGE", "Provide the current revision/password, a username of 1–255 printable ASCII bytes and all-session sign-out acknowledgment")
		return
	}
	if !a.passwordAdmission(w, r) {
		return
	}
	defer func() { <-a.passwordSlots }()
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()
	p, err := a.prepareAccountUsername(ctx, actor.UUID, bearer(r), input.Password, username, input.Revision)
	if err == nil {
		err = a.store.write(ctx, func(tx *sql.Tx) error { return commitAccountUsername(ctx, tx, p) })
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
	respond(w, 200, map[string]any{"user_uuid": actor.UUID, "username": username, "profile_revision": p.revision + 1, "sessions_revoked": true, "reauthentication_required": true})
}
