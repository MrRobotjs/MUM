package main

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"
)

func roleReadFixture(t *testing.T) (*App, *Store, string, string, string) {
	t.Helper()
	a, s := testApp(t)
	token, _ := bootstrapOwner(t, a)
	owner, _ := s.Authenticate(t.Context(), token)
	user, err := s.CreateAccount(t.Context(), owner.UUID, "role-reader", "fixture-hash", false)
	if err != nil {
		t.Fatal(err)
	}
	for _, q := range []string{`INSERT INTO admin_roles(id,name,position) VALUES('high','Not a permission name',50),('low','administrator',10)`, `INSERT INTO admin_role_permissions VALUES('high','admin')`} {
		if _, err := s.writer.Exec(q); err != nil {
			t.Fatal(err)
		}
	}
	if err := s.AssignAdminRole(t.Context(), owner.UUID, user, "high"); err != nil {
		t.Fatal(err)
	}
	session, err := s.issueSession(t.Context(), user, false)
	if err != nil {
		t.Fatal(err)
	}
	return a, s, token, session.Access, user
}

func TestAdminRoleReadsFreshCatalogAndSupportedPermission(t *testing.T) {
	a, _ := testApp(t)
	token, _ := bootstrapOwner(t, a)
	w := apiRequest(a, "GET", "/api/admin-roles", token, nil, nil)
	data := responseData(t, w)
	if w.Code != 200 || len(data["roles"].([]any)) != 0 || data["mutations_available"] != true || data["snapshot_revision"] != float64(1) {
		t.Fatal(w.Code, data)
	}
	w = apiRequest(a, "GET", "/api/admin-permissions", token, nil, nil)
	data = responseData(t, w)
	items := data["permissions"].([]any)
	if len(items) != 1 || items[0].(map[string]any)["name"] != "administrator" || items[0].(map[string]any)["implemented"] != true {
		t.Fatal(data)
	}
	if w.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("cacheable roles")
	}
}

func TestAdminRoleReadsMembershipNotNamesAndRedaction(t *testing.T) {
	a, s, owner, admin, user := roleReadFixture(t)
	for _, path := range []string{"/api/admin-roles", "/api/admin-roles/high", "/api/admin-permissions", "/api/admin-roles/high/users"} {
		w := apiRequest(a, "GET", path, admin, nil, nil)
		if w.Code != 200 {
			t.Fatal(path, w.Code, w.Body.String())
		}
		data := responseData(t, w)
		if data["actor_uuid"] != user || data["mutations_available"] != false {
			t.Fatal(data)
		}
		for _, secret := range []string{"password_hash", "fixture-hash", "refresh_hash", "legacy_metadata", "discord_access_token"} {
			if contains := strings.Contains(w.Body.String(), secret); contains {
				t.Fatal("leaked field", secret)
			}
		}
	}
	w := apiRequest(a, "GET", "/api/admin-roles/high", owner, nil, nil)
	role := responseData(t, w)["role"].(map[string]any)
	if role["name"] != "Not a permission name" || role["user_count"] != float64(1) || len(role["permissions"].([]any)) != 1 {
		t.Fatal(role)
	}
	if _, err := s.writer.Exec("DELETE FROM admin_role_permissions WHERE role_id='high'"); err != nil {
		t.Fatal(err)
	}
	if w := apiRequest(a, "GET", "/api/admin-roles", admin, nil, nil); w.Code != 403 {
		t.Fatal("name or old session supplied permission", w.Code)
	}
	if _, err := s.writer.Exec("INSERT INTO admin_privileges VALUES(?,'low')", user); err != nil {
		t.Fatal(err)
	}
	if w := apiRequest(a, "GET", "/api/admin-roles", admin, nil, nil); w.Code != 403 {
		t.Fatal("administrator role name granted access")
	}
}

func TestAdminRoleReadsStrictQueriesAndUnavailableWrites(t *testing.T) {
	a, _, owner, _, _ := roleReadFixture(t)
	for _, sample := range []struct {
		path string
		want int
	}{{"/api/admin-roles?include_permissions=true", 400}, {"/api/admin-permissions?all=true", 400}, {"/api/admin-roles/high/users?after=bad", 400}, {"/api/admin-roles/high/users?after=12345678-1234-1234-1234-123456789abc&after=12345678-1234-1234-1234-123456789abc", 400}, {"/api/admin-roles/missing", 404}, {"/api/admin-roles/missing/users", 404}} {
		if w := apiRequest(a, "GET", sample.path, owner, nil, nil); w.Code != sample.want {
			t.Fatal(sample.path, w.Code, w.Body.String())
		}
	}
	if w := apiRequest(a, "GET", "/api/admin-roles", "", nil, nil); w.Code != 401 {
		t.Fatal(w.Code)
	}
}

func TestAdminRoleReadRechecksSessionAndPermission(t *testing.T) {
	for _, mode := range []string{"session", "permission", "expiry"} {
		t.Run(mode, func(t *testing.T) {
			a, s, _, admin, user := roleReadFixture(t)
			actor, err := s.Authenticate(t.Context(), admin)
			if err != nil {
				t.Fatal(err)
			}
			switch mode {
			case "session":
				_, err = s.writer.Exec("DELETE FROM app_sessions WHERE user_uuid=?", user)
			case "permission":
				_, err = s.writer.Exec("DELETE FROM admin_privileges WHERE user_uuid=?", user)
			case "expiry":
				_, err = s.writer.Exec("UPDATE user_accounts SET access_expires_at='2000-01-01T00:00:00Z' WHERE uuid=?", user)
			}
			if err != nil {
				t.Fatal(err)
			}
			if tx, err := a.beginAdminRoleRead(t.Context(), actor.UUID, admin); err == nil {
				tx.Rollback()
				t.Fatal("stale principal admitted")
			}
		})
	}
}

func TestAdminRoleMembershipPagesAndRevisionInvalidation(t *testing.T) {
	a, s, owner, _, user := roleReadFixture(t)
	err := s.write(t.Context(), func(tx *sql.Tx) error {
		for i := 0; i < 101; i++ {
			id := fmt.Sprintf("00000000-0000-4000-8000-%012d", i)
			if _, err := tx.Exec("INSERT INTO identities(uuid,kind) VALUES(?,'local')", id); err != nil {
				return err
			}
			if _, err := tx.Exec("INSERT INTO user_accounts(uuid,kind,local_username,created_at,updated_at) VALUES(?,'local',?,'fixture','fixture')", id, fmt.Sprintf("member-%d", i)); err != nil {
				return err
			}
			if _, err := tx.Exec("INSERT INTO admin_privileges VALUES(?,'low')", id); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	first := responseData(t, apiRequest(a, "GET", "/api/admin-roles/low/users", owner, nil, nil))
	if len(first["members"].([]any)) != 100 || first["total"] != float64(101) {
		t.Fatal(first)
	}
	cursor := first["next_after"].(string)
	second := responseData(t, apiRequest(a, "GET", "/api/admin-roles/low/users?after="+cursor, owner, nil, nil))
	if len(second["members"].([]any)) != 1 || second["next_after"] != nil || second["snapshot_revision"] != first["snapshot_revision"] {
		t.Fatal(second)
	}
	var before, after int64
	s.reader.QueryRow("SELECT revision FROM admin_role_state").Scan(&before)
	if _, err := s.writer.Exec("UPDATE user_accounts SET local_username='ROLE-READER' WHERE uuid=?", user); err != nil {
		t.Fatal(err)
	}
	s.reader.QueryRow("SELECT revision FROM admin_role_state").Scan(&after)
	if after <= before {
		t.Fatal("case-only member rename did not invalidate snapshot")
	}
	rollback := errors.New("fixture rollback")
	err = s.write(t.Context(), func(tx *sql.Tx) error {
		if _, err := tx.Exec("DELETE FROM admin_privileges WHERE role_id='low'"); err != nil {
			return err
		}
		return rollback
	})
	if !errors.Is(err, rollback) {
		t.Fatal(err)
	}
	var restored int64
	s.reader.QueryRow("SELECT revision FROM admin_role_state").Scan(&restored)
	if restored != after {
		t.Fatal("rollback advanced revision")
	}
	w := apiRequest(a, "GET", "/api/admin-roles/low/users", owner, nil, nil)
	var envelope map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &envelope); err != nil {
		t.Fatal(err)
	}
	if envelope["data"].(map[string]any)["snapshot_revision"] == first["snapshot_revision"] {
		t.Fatal("changed snapshot reused")
	}
}
