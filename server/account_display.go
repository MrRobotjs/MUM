package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"time"
	_ "time/tzdata"
)

// Display settings are account-wide. Device mode resolves the zone in each
// browser; the separate stream-counter sync flag does not govern these values.
type accountDisplayValues struct {
	Mode       string  `json:"mode"`
	TimeFormat string  `json:"time_format"`
	TimeZone   *string `json:"time_zone"`
}

type accountDisplayRecord struct {
	User     string               `json:"user_uuid"`
	Revision int64                `json:"profile_revision"`
	Display  accountDisplayValues `json:"display"`
}

func validDisplayShape(v accountDisplayValues) bool {
	if v.TimeFormat != "12" && v.TimeFormat != "24" {
		return false
	}
	if v.Mode == "device" || v.Mode == "utc" {
		return v.TimeZone == nil
	}
	if v.Mode != "named" || v.TimeZone == nil {
		return false
	}
	zone := *v.TimeZone
	if len(zone) < 1 || len(zone) > 128 || zone == "Local" || strings.HasPrefix(zone, "/") || strings.Contains(zone, "..") {
		return false
	}
	for _, c := range zone {
		if !(c >= 'A' && c <= 'Z' || c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || strings.ContainsRune("/_+-", c)) {
			return false
		}
	}
	return true
}

// LoadLocation can consult the filesystem before embedded tzdata. Call only
// outside database transactions, especially the serialized writer.
func validateDisplayZone(v accountDisplayValues) error {
	if !validDisplayShape(v) {
		return ErrConflict
	}
	if v.Mode == "named" {
		if _, err := time.LoadLocation(*v.TimeZone); err != nil {
			return ErrConflict
		}
	}
	return nil
}

func readAccountDisplay(ctx context.Context, tx *sql.Tx, user string) (accountDisplayRecord, string, error) {
	p := accountDisplayRecord{User: user}
	var raw string
	if err := tx.QueryRowContext(ctx, "SELECT profile_revision,display_preferences FROM user_accounts WHERE uuid=?", user).Scan(&p.Revision, &raw); err != nil {
		return p, raw, err
	}
	var fields struct {
		Mode       string          `json:"mode"`
		TimeFormat string          `json:"time_format"`
		TimeZone   json.RawMessage `json:"time_zone"`
	}
	d := json.NewDecoder(strings.NewReader(raw))
	d.DisallowUnknownFields()
	if len(raw) > 1024 || d.Decode(&fields) != nil || len(fields.TimeZone) == 0 {
		return p, raw, ErrConflict
	}
	var extra any
	if d.Decode(&extra) != io.EOF || json.Unmarshal(fields.TimeZone, &p.Display.TimeZone) != nil {
		return p, raw, ErrConflict
	}
	p.Display.Mode, p.Display.TimeFormat = fields.Mode, fields.TimeFormat
	if !validDisplayShape(p.Display) {
		return p, raw, ErrConflict
	}
	return p, raw, nil
}

func (a *App) ownDisplaySnapshot(ctx context.Context, user, access string) (accountDisplayRecord, string, error) {
	tx, err := a.store.reader.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return accountDisplayRecord{}, "", err
	}
	defer tx.Rollback()
	if err := accountPreferenceAuthority(ctx, tx, user, access); err != nil {
		return accountDisplayRecord{}, "", err
	}
	p, raw, err := readAccountDisplay(ctx, tx, user)
	if err == nil {
		err = tx.Commit()
	}
	if err == nil {
		err = validateDisplayZone(p.Display)
	}
	return p, raw, err
}

func (a *App) accountDisplay(w http.ResponseWriter, r *http.Request) {
	actor, ok := a.principal(w, r, false)
	if !ok {
		return
	}
	p, _, err := a.ownDisplaySnapshot(r.Context(), actor.UUID, bearer(r))
	if err != nil {
		domainError(w, err)
		return
	}
	respond(w, 200, p)
}

// Both the prior snapshot and new zone are validated before writer admission.
// The exact prior bytes and shared revision are rechecked in the transaction.
type preparedAccountDisplay struct {
	User     string
	Revision int64
	Prior    string
	Values   accountDisplayValues
}

func commitAccountDisplay(ctx context.Context, tx *sql.Tx, access string, prepared preparedAccountDisplay) (accountDisplayRecord, error) {
	p := accountDisplayRecord{}
	if err := accountPreferenceAuthority(ctx, tx, prepared.User, access); err != nil {
		return p, err
	}
	current, raw, err := readAccountDisplay(ctx, tx, prepared.User)
	if err != nil {
		return p, err
	}
	if prepared.Revision < 1 || current.Revision != prepared.Revision || raw != prepared.Prior || !validDisplayShape(prepared.Values) {
		return p, ErrConflict
	}
	encoded, err := json.Marshal(prepared.Values)
	if err != nil {
		return p, err
	}
	result, err := tx.ExecContext(ctx, "UPDATE user_accounts SET display_preferences=?,profile_revision=profile_revision+1,updated_at=? WHERE uuid=? AND profile_revision=? AND display_preferences=?", string(encoded), utcTimestamp(time.Now()), prepared.User, prepared.Revision, prepared.Prior)
	if err != nil {
		return p, err
	}
	if n, _ := result.RowsAffected(); n != 1 {
		return p, ErrConflict
	}
	if err := auditAction(ctx, tx, prepared.User, "account.display.save"); err != nil {
		return p, err
	}
	return accountDisplayRecord{User: prepared.User, Revision: prepared.Revision + 1, Display: prepared.Values}, nil
}

func (a *App) saveAccountDisplay(w http.ResponseWriter, r *http.Request) {
	actor, ok := a.principal(w, r, false)
	if !ok {
		return
	}
	var input struct {
		User     string `json:"expected_user_uuid"`
		Revision int64  `json:"profile_revision"`
		Display  *struct {
			Mode       string          `json:"mode"`
			TimeFormat string          `json:"time_format"`
			TimeZone   json.RawMessage `json:"time_zone"`
		} `json:"display"`
	}
	if !decodeStrictBody(w, r, &input) {
		return
	}
	if input.User != actor.UUID {
		domainError(w, ErrForbidden)
		return
	}
	v := accountDisplayValues{}
	if input.Display != nil {
		v.Mode, v.TimeFormat = input.Display.Mode, input.Display.TimeFormat
	}
	if input.Revision < 1 || input.Display == nil || len(input.Display.TimeZone) == 0 || json.Unmarshal(input.Display.TimeZone, &v.TimeZone) != nil || validateDisplayZone(v) != nil {
		fail(w, 400, "INVALID_DISPLAY", "Provide the current revision, device/utc/named mode, 12/24 time format and explicit null or valid IANA time_zone")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	prior, raw, err := a.ownDisplaySnapshot(ctx, actor.UUID, bearer(r))
	if err != nil {
		domainError(w, err)
		return
	}
	if prior.Revision != input.Revision {
		domainError(w, ErrConflict)
		return
	}
	prepared := preparedAccountDisplay{actor.UUID, input.Revision, raw, v}
	var result accountDisplayRecord
	err = a.store.write(ctx, func(tx *sql.Tx) error {
		var err error
		result, err = commitAccountDisplay(ctx, tx, bearer(r), prepared)
		return err
	})
	if err != nil {
		domainError(w, err)
		return
	}
	respond(w, 200, result)
}
