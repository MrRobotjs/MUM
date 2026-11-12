package main

import (
	"database/sql"
	"errors"
	"sync"
	"testing"
)

func TestAccountLinkConcurrentPreparedWritesCommitOnce(t *testing.T) {
	a, s := testApp(t)
	token, _ := bootstrapOwner(t, a)
	owner, _ := s.Authenticate(t.Context(), token)
	service := seedService(t, s, seedServer(t, s))
	path := "/api/account-links/" + owner.UUID + "/" + service
	record := responseData(t, apiRequest(a, "GET", path, token, nil, nil))
	results := make(chan int, 2)
	var workers sync.WaitGroup
	for range 2 {
		workers.Go(func() {
			results <- apiRequest(a, "PUT", path, token, accountLinkBody(record), nil).Code
		})
	}
	workers.Wait()
	close(results)
	counts := map[int]int{}
	for code := range results {
		counts[code]++
	}
	if counts[200] != 1 || counts[409] != 1 {
		t.Fatal(counts)
	}
	var links, audits int
	if err := s.reader.QueryRow("SELECT count(*) FROM service_links").Scan(&links); err != nil {
		t.Fatal(err)
	}
	if err := s.reader.QueryRow("SELECT count(*) FROM audit_events WHERE action='service.link'").Scan(&audits); err != nil {
		t.Fatal(err)
	}
	if links != 1 || audits != 1 {
		t.Fatal(links, audits)
	}
}

func accountLinkBody(record map[string]any) map[string]any {
	return map[string]any{"expected_actor_uuid": record["actor_uuid"], "expected_user_uuid": record["user_uuid"], "expected_service_uuid": record["service_uuid"], "role_revision": record["role_revision"], "link_revision": record["link_revision"], "profile_revision": record["profile_revision"]}
}

func TestAccountLinkCurrentContractLifecycleAndABA(t *testing.T) {
	a, s := testApp(t)
	token, _ := bootstrapOwner(t, a)
	owner, _ := s.Authenticate(t.Context(), token)
	target, err := s.CreateAccount(t.Context(), owner.UUID, "link-target", "fixture-hash", false)
	if err != nil {
		t.Fatal(err)
	}
	service := seedService(t, s, seedServer(t, s))
	path := "/api/account-links/" + target + "/" + service
	read := func() map[string]any { return responseData(t, apiRequest(a, "GET", path, token, nil, nil)) }
	before := read()
	if before["actor_uuid"] != owner.UUID || before["can_link"] != true || before["can_unlink"] != false {
		t.Fatal(before)
	}
	linked := responseData(t, apiRequest(a, "PUT", path, token, accountLinkBody(before), nil))
	if linked["can_link"] != false || linked["can_unlink"] != true || linked["link_revision"] == before["link_revision"] {
		t.Fatal(linked)
	}
	for _, method := range []string{"PUT", "DELETE"} {
		if w := apiRequest(a, method, path, token, accountLinkBody(before), nil); w.Code != 409 {
			t.Fatal(method, w.Code, w.Body.String())
		}
	}
	unlinked := responseData(t, apiRequest(a, "DELETE", path, token, accountLinkBody(linked), nil))
	if unlinked["can_link"] != true || unlinked["can_unlink"] != false {
		t.Fatal(unlinked)
	}
	// Link -> unlink restores the same visible association but never its revision.
	if w := apiRequest(a, "PUT", path, token, accountLinkBody(before), nil); w.Code != 409 {
		t.Fatal("ABA admitted", w.Code)
	}
	if w := apiRequest(a, "POST", "/api/account-links", token, map[string]any{"user_uuid": target, "service_uuids": []string{service}}, nil); w.Code < 400 {
		t.Fatal("old unguarded batch route survived")
	}
	for _, key := range []string{"password_hash", "external_user_id", "owner_uuid", "token"} {
		if _, ok := read()[key]; ok {
			t.Fatal("private field", key)
		}
	}
	var audits int
	if err := s.reader.QueryRow("SELECT count(*) FROM audit_events WHERE action IN ('service.link','service.unlink')").Scan(&audits); err != nil || audits != 2 {
		t.Fatal(audits, err)
	}
}

func TestAccountLinkStrictBodiesAndLiveState(t *testing.T) {
	for _, mode := range []string{"missing", "unknown", "numeric-revision", "wrong-actor", "wrong-user", "wrong-service", "profile-change", "role-change", "other-owner", "inactive-service", "inactive-target", "expired-target", "delegate-association", "logout"} {
		t.Run(mode, func(t *testing.T) {
			a, s := testApp(t)
			token, _ := bootstrapOwner(t, a)
			owner, _ := s.Authenticate(t.Context(), token)
			target, err := s.CreateAccount(t.Context(), owner.UUID, "guard-target", "fixture-hash", false)
			if err != nil {
				t.Fatal(err)
			}
			service := seedService(t, s, seedServer(t, s))
			path := "/api/account-links/" + target + "/" + service
			snapshot := responseData(t, apiRequest(a, "GET", path, token, nil, nil))
			body := accountLinkBody(snapshot)
			want := 409
			switch mode {
			case "missing":
				delete(body, "link_revision")
			case "unknown":
				body["unsafe"] = true
				want = 400
			case "numeric-revision":
				body["link_revision"] = 1
				want = 400
			case "wrong-actor":
				body["expected_actor_uuid"] = target
				want = 403
			case "wrong-user":
				body["expected_user_uuid"] = owner.UUID
			case "wrong-service":
				body["expected_service_uuid"] = target
			case "profile-change":
				_, err = s.writer.Exec("UPDATE user_accounts SET profile_revision=profile_revision+1 WHERE uuid=?", target)
			case "role-change":
				_, err = s.writer.Exec("UPDATE admin_role_state SET revision=revision+1 WHERE singleton=1")
			case "other-owner":
				err = s.LinkServiceAccounts(t.Context(), owner.UUID, owner.UUID, []string{service})
			case "inactive-service":
				_, err = s.writer.Exec("UPDATE service_accounts SET is_active=0 WHERE uuid=?", service)
			case "inactive-target":
				_, err = s.writer.Exec("UPDATE user_accounts SET is_active=0 WHERE uuid=?", target)
			case "expired-target":
				_, err = s.writer.Exec("UPDATE user_accounts SET access_expires_at='2000-01-01T00:00:00Z' WHERE uuid=?", target)
			case "delegate-association":
				_, err = s.writer.Exec("INSERT INTO service_links(user_uuid,service_uuid,link_kind,created_at) VALUES(?,?,'delegate','2026-01-01T00:00:00Z')", target, service)
			case "logout":
				apiRequest(a, "POST", "/api/auth/logout", token, nil, nil)
				want = 401
			}
			if err != nil {
				t.Fatal(err)
			}
			w := apiRequest(a, "PUT", path, token, body, nil)
			if w.Code != want {
				t.Fatal(w.Code, w.Body.String())
			}
			var exists bool
			if err := s.reader.QueryRow("SELECT EXISTS(SELECT 1 FROM service_links WHERE user_uuid=? AND service_uuid=? AND link_kind='owner')", target, service).Scan(&exists); err != nil || exists {
				t.Fatal("denied write changed owner", err)
			}
		})
	}
}

func TestAccountLinkHierarchyAndSessionRecheck(t *testing.T) {
	a, s, ownerToken, token, actor := roleReadFixture(t)
	owner, _ := s.Authenticate(t.Context(), ownerToken)
	target, err := s.CreateAccount(t.Context(), owner.UUID, "hierarchy-target", "fixture-hash", false)
	if err != nil {
		t.Fatal(err)
	}
	service := seedService(t, s, seedServer(t, s))
	path := func(user string) string { return "/api/account-links/" + user + "/" + service }
	record := responseData(t, apiRequest(a, "GET", path(target), token, nil, nil))
	if record["can_link"] != true {
		t.Fatal(record)
	}
	for _, user := range []string{owner.UUID, actor} {
		if w := apiRequest(a, "GET", path(user), token, nil, nil); w.Code != 403 {
			t.Fatal("protected target", w.Code)
		}
		if err := s.LinkServiceAccounts(t.Context(), actor, user, []string{service}); !errors.Is(err, ErrForbidden) {
			t.Fatal("store hierarchy bypass", err)
		}
	}
	// A target's high cosmetic role protects them even though it grants no admin.
	if _, err := s.writer.Exec("INSERT INTO admin_privileges(user_uuid,role_id) VALUES(?,'high')", target); err != nil {
		t.Fatal(err)
	}
	if w := apiRequest(a, "PUT", path(target), token, accountLinkBody(record), nil); w.Code != 403 {
		t.Fatal("promoted target", w.Code, w.Body.String())
	}
	if _, err := s.writer.Exec("DELETE FROM admin_privileges WHERE user_uuid=?", target); err != nil {
		t.Fatal(err)
	}
	// The same transaction-local read used by mutations rejects an already
	// authenticated request after its live access token is removed.
	err = s.write(t.Context(), func(tx *sql.Tx) error {
		if _, err := tx.ExecContext(t.Context(), "DELETE FROM session_access_tokens WHERE token_hash=?", tokenHash(token)); err != nil {
			return err
		}
		_, err := readAccountLink(t.Context(), tx, actor, token, target, service)
		if !errors.Is(err, ErrForbidden) {
			t.Fatalf("session not rechecked: %v", err)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	// Owner self-management remains available; ordinary local users cannot read.
	responseData(t, apiRequest(a, "GET", path(owner.UUID), ownerToken, nil, nil))
	ordinary, err := s.issueSession(t.Context(), target, false)
	if err != nil {
		t.Fatal(err)
	}
	if w := apiRequest(a, "GET", path(target), ordinary.Access, nil, nil); w.Code != 403 {
		t.Fatal("ordinary access", w.Code)
	}
}
