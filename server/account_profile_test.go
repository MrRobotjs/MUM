package main

import (
	"strings"
	"testing"
)

func TestPersonalProfileScopesAndCapabilities(t *testing.T) {
	a, s := testApp(t)
	admin, _ := bootstrapOwner(t, a)
	if w := apiRequest(a, "GET", "/api/account/profile", "", nil, nil); w.Code != 401 {
		t.Fatal(w.Code)
	}
	owner, _ := s.Authenticate(t.Context(), admin)
	uuid, err := s.CreateAccount(t.Context(), owner.UUID, "ordinary-profile", "private-encoded-hash", false)
	if err != nil {
		t.Fatal(err)
	}
	tokens, err := s.issueSession(t.Context(), uuid, false)
	if err != nil {
		t.Fatal(err)
	}
	w := apiRequest(a, "GET", "/api/account/profile?uuid="+owner.UUID, tokens.Access, nil, nil)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	p := responseData(t, w)
	if p["uuid"] != uuid || p["username"] != "ordinary-profile" || p["profile_changes_available"] != false || p["password_change_available"] != true || p["email_change_available"] != true || p["profile_revision"] != float64(1) || p["email_verified"] != false || p["plex_authorization_enabled"] != false || p["has_password"] != true || strings.Contains(w.Body.String(), "private-encoded-hash") {
		t.Fatal(w.Body.String())
	}
	if _, err := s.writer.Exec("UPDATE provider_settings SET enabled=1 WHERE provider_id='plex'"); err != nil {
		t.Fatal(err)
	}
	w = apiRequest(a, "GET", "/api/account/profile", tokens.Access, nil, nil)
	if w.Code != 200 || responseData(t, w)["plex_authorization_enabled"] != true {
		t.Fatal(w.Code, w.Body.String())
	}
}
