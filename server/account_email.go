package main

import (
	"context"
	"database/sql"
	"errors"
	"net/http"
	"net/mail"
	"strings"
	"time"
)

// Contact metadata only. Verification/recovery/login authority is not inferred.
func normalizeAccountEmail(value string) (string, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return "", nil
	}
	if len(value) > 254 || strings.ContainsAny(value, "\"\\<>") {
		return "", ErrConflict
	}
	for _, c := range []byte(value) {
		if c < 33 || c > 126 {
			return "", ErrConflict
		}
	}
	address, err := mail.ParseAddress(value)
	if err != nil || address.Address != value || strings.Count(value, "@") != 1 {
		return "", ErrConflict
	}
	local, domain, _ := strings.Cut(value, "@")
	if len(local) > 64 {
		return "", ErrConflict
	}
	for _, label := range strings.Split(domain, ".") {
		if len(label) < 1 || len(label) > 63 || label[0] == '-' || label[len(label)-1] == '-' {
			return "", ErrConflict
		}
		for _, c := range []byte(label) {
			if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '-') {
				return "", ErrConflict
			}
		}
	}
	return local + "@" + strings.ToLower(domain), nil
}

type preparedAccountEmail struct {
	user, access, credential, email string
	revision                        int64
}

func (a *App) prepareAccountEmail(ctx context.Context, user, access, password, email string, revision int64) (preparedAccountEmail, error) {
	p := preparedAccountEmail{user: user, access: access, email: email, revision: revision}
	err := a.store.write(ctx, func(tx *sql.Tx) error {
		var err error
		p.credential, err = accountPasswordAuthority(ctx, tx, user, access)
		if err != nil {
			return err
		}
		var current int64
		if err := tx.QueryRowContext(ctx, "SELECT profile_revision FROM user_accounts WHERE uuid=?", user).Scan(&current); err != nil {
			return err
		}
		if current != revision {
			return ErrConflict
		}
		return nil
	})
	if err != nil {
		return p, err
	}
	if !verifyPassword(p.credential, password) {
		return p, errCurrentAccountPassword
	}
	return p, nil
}
func commitAccountEmail(ctx context.Context, tx *sql.Tx, p preparedAccountEmail) error {
	credential, err := accountPasswordAuthority(ctx, tx, p.user, p.access)
	if err != nil {
		return err
	}
	if credential != p.credential {
		return ErrConflict
	}
	canonical, err := normalizeAccountEmail(p.email)
	if err != nil || canonical != p.email || p.revision < 1 {
		return ErrConflict
	}
	result, err := tx.ExecContext(ctx, "UPDATE user_accounts SET email=nullif(?,''),profile_revision=profile_revision+1,updated_at=? WHERE uuid=? AND profile_revision=? AND password_hash=?", p.email, utcTimestamp(time.Now()), p.user, p.revision, p.credential)
	if err != nil {
		return err
	}
	if n, _ := result.RowsAffected(); n != 1 {
		return ErrConflict
	}
	return auditAction(ctx, tx, p.user, "account.email.change")
}
func (a *App) changeAccountEmail(w http.ResponseWriter, r *http.Request) {
	actor, ok := a.principal(w, r, false)
	if !ok {
		return
	}
	var input struct {
		User        string  `json:"expected_user_uuid"`
		Revision    int64   `json:"profile_revision"`
		Password    string  `json:"current_password"`
		Email       *string `json:"email"`
		Acknowledge bool    `json:"acknowledge_unverified_contact"`
	}
	if !decodeStrictBody(w, r, &input) {
		return
	}
	if input.User != actor.UUID {
		domainError(w, ErrForbidden)
		return
	}
	if input.Email == nil || input.Revision < 1 || len(input.Password) < 12 || len(input.Password) > 1024 || !input.Acknowledge {
		fail(w, 400, "INVALID_EMAIL_CHANGE", "Provide current revision/password, an explicit email or empty string, and contact-email acknowledgment")
		return
	}
	email, err := normalizeAccountEmail(*input.Email)
	if err != nil {
		fail(w, 400, "INVALID_CONTACT_EMAIL", "Use a bare ASCII email address of at most 254 bytes or an empty string to clear it")
		return
	}
	if !a.passwordAdmission(w, r) {
		return
	}
	defer func() { <-a.passwordSlots }()
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()
	p, err := a.prepareAccountEmail(ctx, actor.UUID, bearer(r), input.Password, email, input.Revision)
	if err == nil {
		err = a.store.write(ctx, func(tx *sql.Tx) error { return commitAccountEmail(ctx, tx, p) })
	}
	if errors.Is(err, errCurrentAccountPassword) {
		fail(w, 403, "CURRENT_PASSWORD_INVALID", "Current local password could not be verified")
		return
	}
	if err != nil {
		domainError(w, err)
		return
	}
	var address any
	if email != "" {
		address = email
	}
	respond(w, 200, map[string]any{"user_uuid": actor.UUID, "email": address, "profile_revision": p.revision + 1, "email_verified": false})
}
