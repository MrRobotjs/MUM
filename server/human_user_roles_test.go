package main

import (
	"encoding/json"
	"sync"
	"testing"
)

func humanRolesBody(p map[string]any, ids any) map[string]any {
	return map[string]any{"expected_actor_uuid": p["actor_uuid"], "expected_user_uuid": p["user_uuid"], "catalog_revision": p["catalog_revision"], "profile_revision": p["profile_revision"], "role_revision": p["role_revision"], "manual_role_ids": ids, "acknowledge_visual_only": true}
}
func userRoleCreateBody(p map[string]any, name string) map[string]any {
	return map[string]any{"expected_actor_uuid": p["actor_uuid"], "catalog_revision": p["catalog_revision"], "role_revision": p["role_revision"], "name": name}
}
func humanRolesFixture(t *testing.T) (*App, *Store, string, string, string, string) {
	t.Helper()
	a, s, owner, admin, actor := roleReadFixture(t)
	removeAutomaticRoles(t, s)
	p, _ := s.Authenticate(t.Context(), owner)
	target, err := s.CreateAccount(t.Context(), p.UUID, "role-label-target", "fixture-hash", false)
	if err != nil {
		t.Fatal(err)
	}
	for _, query := range []string{`INSERT INTO user_roles(id,name,is_auto_managed) VALUES('manual-a','Family',0),('manual-b','Friend',0),('automatic','Automatic',1)`, `INSERT INTO identity_user_roles VALUES('` + target + `','automatic')`} {
		if _, err = s.writer.Exec(query); err != nil {
			t.Fatal(err)
		}
	}
	return a, s, owner, admin, actor, target
}

func TestHumanUserRolesCreationAssignmentPreservesAutomaticServiceAndAuthority(t *testing.T) {
	a, s, owner, _, _, target := humanRolesFixture(t)
	path := "/api/users/" + target + "/user-roles"
	session, err := s.issueSession(t.Context(), target, false)
	if err != nil {
		t.Fatal(err)
	}
	service := seedService(t, s, seedServer(t, s))
	if _, err = s.writer.Exec("INSERT INTO identity_user_roles VALUES(?,'manual-b')", service); err != nil {
		t.Fatal(err)
	}
	base := responseData(t, apiRequest(a, "GET", path, owner, nil, nil))
	created := responseData(t, apiRequest(a, "POST", "/api/user-role-catalog", owner, userRoleCreateBody(base, "administrator"), nil))
	id := created["role_id"].(string)
	base = responseData(t, apiRequest(a, "GET", path, owner, nil, nil))
	after := responseData(t, apiRequest(a, "PUT", path, owner, humanRolesBody(base, []string{id, "manual-a"}), nil))
	if after["profile_revision"] != "2" || after["can_edit"] != true {
		t.Fatal(after)
	}
	p, err := s.Authenticate(t.Context(), session.Access)
	if err != nil || p.Admin {
		t.Fatal("visual role changed session or permission", p, err)
	}
	if _, _, err = s.refreshSession(t.Context(), session.Refresh); err != nil {
		t.Fatal("visual role revoked refresh", err)
	}
	var intact bool
	if err = s.reader.QueryRow(`SELECT EXISTS(SELECT 1 FROM identity_user_roles WHERE user_uuid=? AND role_id='automatic') AND EXISTS(SELECT 1 FROM identity_user_roles WHERE user_uuid=? AND role_id='manual-b') AND (SELECT is_active=1 FROM service_accounts WHERE uuid=?)`, target, service, service).Scan(&intact); err != nil || !intact {
		t.Fatal("automatic/service state changed", err)
	}
	profile := responseData(t, apiRequest(a, "GET", "/api/users/"+target, owner, nil, nil))
	if len(profile["user_roles"].([]any)) != 3 || len(profile["admin_roles"].([]any)) != 0 {
		t.Fatal(profile)
	}
	responseData(t, apiRequest(a, "PUT", path, owner, humanRolesBody(after, []string{}), nil))
	var n int
	if err = s.reader.QueryRow("SELECT count(*) FROM identity_user_roles WHERE user_uuid=?", target).Scan(&n); err != nil || n != 1 {
		t.Fatal("explicit clear removed automatic role", n, err)
	}
	rows, err := s.reader.Query("SELECT details FROM audit_events WHERE action='account.user_roles.change' ORDER BY id")
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	audits := 0
	for rows.Next() {
		var raw string
		if err = rows.Scan(&raw); err != nil {
			t.Fatal(err)
		}
		var audit struct {
			Before    []string `json:"before_manual_role_ids"`
			After     []string `json:"after_manual_role_ids"`
			Automatic []string `json:"retained_auto_role_ids"`
		}
		if err = json.Unmarshal([]byte(raw), &audit); err != nil {
			t.Fatal(err)
		}
		if len(audit.Automatic) != 1 || audit.Automatic[0] != "automatic" || audit.Before == nil || audit.After == nil {
			t.Fatal(raw)
		}
		audits++
	}
	if err = rows.Err(); err != nil || audits != 2 {
		t.Fatal(audits, err)
	}
}

func TestHumanUserRolesDelegatedScopeAndReadDenial(t *testing.T) {
	a, s, owner, admin, actor, target := humanRolesFixture(t)
	path := "/api/users/" + target + "/user-roles"
	base := responseData(t, apiRequest(a, "GET", path, admin, nil, nil))
	if base["can_create"] != false || base["can_edit"] != true {
		t.Fatal(base)
	}
	if w := apiRequest(a, "POST", "/api/user-role-catalog", admin, userRoleCreateBody(base, "Cannot create"), nil); w.Code != 403 {
		t.Fatal(w.Code)
	}
	responseData(t, apiRequest(a, "PUT", path, admin, humanRolesBody(base, []string{"manual-a"}), nil))
	ordinary, err := s.issueSession(t.Context(), target, false)
	if err != nil {
		t.Fatal(err)
	}
	if w := apiRequest(a, "GET", path, ordinary.Access, nil, nil); w.Code != 403 {
		t.Fatal("ordinary read", w.Code)
	}
	if _, err = s.writer.Exec("INSERT INTO admin_privileges VALUES(?,'high')", target); err != nil {
		t.Fatal(err)
	}
	if w := apiRequest(a, "GET", path, admin, nil, nil); w.Code != 403 {
		t.Fatal("peer read", w.Code)
	}
	if _, err = s.writer.Exec("UPDATE user_accounts SET is_active=0 WHERE uuid=?", target); err != nil {
		t.Fatal(err)
	}
	if w := apiRequest(a, "GET", path, admin, nil, nil); w.Code != 403 {
		t.Fatal("inactive peer", w.Code)
	}
	self := responseData(t, apiRequest(a, "GET", "/api/users/"+actor+"/user-roles", admin, nil, nil))
	if self["availability"] != "protected_self" || self["can_edit"] != false {
		t.Fatal(self)
	}
	service := seedService(t, s, seedServer(t, s))
	if w := apiRequest(a, "GET", "/api/users/"+service+"/user-roles", owner, nil, nil); w.Code != 404 {
		t.Fatal("service", w.Code)
	}
}

func TestHumanUserRolesRejectsStaleIncompleteAndProtectedWrites(t *testing.T) {
	for _, mode := range []string{"owner", "self", "peer", "actor", "target", "catalog", "profile", "role", "unknown-role", "automatic", "duplicate", "null", "missing", "unknown-field", "ack", "noop", "rename", "membership-cycle", "catalog-cycle", "profile-cycle", "pending", "global-review", "session", "grant"} {
		t.Run(mode, func(t *testing.T) {
			a, s, owner, admin, actor, target := humanRolesFixture(t)
			access := owner
			p, _ := s.Authenticate(t.Context(), owner)
			if mode == "owner" {
				target = p.UUID
			}
			if mode == "self" {
				target = actor
				access = admin
			}
			if mode == "peer" || mode == "grant" {
				access = admin
			}
			path := "/api/users/" + target + "/user-roles"
			base := responseData(t, apiRequest(a, "GET", path, access, nil, nil))
			body := humanRolesBody(base, []string{"manual-a"})
			want := 409
			var err error
			switch mode {
			case "owner", "self":
				want = 403
			case "peer":
				_, err = s.writer.Exec("INSERT INTO admin_privileges VALUES(?,'high')", target)
				want = 403
			case "actor":
				body["expected_actor_uuid"] = target
				want = 403
			case "target":
				body["expected_user_uuid"] = p.UUID
			case "catalog":
				body["catalog_revision"] = "0"
			case "profile":
				body["profile_revision"] = "0"
			case "role":
				body["role_revision"] = "0"
			case "unknown-role":
				body["manual_role_ids"] = []string{"missing"}
			case "automatic":
				body["manual_role_ids"] = []string{"automatic"}
				want = 403
			case "duplicate":
				body["manual_role_ids"] = []string{"manual-a", "manual-a"}
				want = 400
			case "null":
				body["manual_role_ids"] = nil
				want = 400
			case "missing":
				delete(body, "manual_role_ids")
				want = 400
			case "unknown-field":
				body["admin_role_ids"] = []string{"high"}
				want = 400
			case "ack":
				body["acknowledge_visual_only"] = false
				want = 400
			case "noop":
				body["manual_role_ids"] = []string{}
			case "rename":
				_, err = s.writer.Exec("UPDATE user_roles SET name='Changed' WHERE id='manual-a'")
			case "membership-cycle":
				_, err = s.writer.Exec("INSERT INTO identity_user_roles VALUES(?,'manual-b')", target)
				if err == nil {
					_, err = s.writer.Exec("DELETE FROM identity_user_roles WHERE user_uuid=? AND role_id='manual-b'", target)
				}
			case "catalog-cycle":
				_, err = s.writer.Exec("UPDATE user_roles SET is_auto_managed=1 WHERE id='manual-a'")
				if err == nil {
					_, err = s.writer.Exec("UPDATE user_roles SET is_auto_managed=0 WHERE id='manual-a'")
				}
			case "profile-cycle":
				_, err = s.writer.Exec("UPDATE user_accounts SET is_active=0 WHERE uuid=?", target)
				if err == nil {
					_, err = s.writer.Exec("UPDATE user_accounts SET is_active=1 WHERE uuid=?", target)
				}
			case "pending":
				_, err = s.writer.Exec(`INSERT INTO provisioning_jobs(id,user_uuid,status,created_at,updated_at) VALUES('roles-job',?,'pending','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')`, target)
			case "global-review":
				_, err = s.writer.Exec(`INSERT INTO provisioning_jobs(id,user_uuid,status,review_token,created_at,updated_at) VALUES('roles-job',?,'failed','unknown','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')`, p.UUID)
			case "session":
				_, err = s.writer.Exec("DELETE FROM app_sessions WHERE user_uuid=?", p.UUID)
				want = 401
			case "grant":
				_, err = s.writer.Exec("DELETE FROM admin_privileges WHERE user_uuid=?", actor)
				want = 403
			}
			if err != nil {
				t.Fatal(err)
			}
			if w := apiRequest(a, "PUT", path, access, body, nil); w.Code != want {
				t.Fatal(mode, w.Code, w.Body.String())
			}
			var n int
			if err = s.reader.QueryRow("SELECT count(*) FROM audit_events WHERE action='account.user_roles.change'").Scan(&n); err != nil || n != 0 {
				t.Fatal("rejected assignment audited as success", err)
			}
		})
	}
}

func TestHumanUserRolesInactiveTargetsAndAuditRollback(t *testing.T) {
	a, s, owner, _, _, target := humanRolesFixture(t)
	path := "/api/users/" + target + "/user-roles"
	if _, err := s.writer.Exec("UPDATE user_accounts SET is_active=0,access_expires_at='2000-01-01T00:00:00Z',password_hash=NULL WHERE uuid=?", target); err != nil {
		t.Fatal(err)
	}
	base := responseData(t, apiRequest(a, "GET", path, owner, nil, nil))
	if base["can_edit"] != true {
		t.Fatal(base)
	}
	if _, err := s.writer.Exec(`CREATE TRIGGER fail_role_audit BEFORE INSERT ON audit_events WHEN NEW.action='account.user_roles.change' BEGIN SELECT RAISE(ABORT,'fixture'); END`); err != nil {
		t.Fatal(err)
	}
	if w := apiRequest(a, "PUT", path, owner, humanRolesBody(base, []string{"manual-a"}), nil); w.Code != 500 {
		t.Fatal(w.Code)
	}
	after := responseData(t, apiRequest(a, "GET", path, owner, nil, nil))
	if after["catalog_revision"] != base["catalog_revision"] || after["profile_revision"] != base["profile_revision"] {
		t.Fatal("audit failure did not roll back", after)
	}
	if _, err := s.writer.Exec("DROP TRIGGER fail_role_audit"); err != nil {
		t.Fatal(err)
	}
	responseData(t, apiRequest(a, "PUT", path, owner, humanRolesBody(base, []string{"manual-a"}), nil))
	var intact bool
	if err := s.reader.QueryRow("SELECT is_active=0 AND access_expires_at='2000-01-01T00:00:00Z' AND password_hash IS NULL FROM user_accounts WHERE uuid=?", target).Scan(&intact); err != nil || !intact {
		t.Fatal("label edit changed sign-in", err)
	}
}

func TestHumanUserRoleCreationGuardsAndRollback(t *testing.T) {
	for _, mode := range []string{"actor", "catalog", "authority", "duplicate", "empty", "whitespace", "control", "metadata", "audit"} {
		t.Run(mode, func(t *testing.T) {
			a, s, owner, _, _, target := humanRolesFixture(t)
			base := responseData(t, apiRequest(a, "GET", "/api/users/"+target+"/user-roles", owner, nil, nil))
			body := userRoleCreateBody(base, "New role")
			want := 409
			switch mode {
			case "actor":
				body["expected_actor_uuid"] = target
				want = 403
			case "catalog":
				body["catalog_revision"] = "0"
			case "authority":
				body["role_revision"] = "0"
			case "duplicate":
				body["name"] = "family"
			case "empty":
				body["name"] = ""
				want = 400
			case "whitespace":
				body["name"] = " spaced "
				want = 400
			case "control":
				body["name"] = "bad\nname"
				want = 400
			case "metadata":
				body["is_auto_managed"] = true
				want = 400
			case "audit":
				if _, err := s.writer.Exec(`CREATE TRIGGER fail_create_audit BEFORE INSERT ON audit_events WHEN NEW.action='user_role.create' BEGIN SELECT RAISE(ABORT,'fixture'); END`); err != nil {
					t.Fatal(err)
				}
				want = 500
			}
			if w := apiRequest(a, "POST", "/api/user-role-catalog", owner, body, nil); w.Code != want {
				t.Fatal(mode, w.Code, w.Body.String())
			}
			var n int
			if err := s.reader.QueryRow("SELECT count(*) FROM user_roles").Scan(&n); err != nil || n != 3 {
				t.Fatal("failed creation changed catalog", n, err)
			}
		})
	}
}

func TestHumanUserRolesConcurrentSaves(t *testing.T) {
	a, _, owner, _, _, target := humanRolesFixture(t)
	path := "/api/users/" + target + "/user-roles"
	base := responseData(t, apiRequest(a, "GET", path, owner, nil, nil))
	codes := make(chan int, 2)
	var wg sync.WaitGroup
	for _, id := range []string{"manual-a", "manual-b"} {
		wg.Go(func() { codes <- apiRequest(a, "PUT", path, owner, humanRolesBody(base, []string{id}), nil).Code })
	}
	wg.Wait()
	close(codes)
	counts := map[int]int{}
	for c := range codes {
		counts[c]++
	}
	if counts[200] != 1 || counts[409] != 1 {
		t.Fatal(counts)
	}
}

func TestHumanUserRolesCatalogBoundAndCreateConcurrency(t *testing.T) {
	a, s, owner, _, _, target := humanRolesFixture(t)
	path := "/api/users/" + target + "/user-roles"
	base := responseData(t, apiRequest(a, "GET", path, owner, nil, nil))
	codes := make(chan int, 2)
	var wg sync.WaitGroup
	for _, name := range []string{"First label", "Second label"} {
		wg.Go(func() {
			codes <- apiRequest(a, "POST", "/api/user-role-catalog", owner, userRoleCreateBody(base, name), nil).Code
		})
	}
	wg.Wait()
	close(codes)
	counts := map[int]int{}
	for c := range codes {
		counts[c]++
	}
	if counts[201] != 1 || counts[409] != 1 {
		t.Fatal(counts)
	}
	if _, err := s.writer.Exec(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<997) INSERT INTO user_roles(id,name) SELECT 'bound-'||x,'Bound label '||x FROM n`); err != nil {
		t.Fatal(err)
	}
	if w := apiRequest(a, "GET", path, owner, nil, nil); w.Code != 409 {
		t.Fatal("oversized catalog accepted as complete", w.Code, w.Body.String())
	}
}

// removeAutomaticRoles drops the Downloads, Home User and Shares Back roles
// migration 068 creates, for tests that need a catalog with only their own
// roles or that exercise creating Downloads on first sync.
func removeAutomaticRoles(t *testing.T, s *Store) {
	t.Helper()
	for _, query := range []string{"DELETE FROM relationship_roles", "DELETE FROM download_role", "DELETE FROM user_roles WHERE is_auto_managed=1 AND name IN ('Downloads','Home User','Shares Back')"} {
		if _, err := s.writer.Exec(query); err != nil {
			t.Fatal(query, err)
		}
	}
}
