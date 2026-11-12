package main

import (
	"database/sql"
	"encoding/json"
	"errors"
	"net/http/httptest"
	"testing"

	"github.com/coder/websocket/wsjson"
)

func TestDelegatedRoleChangesLifecycleCapabilitiesAndSocketRevocation(t *testing.T) {
	a, s, ownerToken, token, actor := roleReadFixture(t)
	owner, _ := s.Authenticate(t.Context(), ownerToken)
	child, err := s.CreateAccount(t.Context(), owner.UUID, "editable-child", "fixture-hash", false)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.AssignAdminRole(t.Context(), owner.UUID, child, "low"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.writer.Exec("INSERT INTO admin_role_permissions VALUES('low','admin')"); err != nil {
		t.Fatal(err)
	}
	session, err := s.issueSession(t.Context(), child, false)
	if err != nil {
		t.Fatal(err)
	}
	before := roleRevision(t, s)
	detail := responseData(t, apiRequest(a, "GET", "/api/admin-roles/low", token, nil, nil))
	role := detail["role"].(map[string]any)
	if detail["mutations_available"] != false || role["can_update"] != true || role["can_delete"] != false {
		t.Fatal(detail)
	}
	high := responseData(t, apiRequest(a, "GET", "/api/admin-roles/high", token, nil, nil))["role"].(map[string]any)
	if high["can_update"] != false || high["can_delete"] != false {
		t.Fatal(high)
	}
	server := httptest.NewServer(a)
	defer server.Close()
	conn, ctx := dialClient(t, server.URL, session.Access)
	defer conn.CloseNow()
	w := apiRequest(a, "PUT", "/api/admin-roles/low", token, roleChangeBody(actor, before, roleChangeValues("Delegated edit", 20)), nil)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	var reply map[string]any
	if err := wsjson.Read(ctx, conn, &reply); err == nil || ctx.Err() != nil {
		t.Fatal("socket not closed after permission commit", err)
	}
	if w := apiRequest(a, "GET", "/api/admin-roles", session.Access, nil, nil); w.Code != 403 {
		t.Fatal(w.Code)
	}
	if _, err := s.Authenticate(t.Context(), session.Access); err != nil {
		t.Fatal("existing session was revoked", err)
	}
	w = apiRequest(a, "POST", "/api/admin-roles/low/memberships", token, membershipBody(actor, roleRevision(t, s), "remove", adminRoleTarget{child, 1}), nil)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	role = responseData(t, apiRequest(a, "GET", "/api/admin-roles/low", token, nil, nil))["role"].(map[string]any)
	if role["can_delete"] != true {
		t.Fatal(role)
	}
	w = apiRequest(a, "DELETE", "/api/admin-roles/low", token, map[string]any{"expected_actor_uuid": actor, "snapshot_revision": roleRevision(t, s), "acknowledge_delete": true}, nil)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	if w := apiRequest(a, "GET", "/api/admin-roles/low", token, nil, nil); w.Code != 404 {
		t.Fatal(w.Code)
	}
	var raw string
	if err := s.reader.QueryRow("SELECT details FROM audit_events WHERE actor_uuid=? AND action='admin.role.update'", actor).Scan(&raw); err != nil {
		t.Fatal(err)
	}
	var audit adminRoleChangeAudit
	if err := json.Unmarshal([]byte(raw), &audit); err != nil || audit.Role != "low" || audit.BeforeRevision != before || len(audit.BeforePermissions) != 1 || len(audit.AfterPermissions) != 0 {
		t.Fatal(raw, err)
	}
}

func TestDelegatedRoleChangesRejectScopeAndStalePlans(t *testing.T) {
	for _, mode := range []string{"peer-role", "proposed-peer", "self-member", "peer-member", "inactive-peer", "cosmetic-target", "cosmetic-actor", "system", "owner-role", "unknown-permission", "stale", "session", "delete-assigned", "delete-unknown", "create", "reorder"} {
		t.Run(mode, func(t *testing.T) {
			a, s, ownerToken, token, actor := roleReadFixture(t)
			owner, _ := s.Authenticate(t.Context(), ownerToken)
			child, err := s.CreateAccount(t.Context(), owner.UUID, "edit-target", "fixture-hash", false)
			if err != nil {
				t.Fatal(err)
			}
			role, method, path, want := "low", "PUT", "", 403
			values := roleChangeValues("Attempted edit", 20)
			switch mode {
			case "peer-role":
				role = "high"
				values.Position = 10
			case "proposed-peer":
				values.Position = 50
			case "self-member":
				s.writer.Exec("INSERT INTO admin_privileges VALUES(?,'low')", actor)
			case "peer-member", "inactive-peer", "cosmetic-target":
				s.writer.Exec("INSERT INTO admin_privileges VALUES(?,'low')", child)
				if mode == "cosmetic-target" {
					s.writer.Exec("INSERT INTO admin_roles(id,name,position) VALUES('cosmetic','Cosmetic protection',500)")
					s.writer.Exec("INSERT INTO admin_privileges VALUES(?,'cosmetic')", child)
				} else {
					s.writer.Exec("INSERT INTO admin_privileges VALUES(?,'high')", child)
				}
				if mode == "inactive-peer" {
					s.writer.Exec("UPDATE user_accounts SET is_active=0 WHERE uuid=?", child)
				}
			case "cosmetic-actor":
				s.writer.Exec("INSERT INTO admin_roles(id,name,position) VALUES('cosmetic','Cosmetic boost',500)")
				s.writer.Exec("INSERT INTO admin_privileges VALUES(?,'cosmetic')", actor)
				values.Position = 100
			case "system":
				s.writer.Exec("UPDATE admin_roles SET is_auto_managed=1 WHERE id='low'")
			case "owner-role":
				s.writer.Exec("INSERT INTO admin_privileges VALUES(?,'low')", owner.UUID)
			case "unknown-permission", "delete-unknown":
				s.writer.Exec("INSERT INTO admin_permissions VALUES('future','future_permission',NULL)")
				s.writer.Exec("INSERT INTO admin_role_permissions VALUES('low','future')")
				want = 409
			case "stale":
				want = 409
			case "session":
				want = 401
			case "delete-assigned":
				s.writer.Exec("INSERT INTO admin_privileges VALUES(?,'low')", child)
				want = 409
			}
			before := roleRevision(t, s)
			body := roleChangeBody(actor, before, values)
			if mode == "stale" {
				body["snapshot_revision"] = int64(1)
			}
			if mode == "session" {
				s.writer.Exec("DELETE FROM app_sessions WHERE user_uuid=?", actor)
			}
			path = "/api/admin-roles/" + role
			if mode == "delete-assigned" || mode == "delete-unknown" {
				method = "DELETE"
				body = map[string]any{"expected_actor_uuid": actor, "snapshot_revision": before, "acknowledge_delete": true}
			}
			if mode == "create" {
				values.Position = 50
				body["role"] = values
				method = "POST"
				path = "/api/admin-roles"
			}
			if mode == "reorder" {
				method = "POST"
				path = "/api/admin-roles/reorder"
				body = map[string]any{"expected_actor_uuid": actor, "snapshot_revision": before, "positions": []adminRolePosition{{"low", 50}, {"high", 10}}}
			}
			if mode != "stale" && mode != "session" && mode != "create" && mode != "reorder" && mode != "proposed-peer" && mode != "cosmetic-actor" && mode != "delete-assigned" {
				r := responseData(t, apiRequest(a, "GET", "/api/admin-roles/"+role, token, nil, nil))["role"].(map[string]any)
				if r["can_update"] != false {
					t.Fatal("capability allowed blocked role", r)
				}
			}
			w := apiRequest(a, method, path, token, body, nil)
			if w.Code != want || roleRevision(t, s) != before {
				t.Fatal(mode, w.Code, w.Body.String())
			}
		})
	}
}

func TestDelegatedRoleChangesRollbackAndWriterAuthority(t *testing.T) {
	for _, mode := range []string{"rollback", "grant", "target", "position"} {
		t.Run(mode, func(t *testing.T) {
			_, s, ownerToken, token, actor := roleReadFixture(t)
			owner, _ := s.Authenticate(t.Context(), ownerToken)
			child, err := s.CreateAccount(t.Context(), owner.UUID, "prepared-edit", "fixture-hash", false)
			if err != nil {
				t.Fatal(err)
			}
			p := adminRoleChange{Actor: actor, Access: token, Revision: roleRevision(t, s), Operation: "update", ID: "low", Values: roleChangeValues("Prepared delegated", 20)}
			rollback := errors.New("rollback after full edit and audit")
			err = s.write(t.Context(), func(tx *sql.Tx) error {
				switch mode {
				case "grant":
					_, err = tx.Exec("DELETE FROM admin_role_permissions WHERE role_id='high'")
				case "target":
					_, err = tx.Exec("INSERT INTO admin_privileges VALUES(?,'low'),(?,'high')", child, child)
				case "position":
					_, err = tx.Exec("UPDATE admin_roles SET position=50 WHERE id='low'")
				}
				if err != nil {
					return err
				}
				if _, err := commitAdminRoleChange(t.Context(), tx, p); err != nil {
					return err
				}
				return rollback
			})
			if err == nil || mode == "rollback" && !errors.Is(err, rollback) {
				t.Fatal(err)
			}
			var name string
			s.reader.QueryRow("SELECT name FROM admin_roles WHERE id='low'").Scan(&name)
			if name != "administrator" || roleRevision(t, s) != p.Revision {
				t.Fatal("partial edit committed", name)
			}
		})
	}
}
