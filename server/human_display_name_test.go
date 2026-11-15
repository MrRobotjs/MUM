package main

import "testing"

// An account created by media server sign-in has no MUM username or email;
// it is shown by the name (and address) of the server account it owns, the
// way the server account appears, and keeps its own fields empty.
func TestSignInAccountShownByServerName(t *testing.T) {
	f := newServiceLoginFixture(t)
	service := seedExternalService(t, f.s, f.server, aliceJellyfinID)
	if _, err := f.s.writer.Exec("UPDATE service_accounts SET external_username='alice',external_email='alice@example.test' WHERE uuid=?", service); err != nil {
		t.Fatal(err)
	}
	token, alice := signInAsAlice(t, f)

	user := responseData(t, apiRequest(f.a, "GET", "/api/auth/session", token, nil, nil))["user"].(map[string]any)
	if user["display_name"] != "alice" || user["username"] != "" {
		t.Fatal("session user", user)
	}
	human := responseData(t, apiRequest(f.a, "GET", "/api/users/"+alice, f.owner, nil, nil))
	if human["display_name"] != "alice" || human["username"] != "" || human["email"] != nil || human["external_email"] != "alice@example.test" {
		t.Fatal("listed account", human)
	}
	parent := responseData(t, apiRequest(f.a, "GET", "/api/users/"+service, f.owner, nil, nil))["linked_local_user"].(map[string]any)
	if parent["uuid"] != alice || parent["display_name"] != "alice" || parent["username"] != "" {
		t.Fatal("linked to", parent)
	}
	// The server name finds the account in the Users list search.
	w := apiRequest(f.a, "GET", "/api/users?user_type=local&search=alic", f.owner, nil, nil)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	if rows := responseList(t, w); len(rows) != 1 || rows[0]["uuid"] != alice {
		t.Fatal("search", rows)
	}

	// Once the account has a MUM username, that is its name everywhere.
	if _, err := f.s.writer.Exec("UPDATE user_accounts SET local_username='alice-mum',email='mum@example.test' WHERE uuid=?", alice); err != nil {
		t.Fatal(err)
	}
	human = responseData(t, apiRequest(f.a, "GET", "/api/users/"+alice, f.owner, nil, nil))
	if human["display_name"] != "alice-mum" || human["username"] != "alice-mum" || human["external_email"] != "mum@example.test" {
		t.Fatal("named account", human)
	}
}
