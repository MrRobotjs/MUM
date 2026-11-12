package main

import (
	"encoding/json"
	"fmt"
	"testing"
	"time"
)

// An account that disappears from the provider during a sync is treated as
// removed (hidden from the Users list) while its record and history are kept;
// it is restored if it comes back. An invitation that is still waiting to be
// accepted is not treated as removed.
func TestSyncMarksMissingAccountsRemovedAndRestoresReturningOnes(t *testing.T) {
	upstream, client, _ := extendedProviderFixture(t, "plex")
	a, s := testApp(t)
	a.ProviderHTTP = client
	token, _ := bootstrapOwner(t, a)
	id := createManagedServer(t, a, token, "plex", upstream.URL+"/proxy")
	now := utcTimestamp(time.Now())
	seed := func(uuid, external, settings string, active bool) {
		activityExec(t, s, "INSERT INTO identities(uuid,kind) VALUES(?,'service')", uuid)
		activityExec(t, s, `INSERT INTO service_accounts(uuid,server_id,external_user_id,external_username,service_settings,is_active,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)`, uuid, id, external, "user-"+external, settings, active, now, now)
	}
	seed("left-server", "77", `{}`, true)                               // left the server
	seed("awaiting-accept", "88", `{"invitation_pending":true}`, false) // invited, not accepted yet
	seed("came-back", "2", `{}`, false)                                 // previously removed, present again
	activityExec(t, s, "UPDATE service_accounts SET removed_at=? WHERE uuid='came-back'", now)
	if w := apiRequest(a, "POST", fmt.Sprintf("/api/servers/%d/sync", id), token, nil, nil); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	state := func(uuid string) (removed bool, active bool) {
		t.Helper()
		if err := s.reader.QueryRow("SELECT removed_at IS NOT NULL,is_active FROM service_accounts WHERE uuid=?", uuid).Scan(&removed, &active); err != nil {
			t.Fatal(err)
		}
		return
	}
	if removed, active := state("left-server"); !removed || active {
		t.Fatal("missing account should be removed and inactive", removed, active)
	}
	if removed, _ := state("awaiting-accept"); removed {
		t.Fatal("pending invitation treated as removed")
	}
	if removed, active := state("came-back"); removed || !active {
		t.Fatal("returning account should be restored", removed, active)
	}
	w := apiRequest(a, "GET", "/api/users?page_size=100", token, nil, nil)
	var page struct{ Data []map[string]any }
	if err := json.Unmarshal(w.Body.Bytes(), &page); err != nil {
		t.Fatal(err)
	}
	listed := map[string]bool{}
	for _, u := range page.Data {
		listed[u["uuid"].(string)] = true
	}
	if listed["left-server"] || !listed["awaiting-accept"] || !listed["came-back"] {
		t.Fatal("Users list should hide only removed accounts", listed)
	}
	// The removed account's profile and history stay reachable directly.
	if w := apiRequest(a, "GET", "/api/users/left-server", token, nil, nil); w.Code != 200 {
		t.Fatal("removed account profile", w.Code, w.Body.String())
	}
}
