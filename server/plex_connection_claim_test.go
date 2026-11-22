package main

import (
	"fmt"
	"testing"
)

func TestPlexConnectionClaimsMatchingServerOwner(t *testing.T) {
	a, s, owner, _ := plexLoginFixture(t, "")
	_, serverOwner := plexShareServer(t, s, "Owned Plex", "1")
	if _, err := s.writer.Exec(`UPDATE service_accounts SET external_account_id='2' WHERE uuid=?`, serverOwner); err != nil {
		t.Fatal(err)
	}
	_, differentOwner := plexShareServer(t, s, "Different Plex", "1")
	if _, err := s.writer.Exec(`UPDATE service_accounts SET external_account_id='9' WHERE uuid=?`, differentOwner); err != nil {
		t.Fatal(err)
	}
	_, unknownOwner := plexShareServer(t, s, "Unknown Plex", "1")
	_, takenOwner := plexShareServer(t, s, "Taken Plex", "1")
	principal, err := s.Authenticate(t.Context(), owner)
	if err != nil {
		t.Fatal(err)
	}
	other, err := s.CreateAccount(t.Context(), principal.UUID, "other-owner", "fixture-hash", false)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.writer.Exec(`UPDATE service_accounts SET external_account_id='2' WHERE uuid=?`, takenOwner); err != nil {
		t.Fatal(err)
	}
	if _, err := s.writer.Exec(`INSERT INTO service_links(user_uuid,service_uuid,link_kind,created_at) VALUES(?,?,'owner','2026-11-15T00:00:00Z')`, other, takenOwner); err != nil {
		t.Fatal(err)
	}
	token, member := plexMemberToken(t, a, s, owner)
	linkPlexForTest(t, a, token)
	if countRows(t, s, `SELECT count(*) FROM service_links WHERE user_uuid=? AND service_uuid=?`, member, serverOwner) != 1 {
		t.Fatal("verified Plex owner was not linked")
	}
	if countRows(t, s, `SELECT count(*) FROM service_links WHERE service_uuid=?`, differentOwner) != 0 {
		t.Fatal("different Plex owner was linked")
	}
	if countRows(t, s, `SELECT count(*) FROM service_links WHERE service_uuid=?`, unknownOwner) != 0 {
		t.Fatal("unknown Plex owner was linked")
	}
	if countRows(t, s, `SELECT count(*) FROM service_links WHERE user_uuid=? AND service_uuid=?`, other, takenOwner) != 1 {
		t.Fatal("existing ownership was overwritten")
	}
}

func TestPlexSyncClaimsConnectedServerOwner(t *testing.T) {
	upstream, client, _ := extendedProviderFixture(t, "plex")
	a, s := testApp(t)
	a.ProviderHTTP = client
	token, _ := bootstrapOwner(t, a)
	owner, err := s.Authenticate(t.Context(), token)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.writer.Exec(`INSERT INTO plex_connections(id,owner_uuid,account_id,username,status,created_at,verified_at) VALUES(?,?,'9001','ServerOwner','active',?,?)`, newUUID(), owner.UUID, "2026-11-15T00:00:00Z", "2026-11-15T00:00:00Z"); err != nil {
		t.Fatal(err)
	}
	id := createManagedServer(t, a, token, "plex", upstream.URL+"/proxy")
	setSignInSwitches(t, s, false, false)
	if w := apiRequest(a, "POST", fmt.Sprintf("/api/servers/%d/sync", id), token, nil, nil); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	if countRows(t, s, `SELECT count(*) FROM service_links l JOIN service_accounts sa ON sa.uuid=l.service_uuid WHERE l.user_uuid=? AND sa.server_id=? AND sa.external_user_id='1'`, owner.UUID, id) != 0 {
		t.Fatal("server owner linked while service sign-in was disabled")
	}
	setSignInSwitches(t, s, true, false)
	if w := apiRequest(a, "POST", fmt.Sprintf("/api/servers/%d/sync", id), token, nil, nil); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	if countRows(t, s, `SELECT count(*) FROM service_links l JOIN service_accounts sa ON sa.uuid=l.service_uuid WHERE l.user_uuid=? AND sa.server_id=? AND sa.external_user_id='1'`, owner.UUID, id) != 1 {
		t.Fatal("connected Plex owner not linked after sync")
	}
}

// Connecting a Plex account on the account page links the caller's unowned
// accounts for it on Plex servers, so the Users list shows them together.
// Accounts owned by someone else stay theirs.
func TestPlexConnectionClaimsUnownedShares(t *testing.T) {
	a, s, owner, _ := plexLoginFixture(t, "")
	_, mine := plexShareServer(t, s, "Plex A", "2")
	serverB, _ := plexShareServer(t, s, "Plex B", "9")
	taken := seedExternalService(t, s, serverB, "2")
	ownerPrincipal, err := s.Authenticate(t.Context(), owner)
	if err != nil {
		t.Fatal(err)
	}
	other, err := s.CreateAccount(t.Context(), ownerPrincipal.UUID, "someone-else", "fixture-hash", false)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.writer.Exec("INSERT INTO service_links(user_uuid,service_uuid,link_kind,created_at) VALUES(?,?,'owner',?)", other, taken, "2026-11-15T00:00:00Z"); err != nil {
		t.Fatal(err)
	}
	token, member := plexMemberToken(t, a, s, owner)
	linkPlexForTest(t, a, token)
	if countRows(t, s, "SELECT count(*) FROM service_links WHERE user_uuid=? AND service_uuid=? AND link_kind='owner'", member, mine) != 1 {
		t.Fatal("unowned share not linked")
	}
	if countRows(t, s, "SELECT count(*) FROM service_links WHERE user_uuid=? AND service_uuid=?", other, taken) != 1 || countRows(t, s, "SELECT count(*) FROM service_links WHERE user_uuid=?", member) != 1 {
		t.Fatal("another account's share changed hands")
	}
	if countRows(t, s, "SELECT count(*) FROM audit_events WHERE action='account.link.plex' AND actor_uuid=?", member) != 1 {
		t.Fatal("claim not audited")
	}
	if data := responseData(t, apiRequest(a, "GET", "/api/plex/connection", token, nil, nil)); data["on_server"] != true {
		t.Fatal("on server", data)
	}
}

// With media server sign-in off, connecting Plex links nothing, and the
// account page says when the Plex account is not on any Plex server.
func TestPlexConnectionClaimFollowsSwitch(t *testing.T) {
	a, s, owner, _ := plexLoginFixture(t, "")
	setSignInSwitches(t, s, false, false)
	_, share := plexShareServer(t, s, "Plex A", "2")
	token, _ := plexMemberToken(t, a, s, owner)
	linkPlexForTest(t, a, token)
	if countRows(t, s, "SELECT count(*) FROM service_links WHERE service_uuid=?", share) != 0 {
		t.Fatal("linked with the switch off")
	}
	if _, err := s.writer.Exec("UPDATE service_accounts SET removed_at='2026-11-15T00:00:00Z' WHERE uuid=?", share); err != nil {
		t.Fatal(err)
	}
	if data := responseData(t, apiRequest(a, "GET", "/api/plex/connection", token, nil, nil)); data["on_server"] != false {
		t.Fatal("not on server", data)
	}
	// The server owner's own Plex account is not listed as a share: unknown.
	principal, err := s.Authenticate(t.Context(), owner)
	if err != nil {
		t.Fatal(err)
	}
	if found, err := plexAccountOnServer(t.Context(), s.reader, principal, "2"); err != nil || found != nil {
		t.Fatal("owner", found, err)
	}
}

// Connecting a Plex account that is not on any Plex server yet, then adding it
// to the server: the next sync links it to the person who connected it, under
// the same switch.
func TestPlexSyncClaimsConnectedAccount(t *testing.T) {
	upstream, client, _ := extendedProviderFixture(t, "plex")
	a, s := testApp(t)
	a.ProviderHTTP = client
	token, _ := bootstrapOwner(t, a)
	owner, err := s.Authenticate(t.Context(), token)
	if err != nil {
		t.Fatal(err)
	}
	id := createManagedServer(t, a, token, "plex", upstream.URL+"/proxy")
	member, err := s.CreateAccount(t.Context(), owner.UUID, "jelly", "fixture-hash", false)
	if err != nil {
		t.Fatal(err)
	}
	// The fixture shares Plex account 2 ("Reader") with the server.
	if _, err := s.writer.Exec(`INSERT INTO plex_connections(id,owner_uuid,account_id,username,status,created_at,verified_at) VALUES(?,?,'2','Reader','active',?,?)`, newUUID(), member, "2026-11-15T00:00:00Z", "2026-11-15T00:00:00Z"); err != nil {
		t.Fatal(err)
	}
	sync := func() {
		t.Helper()
		if w := apiRequest(a, "POST", fmt.Sprintf("/api/servers/%d/sync", id), token, nil, nil); w.Code != 200 {
			t.Fatal(w.Code, w.Body.String())
		}
	}
	reader := `SELECT count(*) FROM service_links l JOIN service_accounts sa ON sa.uuid=l.service_uuid WHERE l.user_uuid=? AND l.link_kind='owner' AND sa.server_id=? AND sa.external_user_id='2'`
	setSignInSwitches(t, s, false, false)
	sync()
	if countRows(t, s, reader, member, id) != 0 {
		t.Fatal("linked with the switch off")
	}
	setSignInSwitches(t, s, true, false)
	sync()
	if countRows(t, s, reader, member, id) != 1 || countRows(t, s, "SELECT count(*) FROM audit_events WHERE action='account.link.plex' AND actor_uuid=?", member) != 1 {
		t.Fatal("synced account not linked to the connection's owner")
	}
	// Nothing else is claimed, and syncing again changes nothing.
	sync()
	if countRows(t, s, "SELECT count(*) FROM service_links WHERE user_uuid=?", member) != 1 || countRows(t, s, "SELECT count(*) FROM audit_events WHERE action='account.link.plex'") != 1 {
		t.Fatal("claimed more than the connected account")
	}
}
