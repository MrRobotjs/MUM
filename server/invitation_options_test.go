package main

import (
	"encoding/json"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"
)

func itoa(n int64) string { return strconv.FormatInt(n, 10) }

func responseList(t *testing.T, w *httptest.ResponseRecorder) []map[string]any {
	t.Helper()
	var body struct{ Data []map[string]any }
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	return body.Data
}

// Flask parity for invitation options: no expiry, unlimited uses, a custom
// path and a membership duration. The card label is the code's first 12
// characters; the full code stays behind the share-link read.
func TestInvitationOptionalLimitsCustomPathAndMembership(t *testing.T) {
	a, s := testApp(t)
	admin, _ := bootstrapOwner(t, a)
	fixture := newProvisioningFixture(t, "")
	_, _, servers := prepareInvitation(t, a, admin, fixture)
	grants := []InvitationGrant{{ServerID: servers[0], LibraryIDs: []string{"movies"}}}

	w := apiRequest(a, "POST", "/api/invitations", admin, map[string]any{"expires_at": nil, "max_uses": nil, "custom_path": "friends-2026", "membership_duration_days": 30, "grants": grants}, nil)
	if w.Code != 201 {
		t.Fatal(w.Code, w.Body.String())
	}
	created := responseData(t, w)
	id, token := int64(created["id"].(float64)), created["token"].(string)
	if created["expires_at"] != nil || created["max_uses"] != nil || created["custom_path"] != "friends-2026" || created["membership_duration_days"] != float64(30) {
		t.Fatal(created)
	}

	w = apiRequest(a, "GET", "/api/invitations", admin, nil, nil)
	if w.Code != 200 || strings.Contains(w.Body.String(), token) {
		t.Fatal("listing must not contain the full code", w.Code)
	}
	var row map[string]any
	for _, item := range responseList(t, w) {
		if item["id"] == float64(id) {
			row = item
		}
	}
	if row == nil || row["token_prefix"] != token[:12] || row["expires_at"] != nil || row["max_uses"] != nil || row["custom_path"] != "friends-2026" || row["membership_duration_days"] != float64(30) {
		t.Fatal(row)
	}

	// The share link uses the custom path, and the path resolves to the code.
	if w := apiRequest(a, "GET", "/api/invitations/"+itoa(id)+"/share-link", admin, nil, nil); w.Code != 200 || responseData(t, w)["path"] != "/invite/friends-2026" {
		t.Fatal(w.Code, w.Body.String())
	}
	if w := apiRequest(a, "GET", "/api/public/invitation-paths/friends-2026", "", nil, nil); w.Code != 200 || responseData(t, w)["token"] != token {
		t.Fatal(w.Code, w.Body.String())
	}
	if w := apiRequest(a, "GET", "/api/public/invitation-paths/nobody-here", "", nil, nil); w.Code != 404 {
		t.Fatal("unknown path", w.Code)
	}
	// The wizard tries the address as a code first and resolves a custom path
	// only after "not found".
	if w := apiRequest(a, "GET", "/api/public/invitations/friends-2026", "", nil, nil); w.Code != 404 {
		t.Fatal("custom path must not be found as a code", w.Code)
	}
	public := apiRequest(a, "GET", "/api/public/invitations/"+token, "", nil, nil)
	if public.Code != 200 || responseData(t, public)["expires_at"] != nil || responseData(t, public)["max_uses"] != nil {
		t.Fatal("never-expiring unlimited invite unavailable", public.Code, public.Body.String())
	}

	// Paths are unique and follow Flask's rule.
	if w := apiRequest(a, "POST", "/api/invitations", admin, map[string]any{"custom_path": "friends-2026", "grants": grants}, nil); w.Code != 409 {
		t.Fatal("duplicate path", w.Code, w.Body.String())
	}
	for _, bad := range []string{"ab", "has space", strings.Repeat("a", 43)} {
		if w := apiRequest(a, "POST", "/api/invitations", admin, map[string]any{"custom_path": bad, "grants": grants}, nil); w.Code != 400 {
			t.Fatal("invalid path accepted", bad, w.Code)
		}
	}
	for _, body := range []map[string]any{{"max_uses": -1}, {"membership_duration_days": 36501}, {"expires_at": time.Now().Add(-time.Hour).UTC().Format(time.RFC3339Nano)}} {
		body["grants"] = grants
		if w := apiRequest(a, "POST", "/api/invitations", admin, body, nil); w.Code != 400 {
			t.Fatal("invalid option accepted", body, w.Code)
		}
	}

	// Joining sets the membership expiry on the new account and its service account.
	if w := apiRequest(a, "POST", "/api/public/invitations/"+token+"/redeem", "", redeemBody("Member Thirty", newUUID()), nil); w.Code != 201 {
		t.Fatal(w.Code, w.Body.String())
	}
	var local, service string
	if err := s.reader.QueryRow("SELECT coalesce(access_expires_at,'') FROM user_accounts WHERE local_username='Member Thirty'").Scan(&local); err != nil {
		t.Fatal(err)
	}
	if err := s.reader.QueryRow("SELECT coalesce(a.access_expires_at,'') FROM service_accounts a JOIN service_links l ON l.service_uuid=a.uuid JOIN user_accounts u ON u.uuid=l.user_uuid WHERE u.local_username='Member Thirty'").Scan(&service); err != nil {
		t.Fatal(err)
	}
	for _, value := range []string{local, service} {
		at, err := time.Parse(time.RFC3339Nano, value)
		if err != nil || at.Sub(time.Now().AddDate(0, 0, 30)).Abs() > time.Minute {
			t.Fatal("membership expiry not about 30 days out", value)
		}
	}
	// Unlimited: the invite is still open after a use.
	if w := apiRequest(a, "GET", "/api/public/invitations/"+token, "", nil, nil); w.Code != 200 {
		t.Fatal("unlimited invite closed after one use", w.Code)
	}

	// Editing can clear the membership duration and set a limit again.
	detail := responseData(t, apiRequest(a, "GET", "/api/invitations/"+itoa(id), admin, nil, nil))
	if w := apiRequest(a, "PATCH", "/api/invitations/"+itoa(id), admin, map[string]any{"revision": detail["revision"], "expires_at": nil, "max_uses": 5, "membership_duration_days": nil, "is_active": true, "grants": grants}, nil); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	detail = responseData(t, apiRequest(a, "GET", "/api/invitations/"+itoa(id), admin, nil, nil))
	if detail["max_uses"] != float64(5) || detail["membership_duration_days"] != nil || detail["custom_path"] != "friends-2026" {
		t.Fatal(detail)
	}
}
