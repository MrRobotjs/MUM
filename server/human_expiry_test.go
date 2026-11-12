package main

import (
	"net/http/httptest"
	"sync"
	"testing"

	"github.com/coder/websocket/wsjson"
)

func expiryBody(p map[string]any, expires any) map[string]any {
	return map[string]any{"expected_actor_uuid": p["actor_uuid"], "expected_user_uuid": p["user_uuid"], "expiry_revision": p["expiry_revision"], "profile_revision": p["profile_revision"], "activation_revision": p["activation_revision"], "role_revision": p["role_revision"], "expected_is_active": p["is_active"], "expected_access_expires_at": p["access_expires_at"], "access_expires_at": expires, "acknowledge_revoke_sessions": true, "acknowledge_local_only": true}
}

func TestHumanExpiryRevokesSessionsSocketsAndPreservesLocalAndRemoteState(t *testing.T) {
	for _, admin := range []bool{false, true} {
		t.Run(map[bool]string{false: "ordinary", true: "administrator"}[admin], func(t *testing.T) {
			a, s, ownerAccess, _, target := roleReadFixture(t)
			owner, _ := s.Authenticate(t.Context(), ownerAccess)
			if !admin {
				var err error
				target, err = s.CreateAccount(t.Context(), owner.UUID, "expiry-target", "fixture-hash", false)
				if err != nil {
					t.Fatal(err)
				}
			}
			old, err := s.issueSession(t.Context(), target, false)
			if err != nil {
				t.Fatal(err)
			}
			service := seedService(t, s, seedServer(t, s))
			if err = s.LinkServiceAccounts(t.Context(), owner.UUID, target, []string{service}); err != nil {
				t.Fatal(err)
			}
			if _, err = s.writer.Exec(`INSERT INTO plex_authorizations(id,owner_uuid,browser_hash,status,secret,expires_at,poll_after,created_at,updated_at) VALUES('expiry-proof',?,'fixture','verified',X'0102','2099-01-01T00:00:00Z','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')`, target); err != nil {
				t.Fatal(err)
			}
			server := httptest.NewServer(a)
			defer server.Close()
			conn, ctx := dialClient(t, server.URL, old.Access)
			defer conn.CloseNow()
			path := "/api/users/" + target + "/expiry"
			before := responseData(t, apiRequest(a, "GET", path, ownerAccess, nil, nil))
			if before["access_expires_at"] != nil || before["can_edit"] != true {
				t.Fatal(before)
			}
			w := apiRequest(a, "PUT", path, ownerAccess, expiryBody(before, "2099-01-01T12:30:00Z"), nil)
			after := responseData(t, w)
			if after["expiry_revision"] != "2" || after["profile_revision"] != "2" || after["activation_revision"] != "1" || after["sessions_revoked"] != true || after["is_active"] != true {
				t.Fatal(after)
			}
			if len(w.Result().Cookies()) != 0 {
				t.Fatal("acting session cookie changed")
			}
			if _, err = s.Authenticate(t.Context(), old.Access); err == nil {
				t.Fatal("old access survived")
			}
			if _, _, err = s.refreshSession(t.Context(), old.Refresh); err == nil {
				t.Fatal("old refresh survived")
			}
			var message map[string]any
			if err = wsjson.Read(ctx, conn, &message); err == nil || ctx.Err() != nil {
				t.Fatal("target socket not closed", err)
			}
			profile := responseData(t, apiRequest(a, "GET", "/api/users/"+target, ownerAccess, nil, nil))
			if profile["access_expires_at"] != "2099-01-01T12:30:00Z" {
				t.Fatal(profile)
			}
			fresh, err := s.issueSession(t.Context(), target, false)
			if err != nil {
				t.Fatal(err)
			}
			if _, err = s.writer.Exec("UPDATE user_accounts SET access_expires_at='2000-01-01T00:00:00Z' WHERE uuid=?", target); err != nil {
				t.Fatal(err)
			}
			if _, err = s.Authenticate(t.Context(), fresh.Access); err == nil {
				t.Fatal("elapsed expiry did not gate authentication")
			}
			current := responseData(t, apiRequest(a, "GET", path, ownerAccess, nil, nil))
			cleared := responseData(t, apiRequest(a, "PUT", path, ownerAccess, expiryBody(current, nil), nil))
			if cleared["access_expires_at"] != nil || cleared["expiry_revision"] != "4" || cleared["is_active"] != true {
				t.Fatal(cleared)
			}
			if _, err = s.Authenticate(t.Context(), fresh.Access); err == nil {
				t.Fatal("dormant session revived after clear")
			}
			if _, _, err = s.refreshSession(t.Context(), fresh.Refresh); err == nil {
				t.Fatal("dormant refresh revived after clear")
			}
			if _, err = s.issueSession(t.Context(), target, false); err != nil {
				t.Fatal(err)
			}
			var intact bool
			if err = s.reader.QueryRow(`SELECT a.is_active=1 AND EXISTS(SELECT 1 FROM service_links WHERE service_uuid=a.uuid AND user_uuid=?) FROM service_accounts a WHERE uuid=?`, target, service).Scan(&intact); err != nil || !intact {
				t.Fatal("media state changed", err)
			}
			if err = s.reader.QueryRow("SELECT status='failed' AND secret IS NULL FROM plex_authorizations WHERE id='expiry-proof'").Scan(&intact); err != nil || !intact {
				t.Fatal("Plex proof survived", err)
			}
			if admin {
				var n int
				if err = s.reader.QueryRow("SELECT count(*) FROM admin_privileges WHERE user_uuid=?", target).Scan(&n); err != nil || n != 1 {
					t.Fatal("grants changed", err)
				}
			}
		})
	}
}

func TestHumanExpiryAuthorityStateAndInputGuards(t *testing.T) {
	for _, mode := range []string{"owner", "self", "peer", "actor", "target", "revision", "profile", "role", "activation", "expected", "missing", "number", "array", "offset", "calendar", "past", "noop", "ack", "unknown", "review", "personal", "provisional", "cancelled", "credentials", "ABA", "revoked"} {
		t.Run(mode, func(t *testing.T) {
			a, s, ownerAccess, access, actor := roleReadFixture(t)
			owner, _ := s.Authenticate(t.Context(), ownerAccess)
			target, err := s.CreateAccount(t.Context(), owner.UUID, "expiry-guard", "fixture-hash", false)
			if err != nil {
				t.Fatal(err)
			}
			if mode == "owner" {
				target = owner.UUID
			}
			if mode == "self" {
				target = actor
			}
			if mode == "self" || mode == "peer" {
				ownerAccess = access
			}
			path := "/api/users/" + target + "/expiry"
			before := responseData(t, apiRequest(a, "GET", path, ownerAccess, nil, nil))
			body := expiryBody(before, "2099-01-01T00:00:00Z")
			want := 409
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
				body["expected_user_uuid"] = owner.UUID
			case "revision":
				body["expiry_revision"] = "0"
			case "profile":
				body["profile_revision"] = "0"
			case "role":
				body["role_revision"] = "0"
			case "activation":
				body["activation_revision"] = "0"
			case "expected":
				body["expected_access_expires_at"] = "2098-01-01T00:00:00Z"
			case "missing":
				delete(body, "access_expires_at")
				want = 400
			case "number":
				body["access_expires_at"] = 42
				want = 400
			case "array":
				body["access_expires_at"] = []string{}
				want = 400
			case "offset":
				body["access_expires_at"] = "2099-01-01T01:00:00+01:00"
				want = 400
			case "calendar":
				body["access_expires_at"] = "2099-02-30T00:00:00Z"
				want = 400
			case "past":
				body["access_expires_at"] = "2000-01-01T00:00:00Z"
				want = 400
			case "noop":
				body["access_expires_at"] = nil
			case "ack":
				body["acknowledge_local_only"] = false
				want = 400
			case "unknown":
				body["is_active"] = false
				want = 400
			case "review":
				_, err = s.writer.Exec(`INSERT INTO provisioning_jobs(id,user_uuid,status,review_token,created_at,updated_at) VALUES('expiry-job',?,'failed','unknown-claim','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')`, owner.UUID)
			case "personal":
				_, err = s.writer.Exec(`INSERT INTO plex_authorizations(id,owner_uuid,browser_hash,status,expires_at,poll_after,operation_token,created_at,updated_at) VALUES('expiry-op',?,'fixture','pending','2099-01-01T00:00:00Z','2026-01-01T00:00:00Z','claim','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')`, target)
			case "provisional", "cancelled":
				_, err = s.writer.Exec(`INSERT INTO provisioning_jobs(id,user_uuid,status,resolution,reservation_held,created_at,updated_at) VALUES('expiry-job',?,'failed',?,0,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')`, target, map[string]any{"provisional": nil, "cancelled": "cancelled"}[mode])
			case "credentials":
				_, err = s.writer.Exec("UPDATE user_accounts SET password_hash=NULL WHERE uuid=?", target)
			case "ABA":
				_, err = s.writer.Exec("UPDATE user_accounts SET access_expires_at='2098-01-01T00:00:00Z' WHERE uuid=?", target)
				if err == nil {
					_, err = s.writer.Exec("UPDATE user_accounts SET access_expires_at=NULL WHERE uuid=?", target)
				}
			case "revoked":
				_, err = s.writer.Exec("DELETE FROM app_sessions WHERE user_uuid=?", owner.UUID)
				want = 401
			}
			if err != nil {
				t.Fatal(err)
			}
			if w := apiRequest(a, "PUT", path, ownerAccess, body, nil); w.Code != want {
				t.Fatal(mode, w.Code, w.Body.String())
			}
			var audits int
			if err = s.reader.QueryRow("SELECT count(*) FROM audit_events WHERE action='account.expiry.change'").Scan(&audits); err != nil || audits != 0 {
				t.Fatal("rejected edit audited as success", err)
			}
		})
	}
}

func TestHumanExpiryInactiveAndRollback(t *testing.T) {
	a, s, ownerAccess, _, target := roleReadFixture(t)
	session, err := s.issueSession(t.Context(), target, false)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.writer.Exec("UPDATE user_accounts SET is_active=0,access_expires_at='2000-01-01T00:00:00Z' WHERE uuid=?", target); err != nil {
		t.Fatal(err)
	}
	path := "/api/users/" + target + "/expiry"
	before := responseData(t, apiRequest(a, "GET", path, ownerAccess, nil, nil))
	if before["can_edit"] != true {
		t.Fatal(before)
	}
	if _, err = s.writer.Exec(`CREATE TRIGGER fail_expiry_audit BEFORE INSERT ON audit_events WHEN NEW.action='account.expiry.change' BEGIN SELECT RAISE(ABORT,'fixture'); END`); err != nil {
		t.Fatal(err)
	}
	if w := apiRequest(a, "PUT", path, ownerAccess, expiryBody(before, nil), nil); w.Code != 500 {
		t.Fatal(w.Code, w.Body.String())
	}
	var intact bool
	if err = s.reader.QueryRow("SELECT EXISTS(SELECT 1 FROM session_access_tokens WHERE token_hash=?) AND (SELECT access_expires_at='2000-01-01T00:00:00Z' FROM user_accounts WHERE uuid=?)", tokenHash(session.Access), target).Scan(&intact); err != nil || !intact {
		t.Fatal("failed audit did not roll back", err)
	}
	if _, err = s.writer.Exec("DROP TRIGGER fail_expiry_audit"); err != nil {
		t.Fatal(err)
	}
	after := responseData(t, apiRequest(a, "PUT", path, ownerAccess, expiryBody(before, nil), nil))
	if after["is_active"] != false || after["activation_revision"] != before["activation_revision"] {
		t.Fatal("expiry activated account", after)
	}
	if _, err = s.issueSession(t.Context(), target, false); err == nil {
		t.Fatal("inactive sign-in restored")
	}
	service := seedService(t, s, seedServer(t, s))
	if w := apiRequest(a, "GET", "/api/users/"+service+"/expiry", ownerAccess, nil, nil); w.Code != 404 {
		t.Fatal(w.Code)
	}
}

func TestHumanExpiryConcurrentCompareAndSwap(t *testing.T) {
	a, _, ownerAccess, _, target := roleReadFixture(t)
	path := "/api/users/" + target + "/expiry"
	before := responseData(t, apiRequest(a, "GET", path, ownerAccess, nil, nil))
	codes := make(chan int, 2)
	var wg sync.WaitGroup
	for range 2 {
		wg.Go(func() {
			codes <- apiRequest(a, "PUT", path, ownerAccess, expiryBody(before, "2099-01-01T00:00:00Z"), nil).Code
		})
	}
	wg.Wait()
	close(codes)
	counts := map[int]int{}
	for code := range codes {
		counts[code]++
	}
	if counts[200] != 1 || counts[409] != 1 {
		t.Fatal(counts)
	}
}
