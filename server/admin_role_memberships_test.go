package main

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/coder/websocket/wsjson"
)

func membershipBody(actor string, revision int64, operation string, targets ...adminRoleTarget) map[string]any {
	return map[string]any{"expected_actor_uuid": actor, "snapshot_revision": revision, "operation": operation, "targets": targets, "acknowledge_permission_change": true}
}

func TestAdminRoleMembershipAssignRemovePreservesOtherRolesAndSessions(t *testing.T) {
	a, s, token, admin, user := roleReadFixture(t)
	owner, _ := s.Authenticate(t.Context(), token)
	server := httptest.NewServer(a)
	defer server.Close()
	conn, ctx := dialClient(t, server.URL, admin)
	defer conn.CloseNow()
	w := apiRequest(a, "POST", "/api/admin-roles/low/memberships", token, membershipBody(owner.UUID, roleRevision(t, s), "assign", adminRoleTarget{user, 1}), nil)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	var reply map[string]any
	if err := wsjson.Read(ctx, conn, &reply); err == nil || ctx.Err() != nil {
		t.Fatal("old socket not closed before deadline", err)
	}
	if _, err := s.Authenticate(t.Context(), admin); err != nil {
		t.Fatal("membership change deleted login session")
	}
	var count int
	s.reader.QueryRow("SELECT count(*) FROM admin_privileges WHERE user_uuid=?", user).Scan(&count)
	if count != 2 {
		t.Fatal("other role lost", count)
	}
	w = apiRequest(a, "POST", "/api/admin-roles/high/memberships", token, membershipBody(owner.UUID, roleRevision(t, s), "remove", adminRoleTarget{user, 1}), nil)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	if w := apiRequest(a, "GET", "/api/admin-roles", admin, nil, nil); w.Code != 403 {
		t.Fatal("role name granted access after permission removed", w.Code)
	}
	s.reader.QueryRow("SELECT count(*) FROM admin_privileges WHERE user_uuid=? AND role_id='low'", user).Scan(&count)
	if count != 1 {
		t.Fatal("unselected role removed")
	}
	var details string
	if err := s.reader.QueryRow("SELECT details FROM audit_events WHERE action='admin.role.members.remove'").Scan(&details); err != nil {
		t.Fatal(err)
	}
	var audit adminRoleMembershipAudit
	if err := json.Unmarshal([]byte(details), &audit); err != nil || audit.Role != "high" || len(audit.Targets) != 1 || audit.Targets[0].User != user || audit.After <= audit.Before || len(audit.Permissions) != 1 || audit.Permissions[0] != "admin" {
		t.Fatal("incomplete exact membership audit", err, details)
	}
}

func TestAdminRoleMembershipOwnerTargetAndBodyGuards(t *testing.T) {
	a, s, token, admin, user := roleReadFixture(t)
	owner, _ := s.Authenticate(t.Context(), token)
	delegate, _ := s.Authenticate(t.Context(), admin)
	for _, mode := range []string{"delegated", "actor", "owner", "service", "revision", "target-revision", "duplicate", "missing", "ack", "operation", "unknown", "already-member"} {
		t.Run(mode, func(t *testing.T) {
			body := membershipBody(owner.UUID, roleRevision(t, s), "assign", adminRoleTarget{user, 1})
			access := token
			path := "/api/admin-roles/low/memberships"
			want := 400
			switch mode {
			case "delegated":
				access = admin
				body["expected_actor_uuid"] = delegate.UUID
				want = 403
			case "actor":
				body["expected_actor_uuid"] = delegate.UUID
				want = 403
			case "owner":
				body["targets"] = []adminRoleTarget{{owner.UUID, 1}}
				want = 403
			case "service":
				service := seedService(t, s, seedServer(t, s))
				body["targets"] = []adminRoleTarget{{service, 1}}
				want = 404
			case "revision":
				body["snapshot_revision"] = 999
				want = 409
			case "target-revision":
				body["targets"] = []adminRoleTarget{{user, 999}}
				want = 409
			case "duplicate":
				body["targets"] = []adminRoleTarget{{user, 1}, {user, 1}}
			case "missing":
				body["targets"] = []map[string]any{{"user_uuid": user}}
			case "ack":
				body["acknowledge_permission_change"] = false
			case "operation":
				body["operation"] = "replace-all"
			case "unknown":
				body["role_ids"] = []string{"low", "high"}
			case "already-member":
				path = "/api/admin-roles/high/memberships"
				want = 409
			}
			if w := apiRequest(a, "POST", path, access, body, nil); w.Code != want {
				t.Fatal(mode, w.Code, w.Body.String())
			}
		})
	}
	r := httptest.NewRequest("POST", "/api/admin-roles/low/memberships", strings.NewReader("{}"))
	r.Header.Set("Origin", "https://foreign.invalid")
	r.Header.Set("Authorization", "Bearer "+token)
	w := httptest.NewRecorder()
	a.ServeHTTP(w, r)
	if w.Code != 403 {
		t.Fatal("foreign origin admitted")
	}
	var count int
	s.reader.QueryRow("SELECT count(*) FROM audit_events WHERE action LIKE 'admin.role.members.%'").Scan(&count)
	if count != 0 {
		t.Fatal("rejected grants audited as success")
	}
}

func TestAdminRoleMembershipBatchAtomicRollbackAndStaleAuthority(t *testing.T) {
	for _, mode := range []string{"ineligible", "stale-target", "session", "revision", "rollback"} {
		t.Run(mode, func(t *testing.T) {
			_, s, token, _, user := roleReadFixture(t)
			owner, _ := s.Authenticate(t.Context(), token)
			other, err := s.CreateAccount(t.Context(), owner.UUID, "batch-other", "fixture-hash", false)
			if err != nil {
				t.Fatal(err)
			}
			if mode == "ineligible" {
				s.writer.Exec("UPDATE user_accounts SET is_active=0 WHERE uuid=?", other)
			}
			p := adminRoleMembershipChange{Actor: owner.UUID, Access: token, Role: "low", Operation: "assign", Revision: roleRevision(t, s), Targets: []adminRoleTarget{{user, 1}, {other, 1}}}
			if mode == "stale-target" {
				p.Targets[1].Revision = 99
			}
			if mode == "session" {
				s.writer.Exec("DELETE FROM app_sessions WHERE user_uuid=?", owner.UUID)
			}
			if mode == "revision" {
				s.writer.Exec("UPDATE user_accounts SET profile_revision=profile_revision+1 WHERE uuid=?", other)
			}
			before := roleRevision(t, s)
			rollback := errors.New("fixture rollback after full membership and audit")
			err = s.write(t.Context(), func(tx *sql.Tx) error {
				if _, err := commitAdminRoleMembership(t.Context(), tx, p); err != nil {
					return err
				}
				return rollback
			})
			if err == nil || mode == "rollback" && !errors.Is(err, rollback) {
				t.Fatal(err)
			}
			var count int
			s.reader.QueryRow("SELECT count(*) FROM admin_privileges WHERE role_id='low'").Scan(&count)
			if count != 0 || roleRevision(t, s) != before {
				t.Fatal("partial membership/revision committed", count)
			}
			if mode == "rollback" {
				if err := s.write(t.Context(), func(tx *sql.Tx) error { _, err := commitAdminRoleMembership(t.Context(), tx, p); return err }); err != nil {
					t.Fatal(err)
				}
				if err := s.write(t.Context(), func(tx *sql.Tx) error { _, err := commitAdminRoleMembership(t.Context(), tx, p); return err }); err == nil {
					t.Fatal("stale duplicate batch replayed")
				}
			}
		})
	}
}

func TestAdminRoleMembershipIneligibleAndProtectedCleanup(t *testing.T) {
	for _, mode := range []string{"inactive", "expired", "malformed-expiry", "passwordless", "nameless"} {
		t.Run(mode, func(t *testing.T) {
			a, s, token, _, user := roleReadFixture(t)
			owner, _ := s.Authenticate(t.Context(), token)
			switch mode {
			case "inactive":
				s.writer.Exec("UPDATE user_accounts SET is_active=0 WHERE uuid=?", user)
			case "expired":
				s.writer.Exec("UPDATE user_accounts SET access_expires_at='2000-01-01T00:00:00Z' WHERE uuid=?", user)
			case "malformed-expiry":
				s.writer.Exec("UPDATE user_accounts SET access_expires_at='not-a-date' WHERE uuid=?", user)
			case "passwordless":
				s.writer.Exec("UPDATE user_accounts SET password_hash=NULL WHERE uuid=?", user)
			case "nameless":
				s.writer.Exec("UPDATE user_accounts SET local_username=NULL WHERE uuid=?", user)
			}
			if w := apiRequest(a, "POST", "/api/admin-roles/low/memberships", token, membershipBody(owner.UUID, roleRevision(t, s), "assign", adminRoleTarget{user, 1}), nil); w.Code != 403 {
				t.Fatal(mode, w.Code, w.Body.String())
			}
			if w := apiRequest(a, "POST", "/api/admin-roles/high/memberships", token, membershipBody(owner.UUID, roleRevision(t, s), "remove", adminRoleTarget{user, 1}), nil); w.Code != 200 {
				t.Fatal("cleanup refused", mode, w.Code, w.Body.String())
			}
		})
	}
	a, s, token, _, user := roleReadFixture(t)
	owner, _ := s.Authenticate(t.Context(), token)
	if _, err := s.writer.Exec("UPDATE admin_roles SET is_auto_managed=1 WHERE id='low'"); err != nil {
		t.Fatal(err)
	}
	if w := apiRequest(a, "POST", "/api/admin-roles/low/memberships", token, membershipBody(owner.UUID, roleRevision(t, s), "assign", adminRoleTarget{user, 1}), nil); w.Code != 403 {
		t.Fatal("system role grant admitted")
	}
	if _, err := s.writer.Exec("INSERT INTO admin_privileges VALUES(?,'high')", owner.UUID); err != nil {
		t.Fatal(err)
	}
	if w := apiRequest(a, "POST", "/api/admin-roles/high/memberships", token, membershipBody(owner.UUID, roleRevision(t, s), "remove", adminRoleTarget{user, 1}), nil); w.Code != 403 {
		t.Fatal("owner-protected role changed")
	}
}

func TestAdminRoleCandidatePagesEligibilityAndRevision(t *testing.T) {
	a, s, token, admin, _ := roleReadFixture(t)
	owner, _ := s.Authenticate(t.Context(), token)
	initial := roleRevision(t, s)
	err := s.write(t.Context(), func(tx *sql.Tx) error {
		for i := 0; i < 101; i++ {
			id := fmt.Sprintf("00000000-0000-4000-8000-%012d", i)
			if _, err := tx.Exec("INSERT INTO identities(uuid,kind) VALUES(?,'local')", id); err != nil {
				return err
			}
			if _, err := tx.Exec("INSERT INTO user_accounts(uuid,kind,local_username,password_hash,created_at,updated_at) VALUES(?,'local',?,'fixture-hash','fixture','fixture')", id, fmt.Sprintf("candidate-%d", i)); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if roleRevision(t, s) <= initial {
		t.Fatal("unassigned candidate inserts did not invalidate catalog")
	}
	first := responseData(t, apiRequest(a, "GET", "/api/admin-roles/high/candidates", token, nil, nil))
	if len(first["candidates"].([]any)) != 100 || first["total"] != float64(101) {
		t.Fatal(first)
	}
	cursor := first["next_after"].(string)
	second := responseData(t, apiRequest(a, "GET", "/api/admin-roles/high/candidates?after="+cursor, token, nil, nil))
	if len(second["candidates"].([]any)) != 1 || second["next_after"] != nil || second["snapshot_revision"] != first["snapshot_revision"] {
		t.Fatal(second)
	}
	if w := apiRequest(a, "GET", "/api/admin-roles/high/candidates", admin, nil, nil); w.Code != 403 {
		t.Fatal("delegated candidate read admitted")
	}
	before := roleRevision(t, s)
	if _, err := s.writer.Exec("UPDATE user_accounts SET profile_revision=profile_revision+1 WHERE uuid='00000000-0000-4000-8000-000000000000'"); err != nil {
		t.Fatal(err)
	}
	if roleRevision(t, s) <= before {
		t.Fatal("unassigned profile change did not invalidate candidates")
	}
	if w := apiRequest(a, "GET", "/api/admin-roles/high/candidates?limit=5", token, nil, nil); w.Code != 400 {
		t.Fatal("unknown query accepted")
	}
	if w := apiRequest(a, "POST", "/api/admin-roles/low/memberships", token, membershipBody(owner.UUID, before, "assign", adminRoleTarget{"00000000-0000-4000-8000-000000000000", 1}), nil); w.Code != 409 {
		t.Fatal("stale candidate snapshot admitted")
	}
}
