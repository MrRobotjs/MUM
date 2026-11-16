package main

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"
)

// Edit protects server accounts from purges, with the same skip rules as the
// other server account settings.
func TestEditSetsPurgeProtection(t *testing.T) {
	a, s := testApp(t)
	token, _ := bootstrapOwner(t, a)
	owner, _ := s.Authenticate(t.Context(), token)
	server := seedServer(t, s)
	viewer, mine, already := seedService(t, s, server), seedService(t, s, server), seedService(t, s, server)
	activityExec(t, s, "UPDATE service_accounts SET is_purge_whitelisted=1 WHERE uuid=?", already)
	if err := s.LinkServiceAccounts(t.Context(), owner.UUID, owner.UUID, []string{mine}); err != nil {
		t.Fatal(err)
	}
	local, err := s.CreateAccount(t.Context(), owner.UUID, "local-viewer", "fixture-hash", false)
	if err != nil {
		t.Fatal(err)
	}
	for _, bad := range []map[string]any{{"action": "set_purge_protection"}, {"action": "clear_expiration", "purge_protected": true}, {"action": "set_4k_transcode", "allow_4k_transcode": true, "purge_protected": true}} {
		if w := apiRequest(a, "POST", "/api/users/edit/prepare", token, map[string]any{"request_id": newUUID(), "user_uuids": []string{viewer}, "operation": bad}, nil); w.Code != 400 {
			t.Fatal("invalid operation accepted", bad, w.Code, w.Body.String())
		}
	}
	w := apiRequest(a, "POST", "/api/users/edit/prepare", token, map[string]any{"request_id": newUUID(), "user_uuids": []string{viewer, mine, already, local}, "operation": map[string]any{"action": "set_purge_protection", "purge_protected": true}}, nil)
	var prepared struct{ Data editReceipt }
	if err := json.Unmarshal(w.Body.Bytes(), &prepared); err != nil || w.Code != 201 {
		t.Fatalf("prepare %d %s", w.Code, w.Body.String())
	}
	reasons := map[string]string{}
	for _, result := range prepared.Data.Results {
		reasons[result.UUID] = result.Outcome + "/" + result.Reason
	}
	if reasons[mine] != "skipped/protected_account" || reasons[already] != "unchanged/" || reasons[local] != "skipped/service_account_required" || reasons[viewer] != "pending/" {
		t.Fatal(reasons)
	}
	if w := apiRequest(a, "POST", "/api/edit-operations/"+prepared.Data.ID+"/execute", token, map[string]any{"revision": prepared.Data.Revision, "acknowledge_effects": true}, nil); w.Code != 202 {
		t.Fatalf("execute %d %s", w.Code, w.Body.String())
	}
	if receipt := waitEdit(t, a, token, prepared.Data.ID); receipt.Summary["updated"] != 1 {
		t.Fatal(receipt)
	}
	var protected, ownUnprotected bool
	if err := s.reader.QueryRow("SELECT (SELECT is_purge_whitelisted=1 FROM service_accounts WHERE uuid=?),(SELECT is_purge_whitelisted=0 FROM service_accounts WHERE uuid=?)", viewer, mine).Scan(&protected, &ownUnprotected); err != nil || !protected || !ownUnprotected {
		t.Fatal(protected, ownUnprotected, err)
	}
	// The user page shows protection for server accounts only.
	for id, want := range map[string]any{viewer: true, mine: false, local: nil} {
		if got := responseData(t, apiRequest(a, "GET", "/api/users/"+id, token, nil, nil))["is_purge_whitelisted"]; got != want {
			t.Fatal(id, got, want)
		}
	}
}

// An invitation's protection choice is saved per server, read back and given
// to the server accounts it creates.
func TestInvitationPurgeProtectionReachesCreatedAccounts(t *testing.T) {
	a, s := testApp(t)
	admin, _ := bootstrapOwner(t, a)
	first, second := newProvisioningFixture(t, ""), newProvisioningFixture(t, "")
	_, _, servers := prepareInvitation(t, a, admin, first, second)
	protected := true
	grants := []InvitationGrant{{ServerID: servers[0], LibraryIDs: []string{"movies"}, PurgeProtected: &protected}, {ServerID: servers[1], LibraryIDs: []string{"movies"}}}
	w := apiRequest(a, "POST", "/api/invitations", admin, map[string]any{"expires_at": time.Now().Add(time.Hour).UTC().Format(time.RFC3339Nano), "max_uses": 1, "grants": grants}, nil)
	if w.Code != 201 {
		t.Fatal(w.Code, w.Body.String())
	}
	created := responseData(t, w)
	invite, token := int64(created["id"].(float64)), created["token"].(string)
	saved := map[float64]any{}
	for _, raw := range responseData(t, apiRequest(a, "GET", fmt.Sprintf("/api/invitations/%d", invite), admin, nil, nil))["grants"].([]any) {
		grant := raw.(map[string]any)
		saved[grant["server_id"].(float64)] = grant["purge_protected"]
	}
	if saved[float64(servers[0])] != true || saved[float64(servers[1])] != false {
		t.Fatal("saved grants", saved)
	}
	if w := apiRequest(a, "GET", "/api/public/invitations/"+token, "", nil, nil); w.Code != 200 || strings.Contains(w.Body.String(), "purge_protected") {
		t.Fatal("the public invitation shows purge protection", w.Code, w.Body.String())
	}
	if w := apiRequest(a, "POST", "/api/public/invitations/"+token+"/redeem", "", redeemBody("Kept Viewer", newUUID()), nil); w.Code != 201 || responseData(t, w)["status"] != "completed" {
		t.Fatal(w.Code, w.Body.String())
	}
	for i, want := range []bool{true, false} {
		var got bool
		if err := s.reader.QueryRow("SELECT is_purge_whitelisted FROM service_accounts WHERE server_id=? AND used_invite_id=?", servers[i], invite).Scan(&got); err != nil || got != want {
			t.Fatal(i, got, err)
		}
	}
}
