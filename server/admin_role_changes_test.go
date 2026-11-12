package main

import (
	"database/sql"
	"encoding/json"
	"errors"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/coder/websocket/wsjson"
)

func roleChangeValues(name string, position int, permissions ...string) adminRoleValues {
	ids := []string{}
	ids = append(ids, permissions...)
	return adminRoleValues{Name: name, Position: position, Badge: "default", Permissions: ids}
}
func roleRevision(t *testing.T, s *Store) int64 {
	t.Helper()
	var revision int64
	if err := s.reader.QueryRow("SELECT revision FROM admin_role_state").Scan(&revision); err != nil {
		t.Fatal(err)
	}
	return revision
}
func roleChangeBody(actor string, revision int64, values adminRoleValues) map[string]any {
	return map[string]any{"expected_actor_uuid": actor, "snapshot_revision": revision, "role": values}
}

func TestAdminRoleChangesOwnerLifecycleAndStaleRevision(t *testing.T) {
	a, s, token, _, _ := roleReadFixture(t)
	owner, _ := s.Authenticate(t.Context(), token)
	before := roleRevision(t, s)
	w := apiRequest(a, "POST", "/api/admin-roles", token, roleChangeBody(owner.UUID, before, roleChangeValues("Created", 20, "admin")), nil)
	if w.Code != 201 {
		t.Fatal(w.Code, w.Body.String())
	}
	data := responseData(t, w)
	id := data["role_id"].(string)
	revision := int64(data["snapshot_revision"].(float64))
	if revision <= before {
		t.Fatal(data)
	}
	if w := apiRequest(a, "PUT", "/api/admin-roles/"+id, token, roleChangeBody(owner.UUID, before, roleChangeValues("Stale", 21)), nil); w.Code != 409 {
		t.Fatal("stale write", w.Code)
	}
	w = apiRequest(a, "PUT", "/api/admin-roles/"+id, token, roleChangeBody(owner.UUID, revision, roleChangeValues("Updated", 21)), nil)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	revision = roleRevision(t, s)
	w = apiRequest(a, "DELETE", "/api/admin-roles/"+id, token, map[string]any{"expected_actor_uuid": owner.UUID, "snapshot_revision": revision, "acknowledge_delete": true}, nil)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	if w := apiRequest(a, "GET", "/api/admin-roles/"+id, token, nil, nil); w.Code != 404 {
		t.Fatal("deleted role present")
	}
	var audits int
	s.reader.QueryRow("SELECT count(*) FROM audit_events WHERE action IN ('admin.role.create','admin.role.update','admin.role.delete')").Scan(&audits)
	if audits != 3 {
		t.Fatal(audits)
	}
	var encoded string
	if err := s.reader.QueryRow("SELECT details FROM audit_events WHERE action='admin.role.create'").Scan(&encoded); err != nil {
		t.Fatal(err)
	}
	var audit adminRoleChangeAudit
	if err := json.Unmarshal([]byte(encoded), &audit); err != nil || audit.Role != id || audit.BeforeRevision != before || audit.AfterRevision <= before || len(audit.AfterPermissions) != 1 || audit.AfterPermissions[0] != "admin" {
		t.Fatal("missing exact role audit", err, encoded)
	}
}

func TestAdminRoleChangesRejectDelegatedProtectedAssignedAndUnsupported(t *testing.T) {
	a, s, token, admin, _ := roleReadFixture(t)
	owner, _ := s.Authenticate(t.Context(), token)
	delegate, _ := s.Authenticate(t.Context(), admin)
	r := httptest.NewRequest("POST", "/api/admin-roles", strings.NewReader("{}"))
	r.Header.Set("Origin", "https://foreign.invalid")
	r.Header.Set("Authorization", "Bearer "+token)
	recorder := httptest.NewRecorder()
	a.ServeHTTP(recorder, r)
	if recorder.Code != 403 {
		t.Fatal("foreign origin admitted", recorder.Code)
	}
	if w := apiRequest(a, "POST", "/api/admin-roles", admin, roleChangeBody(delegate.UUID, roleRevision(t, s), roleChangeValues("Escalation", 100, "admin")), nil); w.Code != 403 {
		t.Fatal("delegated write admitted", w.Code)
	}
	if _, err := s.writer.Exec("INSERT INTO admin_roles(id,name,is_auto_managed,position) VALUES('auto','System',1,80),('owner-role','Owner assigned',0,90)"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.writer.Exec("INSERT INTO admin_privileges VALUES(?,'owner-role')", owner.UUID); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"auto", "owner-role"} {
		if w := apiRequest(a, "PUT", "/api/admin-roles/"+id, token, roleChangeBody(owner.UUID, roleRevision(t, s), roleChangeValues("Protected", 50)), nil); w.Code != 403 {
			t.Fatal(id, w.Code, w.Body.String())
		}
	}
	if w := apiRequest(a, "DELETE", "/api/admin-roles/high", token, map[string]any{"expected_actor_uuid": owner.UUID, "snapshot_revision": roleRevision(t, s), "acknowledge_delete": true}, nil); w.Code != 409 {
		t.Fatal("assigned role deleted", w.Code)
	}
	for _, mode := range []string{"unknown", "permission", "color", "missing", "target", "consent"} {
		t.Run(mode, func(t *testing.T) {
			body := roleChangeBody(owner.UUID, roleRevision(t, s), roleChangeValues("Valid", 20))
			want := 400
			switch mode {
			case "unknown":
				body["grant_owner"] = true
			case "permission":
				body["role"] = roleChangeValues("Valid", 20, "future")
			case "color":
				v := roleChangeValues("Valid", 20)
				color := "url(unsafe)"
				v.Color = &color
				body["role"] = v
			case "missing":
				body["role"] = map[string]any{"name": "Incomplete"}
			case "target":
				body["expected_actor_uuid"] = delegate.UUID
				want = 403
			case "consent":
				body["acknowledge_delete"] = true
			}
			if w := apiRequest(a, "POST", "/api/admin-roles", token, body, nil); w.Code != want {
				t.Fatal(mode, w.Code, w.Body.String())
			}
		})
	}
}

func TestAdminRoleChangesPreserveUnknownStoredPermissions(t *testing.T) {
	a, s, token, _, _ := roleReadFixture(t)
	owner, _ := s.Authenticate(t.Context(), token)
	if _, err := s.writer.Exec("INSERT INTO admin_permissions(id,name) VALUES('future','future_permission')"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.writer.Exec("INSERT INTO admin_role_permissions VALUES('low','future')"); err != nil {
		t.Fatal(err)
	}
	before := roleRevision(t, s)
	if w := apiRequest(a, "PUT", "/api/admin-roles/low", token, roleChangeBody(owner.UUID, before, roleChangeValues("Would drop unknown data", 10)), nil); w.Code != 409 {
		t.Fatal(w.Code, w.Body.String())
	}
	if roleRevision(t, s) != before {
		t.Fatal("unknown permission reset changed catalog")
	}
}

func TestAdminRolePermissionRevocationClosesLiveSocket(t *testing.T) {
	a, s, token, admin, _ := roleReadFixture(t)
	owner, _ := s.Authenticate(t.Context(), token)
	server := httptest.NewServer(a)
	defer server.Close()
	conn, ctx := dialClient(t, server.URL, admin)
	defer conn.CloseNow()
	w := apiRequest(a, "PUT", "/api/admin-roles/high", token, roleChangeBody(owner.UUID, roleRevision(t, s), roleChangeValues("Not a permission name", 50)), nil)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	var reply map[string]any
	if err := wsjson.Read(ctx, conn, &reply); err == nil || ctx.Err() != nil {
		t.Fatal("socket not closed before deadline", err)
	}
	if w := apiRequest(a, "GET", "/api/admin-roles", admin, nil, nil); w.Code != 403 {
		t.Fatal("revoked permission survives")
	}
	if _, err := s.Authenticate(t.Context(), admin); err != nil {
		t.Fatal("role revocation unexpectedly deleted login session")
	}
}

func TestAdminRoleReorderAtomicCompleteAndProtected(t *testing.T) {
	a, s, token, _, _ := roleReadFixture(t)
	owner, _ := s.Authenticate(t.Context(), token)
	if w := apiRequest(a, "POST", "/api/admin-roles/reorder", token, map[string]any{"expected_actor_uuid": owner.UUID, "snapshot_revision": roleRevision(t, s), "positions": []map[string]any{{"id": "high"}, {"id": "low", "position": 10}}}, nil); w.Code != 400 {
		t.Fatal("omitted position defaulted to zero", w.Code)
	}
	for _, mode := range []string{"missing", "duplicate", "positions", "unknown"} {
		t.Run(mode, func(t *testing.T) {
			order := []adminRolePosition{{"high", 10}, {"low", 50}}
			switch mode {
			case "missing":
				order = order[:1]
			case "duplicate":
				order[1].ID = "high"
			case "positions":
				order[1].Position = 10
			case "unknown":
				order[1].ID = "absent"
			}
			before := roleRevision(t, s)
			w := apiRequest(a, "POST", "/api/admin-roles/reorder", token, map[string]any{"expected_actor_uuid": owner.UUID, "snapshot_revision": before, "positions": order}, nil)
			if w.Code != 409 {
				t.Fatal(w.Code, w.Body.String())
			}
			if roleRevision(t, s) != before {
				t.Fatal("rejected order changed revision")
			}
		})
	}
	before := roleRevision(t, s)
	p := adminRoleChange{Actor: owner.UUID, Access: token, Revision: before, Operation: "reorder", Order: []adminRolePosition{{"high", 10}, {"low", 50}}}
	rollback := errors.New("fixture rollback after whole reorder")
	err := s.write(t.Context(), func(tx *sql.Tx) error {
		if _, err := commitAdminRoleChange(t.Context(), tx, p); err != nil {
			return err
		}
		return rollback
	})
	if !errors.Is(err, rollback) || roleRevision(t, s) != before {
		t.Fatal(err)
	}
	var pos int
	s.reader.QueryRow("SELECT position FROM admin_roles WHERE id='high'").Scan(&pos)
	if pos != 50 {
		t.Fatal("partial order survived rollback")
	}
	w := apiRequest(a, "POST", "/api/admin-roles/reorder", token, map[string]any{"expected_actor_uuid": owner.UUID, "snapshot_revision": before, "positions": p.Order}, nil)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	s.reader.QueryRow("SELECT position FROM admin_roles WHERE id='high'").Scan(&pos)
	if pos != 10 {
		t.Fatal(pos)
	}
	if _, err := s.writer.Exec("UPDATE admin_roles SET is_auto_managed=1 WHERE id='low'"); err != nil {
		t.Fatal(err)
	}
	w = apiRequest(a, "POST", "/api/admin-roles/reorder", token, map[string]any{"expected_actor_uuid": owner.UUID, "snapshot_revision": roleRevision(t, s), "positions": []adminRolePosition{{"high", 50}, {"low", 10}}}, nil)
	if w.Code != 403 {
		t.Fatal("protected role moved", w.Code)
	}
}

func TestAdminRoleChangesPreparedSessionRollbackAndCompetition(t *testing.T) {
	for _, mode := range []string{"session", "revision", "rollback"} {
		t.Run(mode, func(t *testing.T) {
			_, s, token, _, _ := roleReadFixture(t)
			owner, _ := s.Authenticate(t.Context(), token)
			p := adminRoleChange{Actor: owner.UUID, Access: token, Revision: roleRevision(t, s), Operation: "create", ID: newUUID(), Values: roleChangeValues("Prepared", 25)}
			if mode == "session" {
				s.writer.Exec("DELETE FROM app_sessions WHERE user_uuid=?", owner.UUID)
			}
			if mode == "revision" {
				s.writer.Exec("UPDATE admin_roles SET position=position+1 WHERE id='low'")
			}
			rollback := errors.New("rollback")
			err := s.write(t.Context(), func(tx *sql.Tx) error {
				if _, err := commitAdminRoleChange(t.Context(), tx, p); err != nil {
					return err
				}
				if mode == "rollback" {
					return rollback
				}
				return nil
			})
			if err == nil {
				t.Fatal("invalid prepared write committed")
			}
			if mode == "rollback" {
				if !errors.Is(err, rollback) {
					t.Fatal(err)
				}
				if err := s.write(t.Context(), func(tx *sql.Tx) error { _, err := commitAdminRoleChange(t.Context(), tx, p); return err }); err != nil {
					t.Fatal(err)
				}
				if err := s.write(t.Context(), func(tx *sql.Tx) error { _, err := commitAdminRoleChange(t.Context(), tx, p); return err }); err == nil {
					t.Fatal("duplicate/stale mutation committed")
				}
			}
		})
	}
}
