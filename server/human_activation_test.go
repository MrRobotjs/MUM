package main

import (
	"database/sql"
	"errors"
	"net/http/httptest"
	"sync"
	"testing"

	"github.com/coder/websocket/wsjson"
)

func activationBody(p map[string]any, active bool) map[string]any {
	return map[string]any{"expected_actor_uuid": p["actor_uuid"], "expected_user_uuid": p["user_uuid"], "activation_revision": p["activation_revision"], "profile_revision": p["profile_revision"], "role_revision": p["role_revision"], "expected_is_active": p["is_active"], "is_active": active, "acknowledge_revoke_sessions": true, "acknowledge_local_only": true}
}

func TestHumanActivationRevokesSessionsSocketsAndPreservesServices(t *testing.T) {
	a, s := testApp(t)
	token, _ := bootstrapOwner(t, a)
	owner, _ := s.Authenticate(t.Context(), token)
	target, err := s.CreateAccount(t.Context(), owner.UUID, "activation-target", "fixture-hash", false)
	if err != nil {
		t.Fatal(err)
	}
	first, err := s.issueSession(t.Context(), target, false)
	if err != nil {
		t.Fatal(err)
	}
	second, err := s.issueSession(t.Context(), target, false)
	if err != nil {
		t.Fatal(err)
	}
	service := seedService(t, s, seedServer(t, s))
	if err = s.LinkServiceAccounts(t.Context(), owner.UUID, target, []string{service}); err != nil {
		t.Fatal(err)
	}
	// Unconsumed personal proofs are invalidated, while existing media links stay.
	if _, err = s.writer.Exec(`INSERT INTO plex_authorizations(id,owner_uuid,browser_hash,status,secret,expires_at,poll_after,created_at,updated_at) VALUES('activation-proof',?,'fixture','verified',X'0102','2099-01-01T00:00:00Z','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')`, target); err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(a)
	defer server.Close()
	conn, ctx := dialClient(t, server.URL, second.Access)
	defer conn.CloseNow()
	path := "/api/users/" + target + "/activation"
	before := responseData(t, apiRequest(a, "GET", path, token, nil, nil))
	if before["can_deactivate"] != true || before["can_activate"] != false {
		t.Fatal(before)
	}
	w := apiRequest(a, "PUT", path, token, activationBody(before, false), nil)
	after := responseData(t, w)
	if after["is_active"] != false || after["sessions_revoked"] != true || after["activation_revision"] != "2" || after["profile_revision"] != "2" {
		t.Fatal(after)
	}
	if len(w.Result().Cookies()) != 0 {
		t.Fatal("acting administrator cookie changed")
	}
	for _, session := range []sessionTokens{first, second} {
		if _, err := s.Authenticate(t.Context(), session.Access); err == nil {
			t.Fatal("old access survived")
		}
		if _, _, err := s.refreshSession(t.Context(), session.Refresh); err == nil {
			t.Fatal("old refresh survived")
		}
	}
	var reply map[string]any
	if err := wsjson.Read(ctx, conn, &reply); err == nil || ctx.Err() != nil {
		t.Fatal("socket not closed before deadline", err)
	}
	current := responseData(t, apiRequest(a, "GET", path, token, nil, nil))
	enabled := responseData(t, apiRequest(a, "PUT", path, token, activationBody(current, true), nil))
	if enabled["is_active"] != true || enabled["activation_revision"] != "3" || enabled["profile_revision"] != "3" {
		t.Fatal(enabled)
	}
	if _, err = s.Authenticate(t.Context(), first.Access); err == nil {
		t.Fatal("old access revived")
	}
	if _, _, err = s.refreshSession(t.Context(), first.Refresh); err == nil {
		t.Fatal("old refresh revived")
	}
	if _, err = s.issueSession(t.Context(), target, false); err != nil {
		t.Fatal("fresh login unavailable", err)
	}
	var intact bool
	if err = s.reader.QueryRow(`SELECT a.is_active=1 AND EXISTS(SELECT 1 FROM service_links WHERE service_uuid=a.uuid AND user_uuid=?) FROM service_accounts a WHERE uuid=?`, target, service).Scan(&intact); err != nil || !intact {
		t.Fatal("service identity/link changed", err)
	}
	if err = s.reader.QueryRow("SELECT status='failed' AND secret IS NULL FROM plex_authorizations WHERE id='activation-proof'").Scan(&intact); err != nil || !intact {
		t.Fatal("proof retained", err)
	}
	if _, err = s.Authenticate(t.Context(), token); err != nil {
		t.Fatal("acting admin revoked", err)
	}
}

func TestHumanActivationDelegatedScopeAndServiceExclusion(t *testing.T) {
	a, s, ownerToken, token, _ := roleReadFixture(t)
	owner, _ := s.Authenticate(t.Context(), ownerToken)
	target, err := s.CreateAccount(t.Context(), owner.UUID, "activation-lower", "fixture-hash", false)
	if err != nil {
		t.Fatal(err)
	}
	session, err := s.issueSession(t.Context(), target, false)
	if err != nil {
		t.Fatal(err)
	}
	path := "/api/users/" + target + "/activation"
	if w := apiRequest(a, "GET", path, session.Access, nil, nil); w.Code != 403 {
		t.Fatal("ordinary read", w.Code)
	}
	before := responseData(t, apiRequest(a, "GET", path, token, nil, nil))
	responseData(t, apiRequest(a, "PUT", path, token, activationBody(before, false), nil))
	// An inactive account's new higher role still protects it.
	if _, err = s.writer.Exec("INSERT INTO admin_privileges VALUES(?,'high')", target); err != nil {
		t.Fatal(err)
	}
	if w := apiRequest(a, "GET", path, token, nil, nil); w.Code != 403 {
		t.Fatal("inactive hierarchy", w.Code)
	}
	service := seedService(t, s, seedServer(t, s))
	if w := apiRequest(a, "GET", "/api/users/"+service+"/activation", ownerToken, nil, nil); w.Code != 404 {
		t.Fatal("service activation exposed", w.Code)
	}
}

func TestHumanActivationProtectedTargetsAndPendingWork(t *testing.T) {
	for _, mode := range []string{"owner", "self", "peer", "pending-job", "unresolved-failure", "cancelled-job", "global-review", "personal-operation", "credentials", "expired", "ABA", "profile", "role", "actor", "target", "ack", "unknown"} {
		t.Run(mode, func(t *testing.T) {
			a, s, ownerToken, token, actor := roleReadFixture(t)
			owner, _ := s.Authenticate(t.Context(), ownerToken)
			target, err := s.CreateAccount(t.Context(), owner.UUID, "activation-guard", "fixture-hash", false)
			if err != nil {
				t.Fatal(err)
			}
			access := ownerToken
			if mode == "self" || mode == "peer" {
				access = token
			}
			if mode == "owner" {
				target = owner.UUID
			}
			if mode == "self" {
				target = actor
			}
			path := "/api/users/" + target + "/activation"
			before := responseData(t, apiRequest(a, "GET", path, access, nil, nil))
			body := activationBody(before, false)
			want := 409
			switch mode {
			case "owner", "self":
				want = 403
			case "peer":
				_, err = s.writer.Exec("INSERT INTO admin_privileges VALUES(?,'high')", target)
				want = 403
			case "pending-job":
				_, err = s.writer.Exec(`INSERT INTO provisioning_jobs(id,user_uuid,status,created_at,updated_at) VALUES('activation-job',?,'pending','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')`, target)
			case "unresolved-failure":
				_, err = s.writer.Exec(`INSERT INTO provisioning_jobs(id,user_uuid,status,created_at,updated_at) VALUES('activation-job',?,'failed','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')`, target)
			case "cancelled-job":
				_, err = s.writer.Exec(`INSERT INTO provisioning_jobs(id,user_uuid,status,resolution,reservation_held,created_at,updated_at) VALUES('activation-job',?,'failed','cancelled',0,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')`, target)
			case "global-review":
				_, err = s.writer.Exec(`INSERT INTO provisioning_jobs(id,user_uuid,status,review_token,created_at,updated_at) VALUES('activation-job',?,'failed','claimed','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')`, owner.UUID)
			case "personal-operation":
				_, err = s.writer.Exec(`INSERT INTO plex_authorizations(id,owner_uuid,browser_hash,status,expires_at,poll_after,operation_token,created_at,updated_at) VALUES('activation-op',?,'fixture','pending','2099-01-01T00:00:00Z','2026-01-01T00:00:00Z','claimed','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')`, target)
			case "credentials":
				_, err = s.writer.Exec("UPDATE user_accounts SET password_hash=NULL WHERE uuid=?", target)
			case "expired":
				_, err = s.writer.Exec("UPDATE user_accounts SET is_active=0,access_expires_at='2000-01-01T00:00:00Z' WHERE uuid=?", target)
				before = responseData(t, apiRequest(a, "GET", path, access, nil, nil))
				body = activationBody(before, true)
			case "ABA":
				_, err = s.writer.Exec("UPDATE user_accounts SET is_active=0 WHERE uuid=?", target)
				if err == nil {
					_, err = s.writer.Exec("UPDATE user_accounts SET is_active=1 WHERE uuid=?", target)
				}
			case "profile":
				body["profile_revision"] = "0"
			case "role":
				body["role_revision"] = "0"
			case "actor":
				body["expected_actor_uuid"] = target
				want = 403
			case "target":
				body["expected_user_uuid"] = owner.UUID
			case "ack":
				body["acknowledge_local_only"] = false
				want = 400
			case "unknown":
				body["allow_downloads"] = true
				want = 400
			}
			if err != nil {
				t.Fatal(err)
			}
			w := apiRequest(a, "PUT", path, access, body, nil)
			if w.Code != want {
				t.Fatal(w.Code, w.Body.String())
			}
			var audits int
			s.reader.QueryRow("SELECT count(*) FROM audit_events WHERE action='account.activation.change'").Scan(&audits)
			if audits != 0 {
				t.Fatal("denied change committed")
			}
		})
	}
}

func TestHumanActivationLiveSessionAndAtomicFailures(t *testing.T) {
	for _, mode := range []string{"revoked-actor", "audit", "overflow"} {
		t.Run(mode, func(t *testing.T) {
			a, s := testApp(t)
			token, _ := bootstrapOwner(t, a)
			owner, _ := s.Authenticate(t.Context(), token)
			target, err := s.CreateAccount(t.Context(), owner.UUID, "activation-rollback", "fixture-hash", false)
			if err != nil {
				t.Fatal(err)
			}
			session, err := s.issueSession(t.Context(), target, false)
			if err != nil {
				t.Fatal(err)
			}
			path := "/api/users/" + target + "/activation"
			if mode == "overflow" {
				if _, err = s.writer.Exec("UPDATE human_activation_state SET revision=9223372036854775807 WHERE uuid=?", target); err != nil {
					t.Fatal(err)
				}
			}
			before := responseData(t, apiRequest(a, "GET", path, token, nil, nil))
			if mode == "revoked-actor" {
				err = s.write(t.Context(), func(tx *sql.Tx) error {
					if _, err := tx.Exec("DELETE FROM session_access_tokens WHERE token_hash=?", tokenHash(token)); err != nil {
						return err
					}
					_, err := readHumanActivation(t.Context(), tx, owner.UUID, token, target)
					if !errors.Is(err, ErrForbidden) {
						t.Fatalf("live session not checked: %v", err)
					}
					return nil
				})
				if err != nil {
					t.Fatal(err)
				}
				return
			}
			if mode == "audit" {
				if _, err = s.writer.Exec(`CREATE TRIGGER activation_audit_failure BEFORE INSERT ON audit_events WHEN NEW.action='account.activation.change' BEGIN SELECT RAISE(ABORT,'fixture failure'); END`); err != nil {
					t.Fatal(err)
				}
			}
			if w := apiRequest(a, "PUT", path, token, activationBody(before, false), nil); w.Code < 400 {
				t.Fatal("failed transaction committed")
			}
			after := responseData(t, apiRequest(a, "GET", path, token, nil, nil))
			if after["is_active"] != true || after["activation_revision"] != before["activation_revision"] || after["profile_revision"] != before["profile_revision"] {
				t.Fatal(after)
			}
			if _, err = s.Authenticate(t.Context(), session.Access); err != nil {
				t.Fatal("rolled-back revocation", err)
			}
		})
	}
}

func TestHumanActivationConcurrentChangesCommitOnce(t *testing.T) {
	a, s := testApp(t)
	token, _ := bootstrapOwner(t, a)
	owner, _ := s.Authenticate(t.Context(), token)
	target, err := s.CreateAccount(t.Context(), owner.UUID, "activation-concurrent", "fixture-hash", false)
	if err != nil {
		t.Fatal(err)
	}
	path := "/api/users/" + target + "/activation"
	before := responseData(t, apiRequest(a, "GET", path, token, nil, nil))
	codes := make(chan int, 2)
	var workers sync.WaitGroup
	for range 2 {
		workers.Go(func() { codes <- apiRequest(a, "PUT", path, token, activationBody(before, false), nil).Code })
	}
	workers.Wait()
	close(codes)
	counts := map[int]int{}
	for code := range codes {
		counts[code]++
	}
	if counts[200] != 1 || counts[409] != 1 {
		t.Fatal(counts)
	}
}

func TestHumanActivationReactivationCannotReviveDormantTokens(t *testing.T) {
	a, s := testApp(t)
	token, _ := bootstrapOwner(t, a)
	owner, _ := s.Authenticate(t.Context(), token)
	target, err := s.CreateAccount(t.Context(), owner.UUID, "activation-dormant", "fixture-hash", false)
	if err != nil {
		t.Fatal(err)
	}
	old, err := s.issueSession(t.Context(), target, false)
	if err != nil {
		t.Fatal(err)
	}
	// Existing internal workflows can leave stored sessions while inactive.
	// Reactivation must delete those tokens, not simply flip the flag.
	if _, err = s.writer.Exec("UPDATE user_accounts SET is_active=0 WHERE uuid=?", target); err != nil {
		t.Fatal(err)
	}
	path := "/api/users/" + target + "/activation"
	before := responseData(t, apiRequest(a, "GET", path, token, nil, nil))
	responseData(t, apiRequest(a, "PUT", path, token, activationBody(before, true), nil))
	if _, err = s.Authenticate(t.Context(), old.Access); err == nil {
		t.Fatal("dormant access revived")
	}
	if _, _, err = s.refreshSession(t.Context(), old.Refresh); err == nil {
		t.Fatal("dormant refresh revived")
	}
}

func TestHumanActivationCompletedProvisioningKeepsItsOutcome(t *testing.T) {
	a, s := testApp(t)
	token, _ := bootstrapOwner(t, a)
	owner, _ := s.Authenticate(t.Context(), token)
	target, err := s.CreateAccount(t.Context(), owner.UUID, "activation-completed", "fixture-hash", false)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.writer.Exec(`INSERT INTO provisioning_jobs(id,user_uuid,status,created_at,updated_at) VALUES('activation-completed',?,'completed','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')`, target); err != nil {
		t.Fatal(err)
	}
	path := "/api/users/" + target + "/activation"
	before := responseData(t, apiRequest(a, "GET", path, token, nil, nil))
	responseData(t, apiRequest(a, "PUT", path, token, activationBody(before, false), nil))
	var retained bool
	if err = s.reader.QueryRow("SELECT status='completed' AND reservation_held=0 AND resolution IS NULL FROM provisioning_jobs WHERE id='activation-completed'").Scan(&retained); err != nil || !retained {
		t.Fatal("job outcome changed", err)
	}
}
