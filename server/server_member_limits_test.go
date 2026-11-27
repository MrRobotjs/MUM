package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"testing"
)

// Plex members are counted once per person across the Plex servers one Plex
// account owns: friends and pending invitations count, the owner, removed
// accounts and accounts only seen in playback don't. The count turns nearly
// full at 95 and full at 99, and a server Plex refused as full stays full.
func TestPlexMemberCapacity(t *testing.T) {
	a, s := testApp(t)
	_ = a
	exec := func(query string, args ...any) {
		t.Helper()
		if _, err := s.writer.Exec(query, args...); err != nil {
			t.Fatal(err)
		}
	}
	server := func(name string) int64 {
		t.Helper()
		result, err := s.writer.Exec("INSERT INTO media_servers(server_nickname,service_type,url) VALUES(?,'plex','http://plex.invalid')", name)
		if err != nil {
			t.Fatal(err)
		}
		id, _ := result.LastInsertId()
		return id
	}
	n := 0
	account := func(server int64, user, owner, settings string, active bool, removed bool) {
		t.Helper()
		n++
		uuid := fmt.Sprintf("00000000-0000-4000-8000-%012d", n)
		exec("INSERT INTO identities(uuid,kind) VALUES(?,'service')", uuid)
		var removedAt any
		if removed {
			removedAt = "2026-01-01T00:00:00Z"
		}
		var ownerID any
		if owner != "" {
			ownerID = owner
		}
		exec(`INSERT INTO service_accounts(uuid,server_id,external_user_id,external_account_id,service_settings,is_active,removed_at,created_at,updated_at)
		 VALUES(?,?,?,?,?,?,?,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')`, uuid, server, user, ownerID, settings, active, removedAt)
	}
	first, second, other := server("Plex one"), server("Plex two"), server("Someone else's Plex")
	account(first, plexOwnerAccountID, "owner-1", `{}`, true, false)
	account(second, plexOwnerAccountID, "owner-1", `{}`, true, false)
	account(other, plexOwnerAccountID, "owner-2", `{}`, true, false)
	account(first, "friend-1", "", `{}`, true, false)
	account(second, "friend-1", "", `{}`, true, false)
	account(second, "friend-2", "", `{"plex_home":true}`, true, false)
	account(first, "pending-1", "", `{"invitation_pending":true}`, false, false)
	account(first, "removed-1", "", `{}`, true, true)
	account(first, "watcher-1", "", `{"activity_observed":true}`, true, false)
	account(other, "friend-9", "", `{}`, true, false)

	read := func(server int64) *serverCapacity {
		t.Helper()
		c, err := readServerCapacity(t.Context(), s.reader, server, "plex")
		if err != nil || c == nil {
			t.Fatal(c, err)
		}
		return c
	}
	if c := read(second); c.Members != 3 || c.Home != 1 || c.State != "open" || c.Limit != 99 || c.HomeLimit != 14 {
		t.Fatal("shared account count", c)
	}
	if c := read(other); c.Members != 1 {
		t.Fatal("another Plex account is counted apart", c)
	}
	if c, err := readServerCapacity(t.Context(), s.reader, first, "jellyfin"); c != nil || err != nil {
		t.Fatal("services without a limit report none", c, err)
	}
	for i := 3; i < 95; i++ {
		account(first, fmt.Sprintf("more-%d", i), "", `{}`, true, false)
	}
	if c := read(first); c.Members != 95 || c.State != "nearly_full" {
		t.Fatal("nearly full", c)
	}
	for i := 95; i < 99; i++ {
		account(first, fmt.Sprintf("more-%d", i), "", `{}`, true, false)
	}
	if c := read(first); c.Members != 99 || c.State != "full" {
		t.Fatal("full", c)
	}
	exec("UPDATE media_servers SET member_limit_reached=1 WHERE id=?", other)
	if c := read(other); c.State != "full" {
		t.Fatal("refused as full", c)
	}
	for i := range 13 {
		account(second, fmt.Sprintf("home-%d", i), "", `{"plex_home":true}`, true, false)
	}
	if c := read(second); c.Home != 14 || c.HomeState != "full" {
		t.Fatal("home full", c)
	}
	if code, status := invitationFailureLog(&plexShareError{Status: 422}); code != "PLEX_SERVER_FULL" || status != 422 || !plexRefusedAsFull(&plexShareError{Status: 422}) || plexRefusedAsFull(errors.New("other")) {
		t.Fatal("Plex's full answer", code, status)
	}
}

// An unavailable invited server is explained, not skipped silently: the invite
// still opens with each server's status, redeeming without choosing to skip it
// reserves nothing, and choosing to skip it joins the other servers and
// records what was skipped. A server that recovers must not be skipped either.
func TestInvitationUnavailableServerNeedsInviteeChoice(t *testing.T) {
	a, s := testApp(t)
	admin, _ := bootstrapOwner(t, a)
	open, down := newProvisioningFixture(t, ""), newProvisioningFixture(t, "")
	_, token, ids := prepareInvitation(t, a, admin, open, down)
	if _, err := s.writer.Exec("UPDATE media_servers SET is_active=0 WHERE id=?", ids[1]); err != nil {
		t.Fatal(err)
	}
	path := "/api/public/invitations/" + token
	w := apiRequest(a, "GET", path, "", nil, nil)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	data := responseData(t, w)
	statuses := map[float64]string{}
	for _, raw := range data["servers"].([]any) {
		server := raw.(map[string]any)
		statuses[server["id"].(float64)] = server["status"].(string)
	}
	if data["accepting"] != true || statuses[float64(ids[0])] != "open" || statuses[float64(ids[1])] != "unavailable" {
		t.Fatal("statuses", data)
	}
	var jobs int
	countJobs := func() int {
		t.Helper()
		if err := s.reader.QueryRow("SELECT count(*) FROM provisioning_jobs").Scan(&jobs); err != nil {
			t.Fatal(err)
		}
		return jobs
	}
	for _, skip := range [][]int64{nil, {ids[0]}, {ids[1], ids[1]}, {ids[0], ids[1]}} {
		body := redeemBody("Chooser", newUUID())
		body["skipped_server_ids"] = skip
		if w := apiRequest(a, "POST", path+"/redeem", "", body, nil); w.Code != 409 || countJobs() != 0 {
			t.Fatal("skip", skip, w.Code, w.Body.String())
		}
	}
	body := redeemBody("Chooser", newUUID())
	body["skipped_server_ids"] = []int64{ids[1]}
	w = apiRequest(a, "POST", path+"/redeem", "", body, nil)
	if w.Code != 201 {
		t.Fatal(w.Code, w.Body.String())
	}
	receipt := responseData(t, w)
	steps := receipt["steps"].([]any)
	skipped := receipt["skipped_servers"].([]any)
	if receipt["status"] != "completed" || len(steps) != 1 || steps[0].(map[string]any)["server_id"] != float64(ids[0]) ||
		len(skipped) != 1 || skipped[0].(map[string]any)["server_id"] != float64(ids[1]) || skipped[0].(map[string]any)["reason"] != "unavailable" {
		t.Fatal("receipt", receipt)
	}
	if down.creates.Load() != 0 {
		t.Fatal("skipped server was contacted")
	}
}

// When every invited server is full or unavailable the invite says so and
// nothing can be redeemed.
func TestInvitationWithNoOpenServerIsClosed(t *testing.T) {
	a, s := testApp(t)
	admin, _ := bootstrapOwner(t, a)
	f := newProvisioningFixture(t, "")
	_, token, ids := prepareInvitation(t, a, admin, f)
	if _, err := s.writer.Exec("UPDATE media_servers SET is_active=0 WHERE id=?", ids[0]); err != nil {
		t.Fatal(err)
	}
	w := apiRequest(a, "GET", "/api/public/invitations/"+token, "", nil, nil)
	if w.Code != 200 || responseData(t, w)["accepting"] != false {
		t.Fatal(w.Code, w.Body.String())
	}
	body := redeemBody("Nobody", newUUID())
	body["skipped_server_ids"] = []int64{ids[0]}
	if w := apiRequest(a, "POST", "/api/public/invitations/"+token+"/redeem", "", body, nil); w.Code != 409 {
		t.Fatal("redeemed an invite with no open server", w.Code, w.Body.String())
	}
}

// The invite's usage names who redeemed it.
func TestProvisioningJobsListTheChosenUsername(t *testing.T) {
	a, _ := testApp(t)
	admin, _ := bootstrapOwner(t, a)
	inviteID, token, _ := prepareInvitation(t, a, admin, newProvisioningFixture(t, ""))
	if w := apiRequest(a, "POST", "/api/public/invitations/"+token+"/redeem", "", redeemBody("Named Invitee", newUUID()), nil); w.Code != 201 {
		t.Fatal(w.Code, w.Body.String())
	}
	w := apiRequest(a, "GET", fmt.Sprintf("/api/provisioning-jobs?invite_id=%d", inviteID), admin, nil, nil)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	var out struct {
		Data []map[string]any `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil || len(out.Data) != 1 || out.Data[0]["username"] != "Named Invitee" {
		t.Fatal(out, err)
	}
}
