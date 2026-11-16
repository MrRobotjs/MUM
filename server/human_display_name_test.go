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
	// The account page names the account the same way.
	if own := responseData(t, apiRequest(f.a, "GET", "/api/account/profile", token, nil, nil)); own["display_name"] != "alice" || own["username"] != "" {
		t.Fatal("account page", own)
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

// The Users list shows an account created by media server sign-in through its
// server accounts: its own card is left out unless a type or role filter asks
// for it, and each server account shows when its owner last signed in and the
// owner's other server accounts.
func TestSignInAccountShownThroughServerCards(t *testing.T) {
	f := newServiceLoginFixture(t)
	jelly := seedExternalService(t, f.s, f.server, aliceJellyfinID)
	other := seedExternalService(t, f.s, f.server, "b0b")
	if _, err := f.s.writer.Exec("UPDATE service_accounts SET external_username=CASE uuid WHEN ? THEN 'alice' ELSE 'bob' END", jelly); err != nil {
		t.Fatal(err)
	}
	token, alice := signInAsAlice(t, f)
	if countRows(t, f.s, "SELECT count(*) FROM user_accounts WHERE uuid=? AND last_login_at IS NOT NULL", alice) != 1 {
		t.Fatal("sign-in time not recorded")
	}
	if w := linkRequest(f, token, "bob", serviceFixturePassword); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	listed := func(query string) map[string]map[string]any {
		t.Helper()
		w := apiRequest(f.a, "GET", "/api/users"+query, f.owner, nil, nil)
		if w.Code != 200 {
			t.Fatal(w.Code, w.Body.String())
		}
		byID := map[string]map[string]any{}
		for _, row := range responseList(t, w) {
			byID[row["uuid"].(string)] = row
		}
		return byID
	}
	rows := listed("")
	if _, shown := rows[alice]; shown || rows[jelly] == nil || rows[other] == nil {
		t.Fatal("default list", rows)
	}
	card := rows[jelly]
	if card["mum_last_login_at"] == nil {
		t.Fatal("no last sign-in on the server card", card)
	}
	siblings := card["linked_accounts"].([]any)
	if len(siblings) != 1 || siblings[0].(map[string]any)["uuid"] != other || siblings[0].(map[string]any)["username"] != "bob" || siblings[0].(map[string]any)["service_type"] != "jellyfin" {
		t.Fatal("linked accounts", siblings)
	}
	if rows := listed("?user_type=local"); rows[alice] == nil {
		t.Fatal("local filter hides the account", rows)
	}
	if w := apiRequest(f.a, "GET", "/api/users/"+alice, f.owner, nil, nil); w.Code != 200 {
		t.Fatal("direct link", w.Code)
	}
	// With a MUM username the account has its own card again.
	if _, err := f.s.writer.Exec("UPDATE user_accounts SET local_username='alice-mum' WHERE uuid=?", alice); err != nil {
		t.Fatal(err)
	}
	if rows := listed(""); rows[alice] == nil || rows[alice]["mum_last_login_at"] == nil || len(rows[alice]["linked_accounts"].([]any)) != 0 {
		t.Fatal("named account", rows[alice])
	}
	// An unowned server account has no sign-in or linked accounts.
	loose := seedExternalService(t, f.s, f.server, "c4r01")
	if row := listed("")[loose]; row == nil || row["mum_last_login_at"] != nil || len(row["linked_accounts"].([]any)) != 0 {
		t.Fatal("unowned account", row)
	}
}
