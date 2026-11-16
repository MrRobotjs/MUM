package main

import (
	"encoding/json"
	"net/url"
	"strconv"
	"testing"
	"time"
)

// Full administrators may do what the owner can, within the role ranking,
// except: only the owner deletes, deactivates or removes the server accounts
// of an administrator, and only the owner grants the Administrator permission
// (user decisions 2026-11-16, Discord-style roles).

// lowerAdmin creates a local account holding the 'low' role (ranked below the
// fixture administrator's 'high' role) and a server account linked to it.
func lowerAdmin(t *testing.T, s *Store, ownerToken string, server int64) (string, string) {
	t.Helper()
	owner, _ := s.Authenticate(t.Context(), ownerToken)
	user, err := s.CreateAccount(t.Context(), owner.UUID, "lower-admin", "fixture-hash", false)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.AssignAdminRole(t.Context(), owner.UUID, user, "low"); err != nil {
		t.Fatal(err)
	}
	service := seedService(t, s, server)
	if err := s.LinkServiceAccounts(t.Context(), owner.UUID, user, []string{service}); err != nil {
		t.Fatal(err)
	}
	return user, service
}

func editReasons(t *testing.T, a *App, token string, ids []string, op map[string]any) map[string]string {
	t.Helper()
	w := apiRequest(a, "POST", "/api/users/edit/prepare", token, map[string]any{"request_id": newUUID(), "user_uuids": ids, "operation": op}, nil)
	var prepared struct{ Data editReceipt }
	if err := json.Unmarshal(w.Body.Bytes(), &prepared); err != nil || w.Code != 201 {
		t.Fatalf("prepare %d %s", w.Code, w.Body.String())
	}
	out := map[string]string{}
	for _, r := range prepared.Data.Results {
		out[r.UUID] = r.Reason
	}
	return out
}

func TestAdministratorsEditOrdinaryServerAccountsButNotAdministrators(t *testing.T) {
	a, s, ownerToken, token, _ := roleReadFixture(t)
	server := seedServer(t, s)
	ordinary := seedService(t, s, server)
	_, adminService := lowerAdmin(t, s, ownerToken, server)
	for _, op := range []map[string]any{{"action": "delete_users"}, {"action": "update_libraries", "has_all_libraries": true}} {
		reasons := editReasons(t, a, token, []string{ordinary, adminService}, op)
		if reasons[ordinary] == "owner_only" || reasons[ordinary] == "protected_account" {
			t.Fatal(op["action"], "ordinary account refused for an administrator:", reasons[ordinary])
		}
		if reasons[adminService] != "protected_account" {
			t.Fatal(op["action"], "an administrator's server account was not protected:", reasons[adminService])
		}
	}
}

func TestAdministratorPurgesAndAdministratorsAreNeverListed(t *testing.T) {
	a, s, ownerToken, service, writes := purgeFixture(t)
	owner, _ := s.Authenticate(t.Context(), ownerToken)
	hash, _ := hashPassword("a-strong-member-password")
	for _, name := range []string{"full-admin", "listed-admin"} {
		if _, err := s.CreateAccount(t.Context(), owner.UUID, name, hash, false); err != nil {
			t.Fatal(err)
		}
	}
	activityExec(t, s, "INSERT INTO admin_roles(id,name,position) VALUES('full','Full',6),('minor','Minor',1)")
	activityExec(t, s, "INSERT INTO admin_role_permissions VALUES('full','admin')")
	activityExec(t, s, "INSERT INTO admin_privileges SELECT uuid,'full' FROM user_accounts WHERE local_username='full-admin'")
	activityExec(t, s, "INSERT INTO admin_privileges SELECT uuid,'minor' FROM user_accounts WHERE local_username='listed-admin'")
	// An inactive Plex account of an administrator is never listed, even for the owner.
	var server int64
	_ = s.reader.QueryRow("SELECT server_id FROM service_accounts WHERE uuid=?", service).Scan(&server)
	adminService := seedService(t, s, server)
	activityExec(t, s, "UPDATE service_accounts SET external_user_id='77',external_username='AdminViewer',created_at=? WHERE uuid=?", utcTimestamp(time.Now().AddDate(-1, 0, 0)), adminService)
	var listedAdmin string
	_ = s.reader.QueryRow("SELECT uuid FROM user_accounts WHERE local_username='listed-admin'").Scan(&listedAdmin)
	if err := s.LinkServiceAccounts(t.Context(), owner.UUID, listedAdmin, []string{adminService}); err != nil {
		t.Fatal(err)
	}
	w := apiRequest(a, "POST", "/api/auth/login", "", map[string]any{"username": "full-admin", "password": "a-strong-member-password"}, nil)
	admin := responseData(t, w)["access_token"].(string)
	for who, token := range map[string]string{"owner": ownerToken, "administrator": admin} {
		code, users := listPurge(t, a, token, url.Values{"inactive_days": {"30"}})
		if code != 200 || len(users) != 1 || users[0].UUID != service {
			t.Fatal(who, code, users)
		}
	}
	// Selecting the administrator's account anyway is refused.
	if reasons := editReasons(t, a, ownerToken, []string{adminService}, map[string]any{"action": "delete_users", "purge": purgeRule}); reasons[adminService] != "protected_account" {
		t.Fatal("purge accepted an administrator's account", reasons)
	}
	receipt := runPurge(t, a, admin, preparePurge(t, a, admin, service))
	if receipt.State != "completed" || receipt.Summary["deleted"] != 1 || *writes != 1 {
		t.Fatalf("administrator purge %+v writes %d", receipt, *writes)
	}
}

func TestOnlyTheOwnerDeactivatesAdministrators(t *testing.T) {
	a, s, ownerToken, token, _ := roleReadFixture(t)
	owner, _ := s.Authenticate(t.Context(), ownerToken)
	target, _ := lowerAdmin(t, s, ownerToken, seedServer(t, s))
	ordinary, err := s.CreateAccount(t.Context(), owner.UUID, "ordinary-user", "fixture-hash", false)
	if err != nil {
		t.Fatal(err)
	}
	read := func(token, id string) map[string]any {
		t.Helper()
		w := apiRequest(a, "GET", "/api/users/"+id+"/activation", token, nil, nil)
		if w.Code != 200 {
			t.Fatal(w.Code, w.Body.String())
		}
		return responseData(t, w)
	}
	before := read(token, target)
	if before["availability"] != "administrator_unavailable" {
		t.Fatal("a higher-ranked administrator may deactivate another administrator", before)
	}
	if w := apiRequest(a, "PUT", "/api/users/"+target+"/activation", token, activationBody(before, false), nil); w.Code == 200 {
		t.Fatal("deactivated an administrator", w.Body.String())
	}
	if got := read(token, ordinary)["availability"]; got != "available" {
		t.Fatal("ordinary user", got)
	}
	owned := read(ownerToken, target)
	if owned["availability"] != "available" {
		t.Fatal("owner", owned)
	}
	if w := apiRequest(a, "PUT", "/api/users/"+target+"/activation", ownerToken, activationBody(owned, false), nil); w.Code != 200 {
		t.Fatal("owner deactivation", w.Code, w.Body.String())
	}
}

func TestOnlyTheOwnerGrantsTheAdministratorPermission(t *testing.T) {
	a, s, ownerToken, token, actor := roleReadFixture(t)
	owner, _ := s.Authenticate(t.Context(), ownerToken)
	if w := apiRequest(a, "POST", "/api/admin-roles", token, roleChangeBody(actor, roleRevision(t, s), roleChangeValues("Escalation", 5, "admin")), nil); w.Code != 403 {
		t.Fatal("a delegated administrator created a role with the Administrator permission", w.Code, w.Body.String())
	}
	if w := apiRequest(a, "PUT", "/api/admin-roles/low", token, roleChangeBody(actor, roleRevision(t, s), roleChangeValues("administrator", 10, "admin")), nil); w.Code != 403 {
		t.Fatal("a delegated administrator added the Administrator permission", w.Code, w.Body.String())
	}
	if w := apiRequest(a, "POST", "/api/admin-roles", ownerToken, roleChangeBody(owner.UUID, roleRevision(t, s), roleChangeValues("Granted", 5, "admin")), nil); w.Code != 201 && w.Code != 200 {
		t.Fatal("owner role creation", w.Code, w.Body.String())
	}
	var granted string
	if err := s.reader.QueryRow("SELECT id FROM admin_roles WHERE name='Granted'").Scan(&granted); err != nil {
		t.Fatal(err)
	}
	user, err := s.CreateAccount(t.Context(), owner.UUID, "candidate", "fixture-hash", false)
	if err != nil {
		t.Fatal(err)
	}
	if w := apiRequest(a, "POST", "/api/admin-roles/"+granted+"/memberships", token, membershipBody(actor, roleRevision(t, s), "assign", adminRoleTarget{user, 1}), nil); w.Code != 403 {
		t.Fatal("a delegated administrator assigned the Administrator permission", w.Code, w.Body.String())
	}
	// A role without it can still be created and assigned below the actor's rank.
	if w := apiRequest(a, "POST", "/api/admin-roles", token, roleChangeBody(actor, roleRevision(t, s), roleChangeValues("Helper", 5)), nil); w.Code != 201 && w.Code != 200 {
		t.Fatal("cosmetic role creation", w.Code, w.Body.String())
	}
	var helper string
	_ = s.reader.QueryRow("SELECT id FROM admin_roles WHERE name='Helper'").Scan(&helper)
	if w := apiRequest(a, "POST", "/api/admin-roles/"+helper+"/memberships", token, membershipBody(actor, roleRevision(t, s), "assign", adminRoleTarget{user, 1}), nil); w.Code != 200 {
		t.Fatal("cosmetic role assignment", w.Code, w.Body.String())
	}
}

func TestAdministratorConfiguresScheduledSyncThatOutlivesTheirRole(t *testing.T) {
	a, s, ownerToken, token, actor := roleReadFixture(t)
	upstream, _ := providerFixture(t, "jellyfin")
	id := createManagedServer(t, a, ownerToken, "jellyfin", upstream.URL)
	snapshot := taskSnapshot(t, a, token)
	if snapshot["configuration_available"] != true {
		t.Fatal("administrator cannot configure", snapshot)
	}
	task := snapshot["tasks"].([]any)[0].(map[string]any)
	if w := apiRequest(a, "PUT", "/api/settings/scheduled-tasks/"+strconv.FormatInt(id, 10), token, taskConfig(actor, task, true, 60), nil); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	// The schedule runs on MUM's own authority, even after the administrator loses the role.
	activityExec(t, s, "DELETE FROM admin_privileges WHERE user_uuid=?", actor)
	if err := a.runOneScheduledSync(t.Context()); err != nil {
		t.Fatal(err)
	}
	var state string
	if err := s.reader.QueryRow("SELECT run_state FROM server_sync_schedules WHERE server_id=?", id).Scan(&state); err != nil || state != "succeeded" {
		t.Fatal(state, err)
	}
}

func TestAdministratorsEditServerAccountExpiryWithinRank(t *testing.T) {
	a, s, ownerToken, token, _ := roleReadFixture(t)
	owner, _ := s.Authenticate(t.Context(), ownerToken)
	server := seedServer(t, s)
	ordinary := seedService(t, s, server)
	if w := apiRequest(a, "GET", "/api/service-accounts/"+ordinary+"/expiry", token, nil, nil); w.Code != 200 {
		t.Fatal("administrator read", w.Code, w.Body.String())
	}
	mine := seedService(t, s, server)
	if err := s.LinkServiceAccounts(t.Context(), owner.UUID, owner.UUID, []string{mine}); err != nil {
		t.Fatal(err)
	}
	if w := apiRequest(a, "GET", "/api/service-accounts/"+mine+"/expiry", token, nil, nil); w.Code != 403 {
		t.Fatal("the owner's server account was editable", w.Code)
	}
}

func TestAdministratorsRemoteAccessOwnerOnlyForAdministrators(t *testing.T) {
	f := newRemoteFixture(t)
	activityExec(t, f.store, "DELETE FROM service_links WHERE service_uuid=?", f.service)
	w := apiRequest(f.app, "GET", f.path, f.token, nil, nil)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	if got := responseData(t, w)["availability"]; got == "owner_only" {
		t.Fatal("an unlinked server account is owner-only for administrators")
	}
	_, adminService := lowerAdmin(t, f.store, f.ownerToken, f.server)
	activityExec(t, f.store, "INSERT INTO service_remote_access(service_uuid) VALUES(?) ON CONFLICT DO NOTHING", adminService)
	activityExec(t, f.store, "UPDATE service_accounts SET external_user_id=?,external_username='Remote Name' WHERE uuid=?", adminService, adminService)
	w = apiRequest(f.app, "GET", "/api/service-accounts/"+adminService+"/remote-access", f.token, nil, nil)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	if got := responseData(t, w)["delete_availability"]; got != "owner_only" {
		t.Fatal("an administrator's server account could be deleted by another administrator", got)
	}
}
