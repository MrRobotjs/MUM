package main

import (
	"database/sql"
	"errors"
	"net/http"
)

// editExpiry reports which selected users have an expiration date, so the
// Edit dialog can say whether extending or clearing applies to them before
// anything is prepared. It reads only; Apply rechecks everything.
func (a *App) editExpiry(w http.ResponseWriter, r *http.Request) {
	actor, ok := a.principal(w, r, true)
	if !ok {
		return
	}
	var input struct {
		UUIDs []string `json:"user_uuids"`
	}
	if !decodeStrictBody(w, r, &input) {
		return
	}
	if len(input.UUIDs) == 0 || len(input.UUIDs) > 500 {
		fail(w, 400, "INVALID_SELECTION", "Select 1–500 users")
		return
	}
	seen := map[string]bool{}
	for _, id := range input.UUIDs {
		if !validAdminMemberCursor(id) || seen[id] {
			fail(w, 400, "INVALID_SELECTION", "Select each valid user once")
			return
		}
		seen[id] = true
	}
	tx, err := a.store.reader.BeginTx(r.Context(), &sql.TxOptions{ReadOnly: true})
	if err != nil {
		domainError(w, err)
		return
	}
	defer tx.Rollback()
	if err := requirePermission(r.Context(), tx, actor.UUID, "administrator"); err != nil {
		domainError(w, err)
		return
	}
	type userExpiry struct {
		UUID    string  `json:"uuid"`
		Expires *string `json:"access_expires_at"`
	}
	users := make([]userExpiry, 0, len(input.UUIDs))
	for _, id := range input.UUIDs {
		var expires sql.NullString
		err := tx.QueryRowContext(r.Context(), `SELECT coalesce((SELECT access_expires_at FROM service_accounts WHERE uuid=?1),(SELECT access_expires_at FROM user_accounts WHERE uuid=?1)) FROM identities WHERE uuid=?1`, id).Scan(&expires)
		if errors.Is(err, sql.ErrNoRows) {
			continue // Deleted since it was selected; Apply reports it.
		}
		if err != nil {
			domainError(w, err)
			return
		}
		user := userExpiry{UUID: id}
		if expires.Valid {
			user.Expires = &expires.String
		}
		users = append(users, user)
	}
	respond(w, 200, map[string]any{"users": users})
}
