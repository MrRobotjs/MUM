package main

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"testing"
)

func roleMembersFixture(t *testing.T) (*App, *Store, string, string, string, string, string) {
	t.Helper()
	a, s, owner, admin, _, target := humanRolesFixture(t)
	p, _ := s.Authenticate(t.Context(), owner)
	server := seedServer(t, s)
	service := seedService(t, s, server)
	unlinked := seedService(t, s, server)
	if err := s.LinkServiceAccounts(t.Context(), p.UUID, target, []string{service}); err != nil {
		t.Fatal(err)
	}
	return a, s, owner, admin, target, service, unlinked
}
func roleMembersBody(p map[string]any, operation string, ids ...string) map[string]any {
	targets := []map[string]any{}
	for _, id := range ids {
		targets = append(targets, map[string]any{"user_uuid": id, "expected_member": operation == "remove"})
	}
	return map[string]any{"expected_actor_uuid": p["actor_uuid"], "expected_role_id": p["role_id"], "catalog_revision": p["catalog_revision"], "role_revision": p["role_revision"], "link_revision": p["link_revision"], "selector_revision": p["selector_revision"], "operation": operation, "acknowledge_visual_only": true, "targets": targets}
}
func memberIdentity(t *testing.T, p map[string]any, id string) map[string]any {
	t.Helper()
	for _, raw := range p["items"].([]any) {
		item := raw.(map[string]any)
		if item["uuid"] == id {
			return item
		}
	}
	t.Fatal("missing identity", id)
	return nil
}

func TestUserRoleMembersMixedAtomicBatchPreservesOtherLabelsAndMedia(t *testing.T) {
	a, s, owner, _, target, service, _ := roleMembersFixture(t)
	path := "/api/user-role-catalog/manual-a/members"
	if _, err := s.writer.Exec("INSERT INTO identity_user_roles VALUES(?,'manual-b')", service); err != nil {
		t.Fatal(err)
	}
	session, err := s.issueSession(t.Context(), target, false)
	if err != nil {
		t.Fatal(err)
	}
	base := responseData(t, apiRequest(a, "GET", path, owner, nil, nil))
	if base["complete"] != true || len(base["items"].([]any)) != 5 {
		t.Fatal(base)
	}
	row := memberIdentity(t, base, service)
	if row["primary_owner_uuid"] != target || row["can_change"] != true {
		t.Fatal(row)
	}
	after := responseData(t, apiRequest(a, "POST", path, owner, roleMembersBody(base, "add", target, service), nil))
	if memberIdentity(t, after, service)["is_member"] != true || memberIdentity(t, after, target)["is_member"] != true {
		t.Fatal(after)
	}
	if p, err := s.Authenticate(t.Context(), session.Access); err != nil || p.Admin {
		t.Fatal("labels changed session/permission", err)
	}
	if _, _, err = s.refreshSession(t.Context(), session.Refresh); err != nil {
		t.Fatal("refresh revoked", err)
	}
	responseData(t, apiRequest(a, "POST", path, owner, roleMembersBody(after, "remove", target, service), nil))
	var intact bool
	if err = s.reader.QueryRow(`SELECT (SELECT profile_revision=3 AND is_active=1 FROM user_accounts WHERE uuid=?)
 AND EXISTS(SELECT 1 FROM identity_user_roles WHERE user_uuid=? AND role_id='automatic')
 AND EXISTS(SELECT 1 FROM identity_user_roles WHERE user_uuid=? AND role_id='manual-b')
 AND EXISTS(SELECT 1 FROM service_links WHERE user_uuid=? AND service_uuid=? AND link_kind='owner')
 AND (SELECT is_active=1 FROM service_accounts WHERE uuid=?)`, target, target, service, target, service, service).Scan(&intact); err != nil || !intact {
		t.Fatal("unrelated state changed", err)
	}
	rows, err := s.reader.Query("SELECT details FROM audit_events WHERE action='user_role.members.change' ORDER BY id")
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	n := 0
	for rows.Next() {
		var raw string
		if err = rows.Scan(&raw); err != nil {
			t.Fatal(err)
		}
		var audit struct {
			Before []userRoleIdentity `json:"before"`
			Member bool               `json:"after_member"`
		}
		if err = json.Unmarshal([]byte(raw), &audit); err != nil || len(audit.Before) != 2 {
			t.Fatal(raw, err)
		}
		n++
	}
	if err = rows.Err(); err != nil || n != 2 {
		t.Fatal(n, err)
	}
}

func TestUserRoleMembersOwnerOnlyAndProtectedPrimaryOwnership(t *testing.T) {
	a, s, owner, admin, target, service, unlinked := roleMembersFixture(t)
	path := "/api/user-role-catalog/manual-a/members"
	base := responseData(t, apiRequest(a, "GET", path, owner, nil, nil))
	p, _ := s.Authenticate(t.Context(), owner)
	if w := apiRequest(a, "GET", path, admin, nil, nil); w.Code != 403 {
		t.Fatal("delegated member read", w.Code)
	}
	if w := apiRequest(a, "POST", path, admin, roleMembersBody(base, "add", service), nil); w.Code != 403 {
		t.Fatal("delegated member write", w.Code)
	}
	ordinary, err := s.issueSession(t.Context(), target, false)
	if err != nil {
		t.Fatal(err)
	}
	if w := apiRequest(a, "GET", path, ordinary.Access, nil, nil); w.Code != 403 {
		t.Fatal("ordinary read", w.Code)
	}
	if w := apiRequest(a, "POST", path, owner, roleMembersBody(base, "add", p.UUID), nil); w.Code != 403 {
		t.Fatal("owner edited", w.Code)
	}
	if _, err = s.writer.Exec("UPDATE service_links SET user_uuid=? WHERE service_uuid=? AND link_kind='owner'", p.UUID, service); err != nil {
		t.Fatal(err)
	}
	if _, err = s.writer.Exec("INSERT INTO service_links(user_uuid,service_uuid,link_kind,created_at) VALUES(?,?,'delegate','2026-01-01T00:00:00Z')", target, service); err != nil {
		t.Fatal(err)
	}
	base = responseData(t, apiRequest(a, "GET", path, owner, nil, nil))
	if memberIdentity(t, base, service)["can_change"] != false {
		t.Fatal("delegate overrode protected primary owner")
	}
	if w := apiRequest(a, "POST", path, owner, roleMembersBody(base, "add", service), nil); w.Code != 403 {
		t.Fatal(w.Code)
	}
	responseData(t, apiRequest(a, "POST", path, owner, roleMembersBody(base, "add", unlinked), nil))
	auto := responseData(t, apiRequest(a, "GET", "/api/user-role-catalog/automatic/members", owner, nil, nil))
	if auto["mutations_available"] != false {
		t.Fatal(auto)
	}
	if w := apiRequest(a, "POST", "/api/user-role-catalog/automatic/members", owner, roleMembersBody(auto, "add", unlinked), nil); w.Code != 403 {
		t.Fatal("automatic role changed", w.Code)
	}
}

func TestUserRoleMembersRejectsStaleGraphStateAndWholeInvalidBatches(t *testing.T) {
	for _, mode := range []string{"actor", "role-id", "catalog", "authority", "link", "selector", "membership-cycle", "ownership-cycle", "service-cycle", "external-cycle", "new-identity", "human-cycle", "global-review", "pending-owner", "personal-operation", "mixed-protected", "mixed-missing", "expected", "duplicate", "missing-state", "missing-targets", "missing-ack", "unknown-field", "session"} {
		t.Run(mode, func(t *testing.T) {
			a, s, owner, _, target, service, unlinked := roleMembersFixture(t)
			path := "/api/user-role-catalog/manual-a/members"
			base := responseData(t, apiRequest(a, "GET", path, owner, nil, nil))
			body := roleMembersBody(base, "add", service)
			p, _ := s.Authenticate(t.Context(), owner)
			want := 409
			var err error
			switch mode {
			case "actor":
				body["expected_actor_uuid"] = target
				want = 403
			case "role-id":
				body["expected_role_id"] = "manual-b"
			case "catalog":
				body["catalog_revision"] = "0"
			case "authority":
				body["role_revision"] = "0"
			case "link":
				body["link_revision"] = "0"
			case "selector":
				body["selector_revision"] = "0"
			case "membership-cycle":
				_, err = s.writer.Exec("INSERT INTO identity_user_roles VALUES(?,'manual-a')", target)
				if err == nil {
					_, err = s.writer.Exec("DELETE FROM identity_user_roles WHERE user_uuid=? AND role_id='manual-a'", target)
				}
			case "ownership-cycle":
				_, err = s.writer.Exec("DELETE FROM service_links WHERE service_uuid=?", service)
				if err == nil {
					_, err = s.writer.Exec("INSERT INTO service_links(user_uuid,service_uuid,link_kind,created_at) VALUES(?,?,'owner','2026-01-01T00:00:00Z')", target, service)
				}
			case "service-cycle":
				_, err = s.writer.Exec("UPDATE service_accounts SET external_username='Changed' WHERE uuid=?", service)
				if err == nil {
					_, err = s.writer.Exec("UPDATE service_accounts SET external_username=NULL WHERE uuid=?", service)
				}
			case "external-cycle":
				var external sql.NullString
				if err = s.reader.QueryRow("SELECT external_user_id FROM service_accounts WHERE uuid=?", service).Scan(&external); err == nil {
					_, err = s.writer.Exec("UPDATE service_accounts SET external_user_id='Changed' WHERE uuid=?", service)
				}
				if err == nil {
					_, err = s.writer.Exec("UPDATE service_accounts SET external_user_id=? WHERE uuid=?", external, service)
				}
			case "new-identity":
				var server int64
				if err = s.reader.QueryRow("SELECT server_id FROM service_accounts WHERE uuid=?", unlinked).Scan(&server); err != nil {
					t.Fatal(err)
				}
				seedService(t, s, server)
			case "human-cycle":
				_, err = s.writer.Exec("UPDATE user_accounts SET is_active=0 WHERE uuid=?", target)
				if err == nil {
					_, err = s.writer.Exec("UPDATE user_accounts SET is_active=1 WHERE uuid=?", target)
				}
			case "global-review":
				_, err = s.writer.Exec(`INSERT INTO provisioning_jobs(id,user_uuid,status,review_token,created_at,updated_at) VALUES('member-job',?,'failed','claimed','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')`, p.UUID)
				want = 403
			case "pending-owner":
				_, err = s.writer.Exec(`INSERT INTO provisioning_jobs(id,user_uuid,status,created_at,updated_at) VALUES('member-job',?,'failed','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')`, target)
				want = 403
			case "personal-operation":
				_, err = s.writer.Exec(`INSERT INTO plex_authorizations(id,owner_uuid,browser_hash,status,expires_at,poll_after,operation_token,created_at,updated_at) VALUES('member-proof',?,'fixture','pending','2099-01-01T00:00:00Z','2026-01-01T00:00:00Z','claimed','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')`, target)
				want = 403
			case "mixed-protected":
				body = roleMembersBody(base, "add", unlinked, p.UUID)
				want = 403
			case "mixed-missing":
				body = roleMembersBody(base, "add", unlinked, newUUID())
				want = 404
			case "expected":
				body["targets"] = []map[string]any{{"user_uuid": service, "expected_member": true}}
			case "duplicate":
				body = roleMembersBody(base, "add", service, service)
				want = 400
			case "missing-state":
				body["targets"] = []map[string]any{{"user_uuid": service}}
				want = 400
			case "missing-targets":
				delete(body, "targets")
				want = 400
			case "missing-ack":
				delete(body, "acknowledge_visual_only")
				want = 400
			case "unknown-field":
				body["expected_primary_owner_uuid"] = target
				want = 400
			case "session":
				_, err = s.writer.Exec("DELETE FROM app_sessions WHERE user_uuid=?", p.UUID)
				want = 401
			}
			if err != nil {
				t.Fatal(err)
			}
			if w := apiRequest(a, "POST", path, owner, body, nil); w.Code != want {
				t.Fatal(mode, w.Code, w.Body.String())
			}
			var count int
			if err = s.reader.QueryRow("SELECT count(*) FROM identity_user_roles WHERE role_id='manual-a'").Scan(&count); err != nil || count != 0 {
				t.Fatal("partial assignment survived", count, err)
			}
			if err = s.reader.QueryRow("SELECT count(*) FROM audit_events WHERE action='user_role.members.change'").Scan(&count); err != nil || count != 0 {
				t.Fatal("rejected batch audited as success", err)
			}
		})
	}
}

func TestUserRoleMembersAuditRollbackAndConcurrentClaims(t *testing.T) {
	a, s, owner, _, target, service, _ := roleMembersFixture(t)
	path := "/api/user-role-catalog/manual-a/members"
	base := responseData(t, apiRequest(a, "GET", path, owner, nil, nil))
	if _, err := s.writer.Exec(`CREATE TRIGGER fail_member_audit BEFORE INSERT ON audit_events WHEN NEW.action='user_role.members.change' BEGIN SELECT RAISE(ABORT,'fixture'); END`); err != nil {
		t.Fatal(err)
	}
	if w := apiRequest(a, "POST", path, owner, roleMembersBody(base, "add", target, service), nil); w.Code != 500 {
		t.Fatal(w.Code)
	}
	after := responseData(t, apiRequest(a, "GET", path, owner, nil, nil))
	for _, key := range []string{"catalog_revision", "role_revision", "link_revision", "selector_revision"} {
		if after[key] != base[key] {
			t.Fatal("failed audit changed revision", key)
		}
	}
	if _, err := s.writer.Exec("DROP TRIGGER fail_member_audit"); err != nil {
		t.Fatal(err)
	}
	codes := make(chan int, 2)
	var wg sync.WaitGroup
	for range 2 {
		wg.Go(func() {
			codes <- apiRequest(a, "POST", path, owner, roleMembersBody(base, "add", target, service), nil).Code
		})
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

func TestUserRoleMembersCompleteBeyondFirstHundredAndBound(t *testing.T) {
	a, s, owner, _, _, _, unlinked := roleMembersFixture(t)
	var server int64
	if err := s.reader.QueryRow("SELECT server_id FROM service_accounts WHERE uuid=?", unlinked).Scan(&server); err != nil {
		t.Fatal(err)
	}
	path := "/api/user-role-catalog/manual-a/members"
	insert := func(first, last int) {
		t.Helper()
		err := s.write(t.Context(), func(tx *sql.Tx) error {
			for n := first; n <= last; n++ {
				id := fmt.Sprintf("12345678-1234-1234-1234-%012d", n)
				if _, err := tx.Exec("INSERT INTO identities(uuid,kind) VALUES(?,'service')", id); err != nil {
					return err
				}
				if _, err := tx.Exec("INSERT INTO service_accounts(uuid,server_id,external_user_id,external_username,created_at,updated_at) VALUES(?,?,?,?,?,?)", id, server, fmt.Sprint(n), fmt.Sprintf("candidate-%d", n), "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"); err != nil {
					return err
				}
			}
			return nil
		})
		if err != nil {
			t.Fatal(err)
		}
	}
	insert(1, 101)
	base := responseData(t, apiRequest(a, "GET", path, owner, nil, nil))
	if len(base["items"].([]any)) != 106 || base["complete"] != true {
		t.Fatal("selector truncated", base)
	}
	last := "12345678-1234-1234-1234-000000000101"
	responseData(t, apiRequest(a, "POST", path, owner, roleMembersBody(base, "add", last), nil))
	base = responseData(t, apiRequest(a, "GET", path, owner, nil, nil))
	insert(102, 1001)
	if w := apiRequest(a, "GET", path, owner, nil, nil); w.Code != 409 || strings.Contains(w.Body.String(), `"items"`) {
		t.Fatal("oversized selector accepted as complete", w.Code)
	}
	if w := apiRequest(a, "POST", path, owner, roleMembersBody(base, "add", unlinked), nil); w.Code != 409 {
		t.Fatal("oversized selector permitted write", w.Code)
	}
}
