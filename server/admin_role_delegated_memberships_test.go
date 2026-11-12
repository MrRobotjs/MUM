package main

import (
	"database/sql"
	"testing"
)

func TestDelegatedRoleMembershipLifecycleAndScopedProjections(t *testing.T) {
	a, s, ownerToken, token, actor := roleReadFixture(t)
	owner, _ := s.Authenticate(t.Context(), ownerToken)
	target, err := s.CreateAccount(t.Context(), owner.UUID, "delegated-target", "fixture-hash", false)
	if err != nil {
		t.Fatal(err)
	}
	peer, err := s.CreateAccount(t.Context(), owner.UUID, "delegated-peer", "fixture-hash", false)
	if err != nil {
		t.Fatal(err)
	}
	for _, q := range []string{
		`INSERT INTO admin_role_permissions VALUES('low','admin')`,
		`INSERT INTO admin_roles(id,name,position) VALUES('cosmetic','Cosmetic ceiling',500),('middle','Outside scope',100),('retain','Retained role',1)`,
	} {
		if _, err := s.writer.Exec(q); err != nil {
			t.Fatal(err)
		}
	}
	for _, row := range []struct{ user, role string }{{actor, "cosmetic"}, {peer, "high"}, {peer, "low"}, {target, "retain"}, {actor, "low"}} {
		if _, err := s.writer.Exec("INSERT INTO admin_privileges VALUES(?,?)", row.user, row.role); err != nil {
			t.Fatal(err)
		}
	}
	child, err := s.issueSession(t.Context(), target, false)
	if err != nil {
		t.Fatal(err)
	}
	data := responseData(t, apiRequest(a, "GET", "/api/admin-roles", token, nil, nil))
	if data["mutations_available"] != false {
		t.Fatal("delegated metadata authority enabled")
	}
	for _, raw := range data["roles"].([]any) {
		r := raw.(map[string]any)
		want := r["id"] == "low" || r["id"] == "retain"
		if r["member_changes_available"] != want || r["member_assignment_available"] != want {
			t.Fatal(r)
		}
	}
	page := responseData(t, apiRequest(a, "GET", "/api/admin-roles/low/candidates", token, nil, nil))
	if page["total"] != float64(1) || page["mutations_available"] != false {
		t.Fatal(page)
	}
	candidate := page["candidates"].([]any)[0].(map[string]any)
	if candidate["uuid"] != target || candidate["can_assign"] != true || candidate["can_remove"] != false {
		t.Fatal(candidate)
	}
	w := apiRequest(a, "POST", "/api/admin-roles/low/memberships", token, membershipBody(actor, roleRevision(t, s), "assign", adminRoleTarget{target, 1}), nil)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	if w := apiRequest(a, "GET", "/api/admin-roles", child.Access, nil, nil); w.Code != 200 {
		t.Fatal("current child session did not gain permission", w.Code)
	}
	members := responseData(t, apiRequest(a, "GET", "/api/admin-roles/low/users", token, nil, nil))
	for _, raw := range members["members"].([]any) {
		m := raw.(map[string]any)
		if m["can_remove"] != (m["uuid"] == target) || m["can_assign"] != false {
			t.Fatal(m)
		}
	}
	for _, id := range []string{"high", "middle", "cosmetic"} {
		if w := apiRequest(a, "GET", "/api/admin-roles/"+id+"/candidates", token, nil, nil); w.Code != 403 {
			t.Fatal(id, w.Code)
		}
	}
	before := roleRevision(t, s)
	w = apiRequest(a, "POST", "/api/admin-roles/low/memberships", token, membershipBody(actor, before, "remove", adminRoleTarget{target, 1}, adminRoleTarget{peer, 1}), nil)
	if w.Code != 403 || roleRevision(t, s) != before {
		t.Fatal("mixed peer batch changed state", w.Code)
	}
	w = apiRequest(a, "POST", "/api/admin-roles/low/memberships", token, membershipBody(actor, before, "remove", adminRoleTarget{target, 1}), nil)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	if w := apiRequest(a, "GET", "/api/admin-roles", child.Access, nil, nil); w.Code != 403 {
		t.Fatal("removed child retained permission", w.Code)
	}
	if _, err := s.Authenticate(t.Context(), child.Access); err != nil {
		t.Fatal("child session revoked", err)
	}
	var retained, audits int
	s.reader.QueryRow("SELECT count(*) FROM admin_privileges WHERE user_uuid=? AND role_id='retain'", target).Scan(&retained)
	s.reader.QueryRow("SELECT count(*) FROM audit_events WHERE actor_uuid=? AND action LIKE 'admin.role.members.%'", actor).Scan(&audits)
	if retained != 1 || audits != 2 {
		t.Fatal(retained, audits)
	}
}

func TestDelegatedRoleMembershipCurrentHierarchyAndTargetGuards(t *testing.T) {
	for _, mode := range []string{"peer", "cosmetic-target", "self", "system", "owner-role", "role-tie", "cosmetic-actor", "inactive", "stale-target", "changed-hierarchy", "lost-grant", "expired-session"} {
		t.Run(mode, func(t *testing.T) {
			a, s, ownerToken, token, actor := roleReadFixture(t)
			owner, _ := s.Authenticate(t.Context(), ownerToken)
			target, err := s.CreateAccount(t.Context(), owner.UUID, "guard-target", "fixture-hash", false)
			if err != nil {
				t.Fatal(err)
			}
			role, want := "low", 403
			switch mode {
			case "peer":
				s.writer.Exec("INSERT INTO admin_privileges VALUES(?,'high')", target)
			case "cosmetic-target":
				s.writer.Exec("INSERT INTO admin_roles(id,name,position) VALUES('cosmetic','Cosmetic peer',500)")
				s.writer.Exec("INSERT INTO admin_privileges VALUES(?,'cosmetic')", target)
			case "self":
				target = actor
			case "system":
				s.writer.Exec("UPDATE admin_roles SET is_auto_managed=1 WHERE id='low'")
			case "owner-role":
				s.writer.Exec("INSERT INTO admin_privileges VALUES(?,'low')", owner.UUID)
			case "role-tie":
				role = "high"
			case "cosmetic-actor":
				s.writer.Exec("INSERT INTO admin_roles(id,name,position) VALUES('middle','Not manageable',100),('cosmetic','Cosmetic boost',500)")
				s.writer.Exec("INSERT INTO admin_privileges VALUES(?,'cosmetic')", actor)
				role = "middle"
			case "inactive":
				s.writer.Exec("UPDATE user_accounts SET is_active=0 WHERE uuid=?", target)
			case "stale-target":
				want = 409
			}
			revision := roleRevision(t, s)
			profile := int64(1)
			if mode == "stale-target" {
				profile = 99
			}
			if mode == "changed-hierarchy" {
				s.writer.Exec("INSERT INTO admin_privileges VALUES(?,'high')", target)
				want = 409
			}
			if mode == "lost-grant" {
				s.writer.Exec("DELETE FROM admin_privileges WHERE user_uuid=?", actor)
			}
			if mode == "expired-session" {
				s.writer.Exec("UPDATE session_access_tokens SET expires_at='2000-01-01T00:00:00Z' WHERE token_hash=?", tokenHash(token))
				want = 401
			}
			before := roleRevision(t, s)
			w := apiRequest(a, "POST", "/api/admin-roles/"+role+"/memberships", token, membershipBody(actor, revision, "assign", adminRoleTarget{target, profile}), nil)
			if w.Code != want || roleRevision(t, s) != before {
				t.Fatal(mode, w.Code, w.Body.String())
			}
		})
	}
}

func TestDelegatedRoleMembershipWriterRevocationRollback(t *testing.T) {
	_, s, ownerToken, token, actor := roleReadFixture(t)
	owner, _ := s.Authenticate(t.Context(), ownerToken)
	target, err := s.CreateAccount(t.Context(), owner.UUID, "queued-target", "fixture-hash", false)
	if err != nil {
		t.Fatal(err)
	}
	p := adminRoleMembershipChange{Actor: actor, Access: token, Role: "low", Operation: "assign", Revision: roleRevision(t, s), Targets: []adminRoleTarget{{target, 1}}}
	err = s.write(t.Context(), func(tx *sql.Tx) error {
		if _, err := tx.Exec("DELETE FROM admin_role_permissions WHERE role_id='high'"); err != nil {
			return err
		}
		_, err := commitAdminRoleMembership(t.Context(), tx, p)
		return err
	})
	if err == nil {
		t.Fatal("cached authority survived revocation")
	}
	var count int
	s.reader.QueryRow("SELECT count(*) FROM admin_privileges WHERE role_id='low'").Scan(&count)
	if count != 0 || roleRevision(t, s) != p.Revision {
		t.Fatal("failed queued batch committed")
	}
}

func TestDelegatedRoleMembershipUnsupportedAssignmentAndInactiveCleanup(t *testing.T) {
	a, s, ownerToken, token, actor := roleReadFixture(t)
	owner, _ := s.Authenticate(t.Context(), ownerToken)
	target, err := s.CreateAccount(t.Context(), owner.UUID, "inactive-cleanup", "fixture-hash", false)
	if err != nil {
		t.Fatal(err)
	}
	for _, q := range []string{`INSERT INTO admin_permissions VALUES('future','unsupported',NULL)`, `INSERT INTO admin_role_permissions VALUES('low','future')`} {
		if _, err := s.writer.Exec(q); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := s.writer.Exec("INSERT INTO admin_privileges VALUES(?,'low')", target); err != nil {
		t.Fatal(err)
	}
	s.writer.Exec("UPDATE user_accounts SET is_active=0 WHERE uuid=?", target)
	detail := responseData(t, apiRequest(a, "GET", "/api/admin-roles/low", token, nil, nil))["role"].(map[string]any)
	if detail["member_changes_available"] != true || detail["member_assignment_available"] != false {
		t.Fatal(detail)
	}
	if w := apiRequest(a, "GET", "/api/admin-roles/low/candidates", token, nil, nil); w.Code != 409 {
		t.Fatal(w.Code)
	}
	member := responseData(t, apiRequest(a, "GET", "/api/admin-roles/low/users", token, nil, nil))["members"].([]any)[0].(map[string]any)
	if member["can_remove"] != true || member["is_active"] != false {
		t.Fatal(member)
	}
	w := apiRequest(a, "POST", "/api/admin-roles/low/memberships", token, membershipBody(actor, roleRevision(t, s), "remove", adminRoleTarget{target, 1}), nil)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
}
