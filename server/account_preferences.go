package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"time"
)

type accountPreferenceValues struct {
	StreamCounter bool `json:"stream_counter"`
}
type accountPreferenceRecord struct {
	User     string                  `json:"user_uuid"`
	Revision int64                   `json:"profile_revision"`
	Sync     bool                    `json:"sync_enabled"`
	Values   accountPreferenceValues `json:"preferences"`
}

func accountPreferenceAuthority(ctx context.Context, tx *sql.Tx, user, access string) error {
	if len(access) != 43 {
		return ErrForbidden
	}
	var current string
	now := utcTimestamp(time.Now())
	if err := tx.QueryRowContext(ctx, `SELECT s.user_uuid FROM app_sessions s JOIN session_access_tokens t ON t.session_id=s.id WHERE t.token_hash=? AND t.expires_at>? AND s.refresh_expires_at>?`, tokenHash(access), now, now).Scan(&current); err != nil || current != user {
		return ErrForbidden
	}
	_, err := loadPrincipal(ctx, tx, user)
	return err
}
func readAccountPreferences(ctx context.Context, tx *sql.Tx, user string) (accountPreferenceRecord, error) {
	p := accountPreferenceRecord{User: user}
	var raw sql.NullString
	if err := tx.QueryRowContext(ctx, "SELECT profile_revision,sync_preferences,user_preferences FROM user_accounts WHERE uuid=?", user).Scan(&p.Revision, &p.Sync, &raw); err != nil {
		return p, err
	}
	if !raw.Valid {
		if p.Sync {
			return p, ErrConflict
		}
		return p, nil
	}
	if len(raw.String) > 1024 {
		return p, ErrConflict
	}
	var values struct {
		StreamCounter *bool `json:"stream_counter"`
	}
	decoder := json.NewDecoder(strings.NewReader(raw.String))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&values) != nil || values.StreamCounter == nil {
		return p, ErrConflict
	}
	var extra any
	if decoder.Decode(&extra) != io.EOF {
		return p, ErrConflict
	}
	p.Values.StreamCounter = *values.StreamCounter
	return p, nil
}
func (a *App) accountPreferences(w http.ResponseWriter, r *http.Request) {
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
	p, err := readAccountPreferences(r.Context(), tx, actor.UUID)
	if err == nil {
		err = tx.Commit()
	}
	if err != nil {
		domainError(w, err)
		return
	}
	respond(w, 200, p)
}
func commitAccountPreferences(ctx context.Context, tx *sql.Tx, user, access string, revision int64, sync bool, values accountPreferenceValues) (accountPreferenceRecord, error) {
	if err := accountPreferenceAuthority(ctx, tx, user, access); err != nil {
		return accountPreferenceRecord{}, err
	}
	p, err := readAccountPreferences(ctx, tx, user)
	if err != nil {
		return p, err
	}
	if revision < 1 || p.Revision != revision {
		return p, ErrConflict
	}
	encoded, err := json.Marshal(values)
	if err != nil {
		return p, err
	}
	result, err := tx.ExecContext(ctx, "UPDATE user_accounts SET sync_preferences=?,user_preferences=?,profile_revision=profile_revision+1,updated_at=? WHERE uuid=? AND profile_revision=?", sync, string(encoded), utcTimestamp(time.Now()), user, revision)
	if err != nil {
		return p, err
	}
	if n, _ := result.RowsAffected(); n != 1 {
		return p, ErrConflict
	}
	if err := auditAction(ctx, tx, user, "account.preferences.save"); err != nil {
		return p, err
	}
	p.Revision++
	p.Sync = sync
	p.Values = values
	return p, nil
}
func (a *App) saveAccountPreferences(w http.ResponseWriter, r *http.Request) {
	actor, ok := a.principal(w, r, false)
	if !ok {
		return
	}
	var input struct {
		User     string `json:"expected_user_uuid"`
		Revision int64  `json:"profile_revision"`
		Sync     *bool  `json:"sync_enabled"`
		Values   *struct {
			StreamCounter *bool `json:"stream_counter"`
		} `json:"preferences"`
	}
	if !decodeStrictBody(w, r, &input) {
		return
	}
	if input.User != actor.UUID {
		domainError(w, ErrForbidden)
		return
	}
	if input.Revision < 1 || input.Sync == nil || input.Values == nil || input.Values.StreamCounter == nil {
		fail(w, 400, "INVALID_PREFERENCES", "Provide the current revision, explicit sync flag and stream_counter boolean")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	var result accountPreferenceRecord
	err := a.store.write(ctx, func(tx *sql.Tx) error {
		var err error
		result, err = commitAccountPreferences(ctx, tx, actor.UUID, bearer(r), input.Revision, *input.Sync, accountPreferenceValues{StreamCounter: *input.Values.StreamCounter})
		return err
	})
	if err != nil {
		domainError(w, err)
		return
	}
	respond(w, 200, result)
}
