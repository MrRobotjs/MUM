package main

import (
	"database/sql"
	"encoding/json"
	"errors"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func displayBody(user string, revision int64, mode, clock string, zone any) map[string]any {
	return map[string]any{"expected_user_uuid": user, "profile_revision": revision, "display": map[string]any{"mode": mode, "time_format": clock, "time_zone": zone}}
}

func TestAccountDisplayDefaultsModesAndIndependentCounter(t *testing.T) {
	a, s := testApp(t)
	token, _ := bootstrapOwner(t, a)
	owner, _ := s.Authenticate(t.Context(), token)
	w := apiRequest(a, "GET", "/api/account/display", token, nil, nil)
	p := responseData(t, w)
	if w.Code != 200 || p["user_uuid"] != owner.UUID || p["profile_revision"] != float64(1) || p["display"].(map[string]any)["mode"] != "device" {
		t.Fatal(w.Code, p)
	}
	if w := apiRequest(a, "PUT", "/api/account/preferences", token, preferencesBody(owner.UUID, 1, true, true), nil); w.Code != 200 {
		t.Fatal(w.Code)
	}
	for i, mode := range []string{"utc", "named", "device"} {
		var zone any
		if mode == "named" {
			zone = "America/Denver"
		}
		w = apiRequest(a, "PUT", "/api/account/display", token, displayBody(owner.UUID, int64(i+2), mode, "24", zone), nil)
		if w.Code != 200 || responseData(t, w)["profile_revision"] != float64(i+3) || responseData(t, w)["display"].(map[string]any)["mode"] != mode {
			t.Fatal(w.Code, w.Body.String())
		}
	}
	p = responseData(t, apiRequest(a, "GET", "/api/account/preferences", token, nil, nil))
	if p["sync_enabled"] != true || p["preferences"].(map[string]any)["stream_counter"] != true || p["profile_revision"] != float64(5) {
		t.Fatal("display write lost counter state", p)
	}
	if w := apiRequest(a, "PUT", "/api/account/preferences", token, preferencesBody(owner.UUID, 2, false, false), nil); w.Code != 409 {
		t.Fatal("cross-setting stale revision allowed", w.Code)
	}
	if _, err := s.Authenticate(t.Context(), token); err != nil {
		t.Fatal("display setting revoked session", err)
	}
}

func TestAccountDisplayStrictInputAndOrdinaryScope(t *testing.T) {
	a, s := testApp(t)
	admin, _ := bootstrapOwner(t, a)
	owner, _ := s.Authenticate(t.Context(), admin)
	user, err := s.CreateAccount(t.Context(), owner.UUID, "display-reader", "fixture-hash", false)
	if err != nil {
		t.Fatal(err)
	}
	session, err := s.issueSession(t.Context(), user, false)
	if err != nil {
		t.Fatal(err)
	}
	for _, mode := range []string{"anonymous", "target", "revision", "missing-zone", "zone-type", "host-local", "traversal", "unknown-zone", "unknown-field", "clock", "mode", "device-zone", "named-null"} {
		t.Run(mode, func(t *testing.T) {
			body := displayBody(user, 1, "named", "12", "America/Denver")
			v := body["display"].(map[string]any)
			token, want := session.Access, 400
			switch mode {
			case "anonymous":
				token, want = "", 401
			case "target":
				body["expected_user_uuid"], want = owner.UUID, 403
			case "revision":
				body["profile_revision"], want = 99, 409
			case "missing-zone":
				delete(v, "time_zone")
			case "zone-type":
				v["time_zone"] = 42
			case "host-local":
				v["time_zone"] = "Local"
			case "traversal":
				v["time_zone"] = "../etc/passwd"
			case "unknown-zone":
				v["time_zone"] = "Missing/Timezone"
			case "unknown-field":
				v["sync_enabled"] = true
			case "clock":
				v["time_format"] = "auto"
			case "mode":
				v["mode"] = "server"
			case "device-zone":
				v["mode"] = "device"
			case "named-null":
				v["time_zone"] = nil
			}
			if w := apiRequest(a, "PUT", "/api/account/display", token, body, nil); w.Code != want {
				t.Fatal(w.Code, w.Body.String())
			}
		})
	}
	r := httptest.NewRequest("PUT", "/api/account/display", strings.NewReader("{}"))
	r.Header.Set("Origin", "https://foreign.invalid")
	r.Header.Set("Authorization", "Bearer "+session.Access)
	w := httptest.NewRecorder()
	a.ServeHTTP(w, r)
	if w.Code != 403 {
		t.Fatal("cross origin", w.Code)
	}
	if w := apiRequest(a, "PUT", "/api/account/display", session.Access, displayBody(user, 1, "utc", "24", nil), nil); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	p := responseData(t, apiRequest(a, "GET", "/api/account/display?uuid="+owner.UUID, session.Access, nil, nil))
	if p["user_uuid"] != user {
		t.Fatal("foreign actor selected", p)
	}
	p = responseData(t, apiRequest(a, "GET", "/api/account/display", admin, nil, nil))
	if p["profile_revision"] != float64(1) || p["display"].(map[string]any)["mode"] != "device" {
		t.Fatal("owner changed", p)
	}
}

func TestAccountDisplayCommitAuthorityCASAndRollback(t *testing.T) {
	for _, mode := range []string{"logout", "access-expired", "profile-expired", "revision", "raw-changed", "rollback"} {
		t.Run(mode, func(t *testing.T) {
			a, s := testApp(t)
			token, _ := bootstrapOwner(t, a)
			owner, _ := s.Authenticate(t.Context(), token)
			p, raw, err := a.ownDisplaySnapshot(t.Context(), owner.UUID, token)
			if err != nil {
				t.Fatal(err)
			}
			v := accountDisplayValues{Mode: "utc", TimeFormat: "24"}
			encoded, _ := json.Marshal(v)
			prepared := preparedAccountDisplay{owner.UUID, p.Revision, raw, v}
			switch mode {
			case "logout":
				_, err = s.writer.Exec("DELETE FROM app_sessions WHERE user_uuid=?", owner.UUID)
			case "access-expired":
				_, err = s.writer.Exec("UPDATE session_access_tokens SET expires_at='2000-01-01T00:00:00Z'")
			case "profile-expired":
				_, err = s.writer.Exec("UPDATE user_accounts SET access_expires_at='2000-01-01T00:00:00Z' WHERE uuid=?", owner.UUID)
			case "revision":
				_, err = s.writer.Exec("UPDATE user_accounts SET profile_revision=profile_revision+1 WHERE uuid=?", owner.UUID)
			case "raw-changed":
				_, err = s.writer.Exec(`UPDATE user_accounts SET display_preferences='{"mode":"utc","time_format":"12","time_zone":null}' WHERE uuid=?`, owner.UUID)
			}
			if err != nil {
				t.Fatal(err)
			}
			rollback := errors.New("fixture rollback")
			err = s.write(t.Context(), func(tx *sql.Tx) error {
				if _, err := commitAccountDisplay(t.Context(), tx, token, prepared); err != nil {
					return err
				}
				return rollback
			})
			if err == nil || mode == "rollback" && !errors.Is(err, rollback) {
				t.Fatal("invalid commit", err)
			}
			var count int
			if err := s.reader.QueryRow("SELECT count(*) FROM audit_events WHERE action='account.display.save'").Scan(&count); err != nil || count != 0 {
				t.Fatal("partial audit", count, err)
			}
			var saved string
			if err := s.reader.QueryRow("SELECT display_preferences FROM user_accounts WHERE uuid=?", owner.UUID).Scan(&saved); err != nil || saved == string(encoded) {
				t.Fatal("partial display save", err)
			}
		})
	}
}

func TestAccountDisplayStoredMetadataFailsClosed(t *testing.T) {
	for _, raw := range []string{`{"mode":"device","time_format":"12"}`, `{"mode":"named","time_format":"24","time_zone":"Missing/Zone"}`, `{"mode":"utc","time_format":"24","time_zone":null,"role":"owner"}`} {
		t.Run(raw, func(t *testing.T) {
			a, s := testApp(t)
			token, _ := bootstrapOwner(t, a)
			owner, _ := s.Authenticate(t.Context(), token)
			if _, err := s.writer.Exec("UPDATE user_accounts SET display_preferences=? WHERE uuid=?", raw, owner.UUID); err != nil {
				t.Fatal(err)
			}
			for _, method := range []string{"GET", "PUT"} {
				if w := apiRequest(a, method, "/api/account/display", token, displayBody(owner.UUID, 1, "utc", "12", nil), nil); w.Code != 409 {
					t.Fatal("stored metadata overwritten/defaulted", w.Code, w.Body.String())
				}
			}
		})
	}
}

func TestAccountDisplayNamedZoneDST(t *testing.T) {
	zone := "America/Denver"
	if err := validateDisplayZone(accountDisplayValues{Mode: "named", TimeFormat: "24", TimeZone: &zone}); err != nil {
		t.Fatal(err)
	}
	loc, err := time.LoadLocation(zone)
	if err != nil {
		t.Fatal(err)
	}
	for _, sample := range []struct {
		instant string
		offset  int
	}{{"2026-01-15T12:00:00Z", -7 * 3600}, {"2026-07-15T12:00:00Z", -6 * 3600}} {
		stamp, _ := time.Parse(time.RFC3339, sample.instant)
		_, offset := stamp.In(loc).Zone()
		if offset != sample.offset {
			t.Fatal(offset)
		}
	}
}
