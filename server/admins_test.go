package main

import (
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"strings"
	"testing"
)

type adminListResponse struct {
	Data []adminListItem `json:"data"`
	Meta struct {
		Snapshot int64 `json:"snapshot_revision"`
	} `json:"meta"`
}

func readAdmins(t *testing.T, a *App, token string) adminListResponse {
	t.Helper()
	w := apiRequest(a, "GET", "/api/admins", token, nil, nil)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	var out adminListResponse
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	return out
}

func adminByName(list adminListResponse, name string) *adminListItem {
	for i := range list.Data {
		if list.Data[i].Username == name {
			return &list.Data[i]
		}
	}
	return nil
}

func TestAdminManagementCreatesAtomicallyUnderTheHierarchy(t *testing.T) {
	a, s, owner, delegate, _ := roleReadFixture(t)
	activityExec(t, s, "INSERT INTO admin_permissions(id,name) VALUES('perm-other','not_implemented')")
	activityExec(t, s, "INSERT INTO admin_roles(id,name,position) VALUES('unimplemented','Unimplemented',5)")
	activityExec(t, s, "INSERT INTO admin_role_permissions VALUES('unimplemented','perm-other')")
	list := readAdmins(t, a, owner)
	if adminByName(list, "role-reader") == nil || len(list.Data) != 2 || list.Data[0].UserType != "owner" {
		t.Fatal(list.Data)
	}
	create := func(token string, body map[string]any) *httptest.ResponseRecorder {
		return apiRequest(a, "POST", "/api/admins", token, body, nil)
	}
	accounts := func() int {
		var n int
		s.reader.QueryRow("SELECT count(*) FROM user_accounts").Scan(&n)
		return n
	}
	before := accounts()
	snapshot := readAdmins(t, a, owner).Meta.Snapshot
	for name, tc := range map[string]struct {
		body map[string]any
		code int
	}{
		"stale":         {map[string]any{"username": "stale-admin", "password": invitationPassword, "role_ids": []string{"low"}, "snapshot_revision": snapshot + 1}, 409},
		"unimplemented": {map[string]any{"username": "bad-perm", "password": invitationPassword, "role_ids": []string{"low", "unimplemented"}, "snapshot_revision": snapshot}, 409},
		"missing":       {map[string]any{"username": "missing-role", "password": invitationPassword, "role_ids": []string{"low", "nope"}, "snapshot_revision": snapshot}, 404},
		"duplicate":     {map[string]any{"username": "role-reader", "password": invitationPassword, "role_ids": []string{"low"}, "snapshot_revision": snapshot}, 409},
		"no-roles":      {map[string]any{"username": "no-roles", "password": invitationPassword, "role_ids": []string{}, "snapshot_revision": snapshot}, 400},
	} {
		if w := create(owner, tc.body); w.Code != tc.code {
			t.Fatal(name, w.Code, w.Body.String())
		}
	}
	// A delegate (ceiling 50) cannot grant its own rank.
	if w := create(delegate, map[string]any{"username": "peer", "password": invitationPassword, "role_ids": []string{"high"}, "snapshot_revision": snapshot}); w.Code != 403 {
		t.Fatal("delegate granted its own rank", w.Code)
	}
	if accounts() != before {
		t.Fatal("refused creation left an account")
	}
	if w := create(delegate, map[string]any{"username": "junior", "password": invitationPassword, "role_ids": []string{"low"}, "snapshot_revision": snapshot}); w.Code != 201 {
		t.Fatal(w.Code, w.Body.String())
	}
	junior := adminByName(readAdmins(t, a, owner), "junior")
	if junior == nil || len(junior.Roles) != 1 || junior.Roles[0].ID != "low" {
		t.Fatal(junior)
	}
	var action string
	s.reader.QueryRow("SELECT action FROM audit_events WHERE action='admin.create'").Scan(&action)
	if action == "" {
		t.Fatal("creation not audited")
	}
}

func TestAdminManagementRoleUpdatesAndRefusedActions(t *testing.T) {
	a, s, owner, delegate, user := roleReadFixture(t)
	list := readAdmins(t, a, owner)
	if w := apiRequest(a, "POST", "/api/admins", owner, map[string]any{"username": "managed", "password": invitationPassword, "role_ids": []string{"low"}, "snapshot_revision": list.Meta.Snapshot}, nil); w.Code != 201 {
		t.Fatal(w.Code, w.Body.String())
	}
	list = readAdmins(t, a, owner)
	managed, self, ownerRow := adminByName(list, "managed"), adminByName(list, "role-reader"), list.Data[0]
	patch := func(token string, target *adminListItem, roles []string, snapshot, profile int64) int {
		return apiRequest(a, "PATCH", fmt.Sprintf("/api/admins/%d", target.ID), token, map[string]any{"role_ids": roles, "snapshot_revision": snapshot, "profile_revision": profile}, nil).Code
	}
	if code := patch(owner, managed, []string{"high"}, list.Meta.Snapshot, managed.Revision+1); code != 409 {
		t.Fatal("stale profile revision", code)
	}
	if code := patch(owner, managed, []string{"low"}, list.Meta.Snapshot, managed.Revision); code != 409 {
		t.Fatal("no-op update accepted", code)
	}
	if code := patch(owner, &ownerRow, []string{"low"}, list.Meta.Snapshot, ownerRow.Revision); code != 403 {
		t.Fatal("owner roles edited", code)
	}
	if code := patch(delegate, self, []string{"low"}, list.Meta.Snapshot, self.Revision); code != 403 {
		t.Fatal("self roles edited", code)
	}
	if code := patch(delegate, managed, []string{"high"}, list.Meta.Snapshot, managed.Revision); code != 403 {
		t.Fatal("delegate granted its own rank", code)
	}
	if code := patch(owner, managed, []string{"high"}, list.Meta.Snapshot, managed.Revision); code != 200 {
		t.Fatal(code)
	}
	if updated := adminByName(readAdmins(t, a, owner), "managed"); len(updated.Roles) != 1 || updated.Roles[0].ID != "high" {
		t.Fatal(updated.Roles)
	}
	for _, req := range [][2]string{{"DELETE", fmt.Sprintf("/api/admins/%d", managed.ID)}, {"POST", fmt.Sprintf("/api/admins/%d/reset-password", managed.ID)}} {
		w := apiRequest(a, req[0], req[1], owner, map[string]any{"password": "x"}, nil)
		if w.Code != 409 || !strings.Contains(w.Body.String(), "UNAVAILABLE") {
			t.Fatal(req, w.Code, w.Body.String())
		}
	}
	activityExec(t, s, "DELETE FROM admin_privileges WHERE user_uuid=?", user)
	if w := apiRequest(a, "GET", "/api/admins", delegate, nil, nil); w.Code != 403 {
		t.Fatal("non-administrator listed admins", w.Code)
	}
}
