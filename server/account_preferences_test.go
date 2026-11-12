package main

import (
	"database/sql"
	"errors"
	"net/http/httptest"
	"strings"
	"testing"
)

func preferencesBody(user string, revision int64, sync, counter bool) map[string]any {
	return map[string]any{"expected_user_uuid": user, "profile_revision": revision, "sync_enabled": sync, "preferences": map[string]any{"stream_counter": counter}}
}
func TestAccountPreferencesDefaultsAndAtomicToggle(t *testing.T) {
	a, s := testApp(t)
	token, _ := bootstrapOwner(t, a)
	owner, _ := s.Authenticate(t.Context(), token)
	w := apiRequest(a, "GET", "/api/account/preferences", token, nil, nil)
	p := responseData(t, w)
	if w.Code != 200 || p["user_uuid"] != owner.UUID || p["sync_enabled"] != false || p["profile_revision"] != float64(1) || p["preferences"].(map[string]any)["stream_counter"] != false {
		t.Fatal(w.Code, p)
	}
	for i, sync := range []bool{true, false} {
		w = apiRequest(a, "PUT", "/api/account/preferences", token, preferencesBody(owner.UUID, int64(i+1), sync, true), nil)
		if w.Code != 200 || responseData(t, w)["sync_enabled"] != sync || responseData(t, w)["profile_revision"] != float64(i+2) {
			t.Fatal(w.Code, w.Body.String())
		}
	}
	w = apiRequest(a, "GET", "/api/account/preferences", token, nil, nil)
	if responseData(t, w)["sync_enabled"] != false || responseData(t, w)["preferences"].(map[string]any)["stream_counter"] != true {
		t.Fatal("disabling discarded snapshot", w.Body.String())
	}
	if _, err := s.Authenticate(t.Context(), token); err != nil {
		t.Fatal("cosmetic setting revoked session")
	}
	var kind string
	if err := s.reader.QueryRow("SELECT kind FROM user_accounts WHERE uuid=?", owner.UUID).Scan(&kind); err != nil || kind != "owner" {
		t.Fatal(err)
	}
}
func TestAccountPreferencesOrdinaryScopeAndStrictFields(t *testing.T) {
	a, s := testApp(t)
	admin, _ := bootstrapOwner(t, a)
	owner, _ := s.Authenticate(t.Context(), admin)
	user, err := s.CreateAccount(t.Context(), owner.UUID, "preference-reader", "fixture-password-hash", false)
	if err != nil {
		t.Fatal(err)
	}
	tokens, err := s.issueSession(t.Context(), user, false)
	if err != nil {
		t.Fatal(err)
	}
	for _, mode := range []string{"anonymous", "target", "revision", "missing-sync", "missing-counter", "counter-type", "timezone", "role"} {
		t.Run(mode, func(t *testing.T) {
			body := preferencesBody(user, 1, true, true)
			token := tokens.Access
			want := 400
			switch mode {
			case "anonymous":
				token = ""
				want = 401
			case "target":
				body["expected_user_uuid"] = owner.UUID
				want = 403
			case "revision":
				body["profile_revision"] = 99
				want = 409
			case "missing-sync":
				delete(body, "sync_enabled")
			case "missing-counter":
				body["preferences"] = map[string]any{}
			case "counter-type":
				body["preferences"] = map[string]any{"stream_counter": "true"}
			case "timezone":
				body["preferences"] = map[string]any{"stream_counter": true, "timezone": "utc"}
			case "role":
				body["is_admin"] = true
			}
			if w := apiRequest(a, "PUT", "/api/account/preferences", token, body, nil); w.Code != want {
				t.Fatal(w.Code, w.Body.String())
			}
		})
	}
	r := httptest.NewRequest("PUT", "/api/account/preferences", strings.NewReader("{}"))
	r.Header.Set("Origin", "https://foreign.invalid")
	r.Header.Set("Authorization", "Bearer "+tokens.Access)
	w := httptest.NewRecorder()
	a.ServeHTTP(w, r)
	if w.Code != 403 {
		t.Fatal("cross-origin save")
	}
	if w := apiRequest(a, "PUT", "/api/account/preferences", tokens.Access, preferencesBody(user, 1, true, true), nil); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	p := responseData(t, apiRequest(a, "GET", "/api/account/preferences?uuid="+owner.UUID, tokens.Access, nil, nil))
	if p["user_uuid"] != user {
		t.Fatal("query selected another actor")
	}
	var untouched bool
	if err := s.reader.QueryRow("SELECT sync_preferences=0 AND user_preferences IS NULL AND profile_revision=1 FROM user_accounts WHERE uuid=?", owner.UUID).Scan(&untouched); err != nil || !untouched {
		t.Fatal("other user changed", err)
	}
}
func TestAccountPreferencesAuthorityRevisionAndRollback(t *testing.T) {
	for _, mode := range []string{"logout", "expiry", "stale", "rollback"} {
		t.Run(mode, func(t *testing.T) {
			a, s := testApp(t)
			token, _ := bootstrapOwner(t, a)
			owner, _ := s.Authenticate(t.Context(), token)
			var err error
			switch mode {
			case "logout":
				_, err = s.writer.Exec("DELETE FROM app_sessions WHERE user_uuid=?", owner.UUID)
			case "expiry":
				_, err = s.writer.Exec("UPDATE session_access_tokens SET expires_at='2000-01-01T00:00:00Z'")
			case "stale":
				_, err = s.writer.Exec("UPDATE user_accounts SET profile_revision=2 WHERE uuid=?", owner.UUID)
			}
			if err != nil {
				t.Fatal(err)
			}
			rollback := errors.New("fixture rollback after preference and audit writes")
			err = s.write(t.Context(), func(tx *sql.Tx) error {
				if _, err := commitAccountPreferences(t.Context(), tx, owner.UUID, token, 1, true, accountPreferenceValues{StreamCounter: true}); err != nil {
					return err
				}
				if mode == "rollback" {
					return rollback
				}
				return nil
			})
			if err == nil {
				t.Fatal("invalid/rolled-back save committed")
			}
			var unchanged bool
			if err := s.reader.QueryRow("SELECT user_preferences IS NULL AND sync_preferences=0 FROM user_accounts WHERE uuid=?", owner.UUID).Scan(&unchanged); err != nil || !unchanged {
				t.Fatal("partial preference save", err)
			}
			if mode == "rollback" {
				if !errors.Is(err, rollback) {
					t.Fatal(err)
				}
				if _, err := s.Authenticate(t.Context(), token); err != nil {
					t.Fatal(err)
				}
			}
		})
	}
}
func TestAccountPreferencesUnknownStoredMetadataFailsClosed(t *testing.T) {
	for _, raw := range []string{`{"timezone":"utc"}`, `{"stream_counter":"yes"}`, `{"stream_counter":true,"permissions":["administrator"]}`} {
		t.Run(raw, func(t *testing.T) {
			a, s := testApp(t)
			token, _ := bootstrapOwner(t, a)
			owner, _ := s.Authenticate(t.Context(), token)
			if _, err := s.writer.Exec("UPDATE user_accounts SET user_preferences=? WHERE uuid=?", raw, owner.UUID); err != nil {
				t.Fatal(err)
			}
			if w := apiRequest(a, "GET", "/api/account/preferences", token, nil, nil); w.Code != 409 {
				t.Fatal("bad metadata defaulted", w.Code, w.Body.String())
			}
			if w := apiRequest(a, "PUT", "/api/account/preferences", token, preferencesBody(owner.UUID, 1, false, false), nil); w.Code != 409 {
				t.Fatal("unknown metadata overwritten", w.Code)
			}
		})
	}
}
func TestAccountPreferencesCompetingAndCrossProfileRevision(t *testing.T) {
	a, s := testApp(t)
	token, _ := bootstrapOwner(t, a)
	owner, _ := s.Authenticate(t.Context(), token)
	if w := apiRequest(a, "PUT", "/api/account/preferences", token, preferencesBody(owner.UUID, 1, true, true), nil); w.Code != 200 {
		t.Fatal(w.Code)
	}
	if w := apiRequest(a, "PUT", "/api/account/preferences", token, preferencesBody(owner.UUID, 1, false, false), nil); w.Code != 409 {
		t.Fatal("stale competing snapshot committed", w.Code)
	}
	if w := apiRequest(a, "PATCH", "/api/account/email", token, emailBody(owner.UUID, "a-strong-new-password", "contact@example.com", 1), nil); w.Code != 409 {
		t.Fatal("stale contact revision committed", w.Code)
	}
	var count int
	if err := s.reader.QueryRow("SELECT count(*) FROM audit_events WHERE action='account.preferences.save'").Scan(&count); err != nil || count != 1 {
		t.Fatal("duplicate audit", count, err)
	}
}
