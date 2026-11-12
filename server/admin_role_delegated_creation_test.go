package main

import (
	"database/sql"
	"encoding/json"
	"errors"
	"testing"
)

func TestDelegatedRoleCreationCapabilityLifecycleAndAudit(t *testing.T) {
	a, s, _, token, actor := roleReadFixture(t)
	if _, err := s.writer.Exec("INSERT INTO admin_roles(id,name,position) VALUES('cosmetic','Cosmetic boost',500)"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.writer.Exec("INSERT INTO admin_privileges VALUES(?,'cosmetic')", actor); err != nil {
		t.Fatal(err)
	}
	catalog := responseData(t, apiRequest(a, "GET", "/api/admin-roles", token, nil, nil))
	capability := catalog["creation"].(map[string]any)
	if catalog["mutations_available"] != false || capability["available"] != true || capability["max_position"] != float64(49) {
		t.Fatal(catalog)
	}
	before := roleRevision(t, s)
	w := apiRequest(a, "POST", "/api/admin-roles", token, roleChangeBody(actor, before, roleChangeValues("Delegated creation", 49, "admin")), nil)
	if w.Code != 201 {
		t.Fatal(w.Code, w.Body.String())
	}
	data := responseData(t, w)
	id := data["role_id"].(string)
	role := responseData(t, apiRequest(a, "GET", "/api/admin-roles/"+id, token, nil, nil))["role"].(map[string]any)
	if role["position"] != float64(49) || role["user_count"] != float64(0) || role["can_update"] != true || role["can_delete"] != true {
		t.Fatal(role)
	}
	var raw string
	if err := s.reader.QueryRow("SELECT details FROM audit_events WHERE actor_uuid=? AND action='admin.role.create'", actor).Scan(&raw); err != nil {
		t.Fatal(err)
	}
	var audit adminRoleChangeAudit
	if err := json.Unmarshal([]byte(raw), &audit); err != nil || audit.Role != id || audit.BeforeRevision != before || audit.AfterRevision <= before || len(audit.AfterPermissions) != 1 {
		t.Fatal(raw, err)
	}
	if w := apiRequest(a, "POST", "/api/admin-roles", token, roleChangeBody(actor, before, roleChangeValues("Stale create", 1)), nil); w.Code != 409 {
		t.Fatal(w.Code)
	}
	w = apiRequest(a, "DELETE", "/api/admin-roles/"+id, token, map[string]any{"expected_actor_uuid": actor, "snapshot_revision": roleRevision(t, s), "acknowledge_delete": true}, nil)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
}

func TestDelegatedRoleCreationRejectsCeilingsAndUnsupportedGrants(t *testing.T) {
	for _, mode := range []string{"equal", "higher", "cosmetic", "zero", "inactive", "expired", "logout", "revoked", "unsupported", "stale", "duplicate"} {
		t.Run(mode, func(t *testing.T) {
			a, s, _, token, actor := roleReadFixture(t)
			values := roleChangeValues("New role", 1)
			want := 403
			switch mode {
			case "equal":
				values.Position = 50
			case "higher":
				values.Position = 51
			case "cosmetic":
				s.writer.Exec("INSERT INTO admin_roles(id,name,position) VALUES('cosmetic','Cosmetic actor',500)")
				s.writer.Exec("INSERT INTO admin_privileges VALUES(?,'cosmetic')", actor)
				values.Position = 100
			case "zero":
				s.writer.Exec("UPDATE admin_roles SET position=0 WHERE id='high'")
				values.Position = 0
			case "inactive":
				s.writer.Exec("UPDATE user_accounts SET is_active=0 WHERE uuid=?", actor)
				want = 401
			case "expired":
				s.writer.Exec("UPDATE user_accounts SET access_expires_at='2000-01-01T00:00:00Z' WHERE uuid=?", actor)
				want = 401
			case "logout":
				s.writer.Exec("DELETE FROM app_sessions WHERE user_uuid=?", actor)
				want = 401
			case "revoked":
				s.writer.Exec("DELETE FROM admin_role_permissions WHERE role_id='high'")
			case "unsupported":
				values.Permissions = []string{"future"}
				want = 400
			case "stale":
				want = 409
			case "duplicate":
				values.Name = "administrator"
				want = 409
			}
			before := roleRevision(t, s)
			revision := before
			if mode == "stale" {
				revision = 1
			}
			if mode == "zero" {
				cap := responseData(t, apiRequest(a, "GET", "/api/admin-roles", token, nil, nil))["creation"].(map[string]any)
				if cap["available"] != false || cap["max_position"] != nil {
					t.Fatal(cap)
				}
			}
			w := apiRequest(a, "POST", "/api/admin-roles", token, roleChangeBody(actor, revision, values), nil)
			if w.Code != want || roleRevision(t, s) != before {
				t.Fatal(mode, w.Code, w.Body.String())
			}
		})
	}
}

func TestDelegatedRoleCreationCatalogCapacityAndRollback(t *testing.T) {
	for _, mode := range []string{"capacity", "rollback", "grant", "ceiling"} {
		t.Run(mode, func(t *testing.T) {
			a, s, _, token, actor := roleReadFixture(t)
			if mode == "capacity" {
				if _, err := s.writer.Exec(`WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<998) INSERT INTO admin_roles(id,name,position) SELECT 'filled-'||i,'Filled '||i,1 FROM n`); err != nil {
					t.Fatal(err)
				}
				catalog := responseData(t, apiRequest(a, "GET", "/api/admin-roles", token, nil, nil))
				cap := catalog["creation"].(map[string]any)
				if cap["available"] != false || cap["max_position"] != nil {
					t.Fatal(cap)
				}
			}
			p := adminRoleChange{Actor: actor, Access: token, Revision: roleRevision(t, s), Operation: "create", ID: newUUID(), Values: roleChangeValues("Prepared creation", 10, "admin")}
			rollback := errors.New("rollback after complete creation and audit")
			err := s.write(t.Context(), func(tx *sql.Tx) error {
				if mode == "grant" {
					if _, err := tx.Exec("DELETE FROM admin_role_permissions WHERE role_id='high'"); err != nil {
						return err
					}
				}
				if mode == "ceiling" {
					if _, err := tx.Exec("UPDATE admin_roles SET position=0 WHERE id='high'"); err != nil {
						return err
					}
				}
				if _, err := commitAdminRoleChange(t.Context(), tx, p); err != nil {
					return err
				}
				return rollback
			})
			if err == nil || mode == "rollback" && !errors.Is(err, rollback) {
				t.Fatal(err)
			}
			var count int
			s.reader.QueryRow("SELECT count(*) FROM admin_roles WHERE id=?", p.ID).Scan(&count)
			if count != 0 || roleRevision(t, s) != p.Revision {
				t.Fatal("partial creation survived")
			}
			if mode == "rollback" {
				if err := s.write(t.Context(), func(tx *sql.Tx) error { _, err := commitAdminRoleChange(t.Context(), tx, p); return err }); err != nil {
					t.Fatal(err)
				}
				p.ID = newUUID()
				if err := s.write(t.Context(), func(tx *sql.Tx) error { _, err := commitAdminRoleChange(t.Context(), tx, p); return err }); !errors.Is(err, ErrConflict) {
					t.Fatal("stale competing create admitted", err)
				}
			}
		})
	}
}
