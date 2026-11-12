package main

import (
	"database/sql"
	"encoding/json"
	"errors"
	"testing"
)

func reorderPlan(t *testing.T, s *Store, changes map[string]int) []adminRolePosition {
	t.Helper()
	rows, err := s.reader.Query("SELECT id,position FROM admin_roles ORDER BY position,id")
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	order := []adminRolePosition{}
	for rows.Next() {
		var p adminRolePosition
		if err := rows.Scan(&p.ID, &p.Position); err != nil {
			t.Fatal(err)
		}
		if next, ok := changes[p.ID]; ok {
			p.Position = next
		}
		order = append(order, p)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return order
}

func TestDelegatedRoleReorderCompleteScopeLifecycleAndAudit(t *testing.T) {
	a, s, ownerToken, token, actor := roleReadFixture(t)
	owner, _ := s.Authenticate(t.Context(), ownerToken)
	child, err := s.CreateAccount(t.Context(), owner.UUID, "reorder-child", "fixture-hash", false)
	if err != nil {
		t.Fatal(err)
	}
	peer, err := s.CreateAccount(t.Context(), owner.UUID, "reorder-peer", "fixture-hash", false)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.writer.Exec(`INSERT INTO admin_roles(id,name,position,is_auto_managed) VALUES('middle','Movable',20,0),('guard','Peer shared',15,0),('cosmetic','Cosmetic actor',500,0),('system','System',90,1),('owner-role','Owner assigned',80,0)`); err != nil {
		t.Fatal(err)
	}
	for _, g := range []struct{ user, role string }{{child, "low"}, {child, "middle"}, {peer, "high"}, {peer, "guard"}, {actor, "cosmetic"}, {owner.UUID, "owner-role"}} {
		if _, err := s.writer.Exec("INSERT INTO admin_privileges VALUES(?,?)", g.user, g.role); err != nil {
			t.Fatal(err)
		}
	}
	session, err := s.issueSession(t.Context(), child, false)
	if err != nil {
		t.Fatal(err)
	}
	catalog := responseData(t, apiRequest(a, "GET", "/api/admin-roles", token, nil, nil))
	if catalog["mutations_available"] != false || catalog["reorder_available"] != true {
		t.Fatal(catalog)
	}
	for _, raw := range catalog["roles"].([]any) {
		r := raw.(map[string]any)
		want := r["id"] == "low" || r["id"] == "middle"
		if r["can_reorder"] != want {
			t.Fatal(r)
		}
		if want && r["reorder_max_position"] != float64(49) || !want && r["reorder_max_position"] != nil {
			t.Fatal(r)
		}
	}
	before := roleRevision(t, s)
	order := reorderPlan(t, s, map[string]int{"low": 20, "middle": 10})
	body := map[string]any{"expected_actor_uuid": actor, "snapshot_revision": before, "positions": order}
	w := apiRequest(a, "POST", "/api/admin-roles/reorder", token, body, nil)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	for _, p := range order {
		var position int
		s.reader.QueryRow("SELECT position FROM admin_roles WHERE id=?", p.ID).Scan(&position)
		if position != p.Position {
			t.Fatal(p, position)
		}
	}
	var raw string
	s.reader.QueryRow("SELECT details FROM audit_events WHERE actor_uuid=? AND action='admin.role.reorder'", actor).Scan(&raw)
	var audit adminRoleChangeAudit
	if err := json.Unmarshal([]byte(raw), &audit); err != nil || audit.BeforeRevision != before || audit.AfterRevision <= before || len(audit.BeforePositions) != len(order) || len(audit.AfterPositions) != len(order) {
		t.Fatal(raw, err)
	}
	if _, err := s.Authenticate(t.Context(), session.Access); err != nil {
		t.Fatal("reorder revoked session", err)
	}
	var grants int
	s.reader.QueryRow("SELECT count(*) FROM admin_privileges WHERE user_uuid=?", child).Scan(&grants)
	if grants != 2 {
		t.Fatal("reorder changed grants")
	}
	if w := apiRequest(a, "POST", "/api/admin-roles/reorder", token, body, nil); w.Code != 409 {
		t.Fatal("old revision replayed", w.Code)
	}
}

func TestDelegatedRoleReorderRejectsWholeInvalidPlanBeforeWrites(t *testing.T) {
	for _, mode := range []string{"peer-role", "proposed-peer", "cosmetic-actor", "self", "peer", "inactive-peer", "cosmetic-target", "system", "owner-role", "unknown-permission", "missing", "duplicate-id", "duplicate-position", "stale", "session", "no-op"} {
		t.Run(mode, func(t *testing.T) {
			a, s, ownerToken, token, actor := roleReadFixture(t)
			owner, _ := s.Authenticate(t.Context(), ownerToken)
			child, err := s.CreateAccount(t.Context(), owner.UUID, "scope-target", "fixture-hash", false)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := s.writer.Exec("INSERT INTO admin_roles(id,name,position) VALUES('middle','Middle',20)"); err != nil {
				t.Fatal(err)
			}
			changes := map[string]int{"low": 20, "middle": 10}
			want := 403
			switch mode {
			case "peer-role":
				changes = map[string]int{"high": 49}
			case "proposed-peer":
				changes["middle"] = 51
			case "cosmetic-actor":
				s.writer.Exec("INSERT INTO admin_roles(id,name,position) VALUES('cosmetic','Cosmetic boost',500)")
				s.writer.Exec("INSERT INTO admin_privileges VALUES(?,'cosmetic')", actor)
				changes["middle"] = 100
			case "self":
				s.writer.Exec("INSERT INTO admin_privileges VALUES(?,'middle')", actor)
			case "peer", "inactive-peer", "cosmetic-target":
				s.writer.Exec("INSERT INTO admin_privileges VALUES(?,'middle')", child)
				if mode == "cosmetic-target" {
					s.writer.Exec("INSERT INTO admin_roles(id,name,position) VALUES('cosmetic','Cosmetic target',500)")
					s.writer.Exec("INSERT INTO admin_privileges VALUES(?,'cosmetic')", child)
				} else {
					s.writer.Exec("INSERT INTO admin_privileges VALUES(?,'high')", child)
				}
				if mode == "inactive-peer" {
					s.writer.Exec("UPDATE user_accounts SET is_active=0 WHERE uuid=?", child)
				}
			case "system":
				s.writer.Exec("UPDATE admin_roles SET is_auto_managed=1 WHERE id='middle'")
			case "owner-role":
				s.writer.Exec("INSERT INTO admin_privileges VALUES(?,'middle')", owner.UUID)
			case "unknown-permission":
				s.writer.Exec("INSERT INTO admin_permissions VALUES('future','future_permission',NULL)")
				s.writer.Exec("INSERT INTO admin_role_permissions VALUES('middle','future')")
				want = 409
			case "missing", "duplicate-id", "duplicate-position", "stale", "no-op":
				want = 409
			case "session":
				s.writer.Exec("DELETE FROM app_sessions WHERE user_uuid=?", actor)
				want = 401
			}
			before := roleRevision(t, s)
			original := reorderPlan(t, s, nil)
			order := reorderPlan(t, s, changes)
			if mode == "missing" {
				order = order[:len(order)-1]
			}
			if mode == "duplicate-id" {
				order[1].ID = order[0].ID
			}
			if mode == "duplicate-position" {
				order[1].Position = order[0].Position
			}
			if mode == "no-op" {
				order = original
			}
			revision := before
			if mode == "stale" {
				revision = 1
			}
			w := apiRequest(a, "POST", "/api/admin-roles/reorder", token, map[string]any{"expected_actor_uuid": actor, "snapshot_revision": revision, "positions": order}, nil)
			if w.Code != want || roleRevision(t, s) != before {
				t.Fatal(mode, w.Code, w.Body.String())
			}
			for _, p := range original {
				var position int
				s.reader.QueryRow("SELECT position FROM admin_roles WHERE id=?", p.ID).Scan(&position)
				if position != p.Position {
					t.Fatal("partial order committed", p)
				}
			}
			var audits int
			s.reader.QueryRow("SELECT count(*) FROM audit_events WHERE action='admin.role.reorder'").Scan(&audits)
			if audits != 0 {
				t.Fatal("failed plan audited as success")
			}
		})
	}
}

func TestDelegatedRoleReorderWriterRollbackAndRevocation(t *testing.T) {
	for _, mode := range []string{"rollback", "grant", "target", "rank"} {
		t.Run(mode, func(t *testing.T) {
			_, s, _, token, actor := roleReadFixture(t)
			if _, err := s.writer.Exec("INSERT INTO admin_roles(id,name,position) VALUES('middle','Middle',20)"); err != nil {
				t.Fatal(err)
			}
			p := adminRoleChange{Actor: actor, Access: token, Revision: roleRevision(t, s), Operation: "reorder", Order: reorderPlan(t, s, map[string]int{"low": 20, "middle": 10})}
			rollback := errors.New("rollback after all role moves and exact audit")
			err := s.write(t.Context(), func(tx *sql.Tx) error {
				var err error
				switch mode {
				case "grant":
					_, err = tx.Exec("DELETE FROM admin_role_permissions WHERE role_id='high'")
				case "target":
					_, err = tx.Exec("INSERT INTO admin_privileges VALUES(?,'middle')", actor)
				case "rank":
					_, err = tx.Exec("UPDATE admin_roles SET position=10 WHERE id='high'")
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
			var position int
			s.reader.QueryRow("SELECT position FROM admin_roles WHERE id='low'").Scan(&position)
			if position != 10 || roleRevision(t, s) != p.Revision {
				t.Fatal("partial order survived rollback")
			}
			if mode == "rollback" {
				if err := s.write(t.Context(), func(tx *sql.Tx) error { _, err := commitAdminRoleChange(t.Context(), tx, p); return err }); err != nil {
					t.Fatal(err)
				}
			}
		})
	}
}

func TestDelegatedRoleReorderUnavailableWhenEveryRoleIsFixed(t *testing.T) {
	a, s, _, token, actor := roleReadFixture(t)
	if _, err := s.writer.Exec("INSERT INTO admin_privileges VALUES(?,'low')", actor); err != nil {
		t.Fatal(err)
	}
	catalog := responseData(t, apiRequest(a, "GET", "/api/admin-roles", token, nil, nil))
	if catalog["reorder_available"] != false {
		t.Fatal(catalog)
	}
	for _, raw := range catalog["roles"].([]any) {
		role := raw.(map[string]any)
		if role["can_reorder"] != false || role["reorder_max_position"] != nil {
			t.Fatal(role)
		}
	}
}
