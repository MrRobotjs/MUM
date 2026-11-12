package main

import (
	"database/sql"
	"testing"
	"time"
)

func TestEditLocalOwnershipChangesRespectRemoteSourceLocks(t *testing.T) {
	a, s := testApp(t)
	token, _ := bootstrapOwner(t, a)
	owner, _ := s.Authenticate(t.Context(), token)
	local, _ := s.CreateAccount(t.Context(), owner.UUID, "locked-links", "fixture-hash", false)
	server := seedServer(t, s)
	service := seedService(t, s, server)
	activityExec(t, s, "INSERT INTO edit_operations(id,actor_uuid,access_hash,request_id,request_hash,action,payload,targets,results,warnings,effects,state,role_revision,created_at,updated_at) VALUES('lock-fixture',?,?,'lock-request','fixture','delete_users','{}','[]','[]','[]','[]','needs_review',1,?,?)", owner.UUID, tokenHash(token), utcTimestamp(time.Now()), utcTimestamp(time.Now()))
	activityExec(t, s, "INSERT INTO edit_source_locks(server_id,operation_id,operation_token) VALUES(?,'lock-fixture','fixture-token')", server)
	err := s.write(t.Context(), func(tx *sql.Tx) error {
		prepared, e := prepareEditLocal(t.Context(), tx, owner.UUID, token, service, editOperationInput{Action: "link_local", TargetLocalUserUUID: local})
		if e == nil && prepared.Outcome != "skipped" {
			t.Fatal("link ignored unresolved provider work")
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}

func TestEditLocalExpiryBoundsAndElapsedExtension(t *testing.T) {
	now := time.Date(2026, 11, 7, 12, 0, 0, 0, time.UTC)
	elapsed := "2000-01-01T00:00:00Z"
	next, err := editLocalExpiry(editOperationInput{Action: "extend_access", Days: 2}, &elapsed, now)
	if err != nil || next == nil || *next != "2026-11-09T12:00:00Z" {
		t.Fatalf("%v %v", next, err)
	}
	for _, days := range []int{0, -1, 36501} {
		if _, err := editLocalExpiry(editOperationInput{Action: "extend_access", Days: days}, nil, now); err == nil {
			t.Fatalf("accepted %d", days)
		}
	}
	future := "9999-12-31T00:00:00Z"
	if _, err := editLocalExpiry(editOperationInput{Action: "extend_access", Days: 2}, &future, now); err == nil {
		t.Fatal("accepted overflow")
	}
	offset := "2099-01-01T01:00:00+01:00"
	if _, err := editLocalExpiry(editOperationInput{Action: "set_expiration", ExpiresAt: &offset}, nil, now); err == nil {
		t.Fatal("accepted noncanonical UTC")
	}
}

func TestEditLocalExpiryRevokesSessionsAndPreservesService(t *testing.T) {
	_, s, access, _, _ := roleReadFixture(t)
	actor, err := s.Authenticate(t.Context(), access)
	if err != nil {
		t.Fatal(err)
	}
	target, err := s.CreateAccount(t.Context(), actor.UUID, "edit-expiry", "fixture-hash", false)
	if err != nil {
		t.Fatal(err)
	}
	session, err := s.issueSession(t.Context(), target, false)
	if err != nil {
		t.Fatal(err)
	}
	service := seedService(t, s, seedServer(t, s))
	if err = s.LinkServiceAccounts(t.Context(), actor.UUID, target, []string{service}); err != nil {
		t.Fatal(err)
	}
	after := "2099-01-01T00:00:00Z"
	op := editOperationInput{Action: "set_expiration", ExpiresAt: &after}
	err = s.write(t.Context(), func(tx *sql.Tx) error {
		prepared, e := prepareEditLocal(t.Context(), tx, actor.UUID, access, target, op)
		if e != nil {
			return e
		}
		if prepared.Outcome != "updated" || prepared.Fingerprint == "" {
			t.Fatalf("%+v", prepared)
		}
		result, e := applyEditLocal(t.Context(), tx, actor.UUID, access, target, op, prepared)
		if result.Outcome != "updated" {
			t.Fatalf("%+v", result)
		}
		return e
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.Authenticate(t.Context(), session.Access); err == nil {
		t.Fatal("session survived expiry mutation")
	}
	var count int
	if err = s.reader.QueryRow("SELECT count(*) FROM service_links WHERE user_uuid=? AND service_uuid=?", target, service).Scan(&count); err != nil || count != 1 {
		t.Fatalf("link lost: %d %v", count, err)
	}
}

func TestEditLocalLinkGroupAndRetirementPreserveServices(t *testing.T) {
	_, s, access, _, _ := roleReadFixture(t)
	actor, err := s.Authenticate(t.Context(), access)
	if err != nil {
		t.Fatal(err)
	}
	target, err := s.CreateAccount(t.Context(), actor.UUID, "edit-link", "fixture-hash", false)
	if err != nil {
		t.Fatal(err)
	}
	server := seedServer(t, s)
	first := seedService(t, s, server)
	second := seedService(t, s, server)
	op := editOperationInput{Action: "link_local", TargetLocalUserUUID: target}
	err = s.write(t.Context(), func(tx *sql.Tx) error {
		a, e := prepareEditLocal(t.Context(), tx, actor.UUID, access, first, op)
		if e != nil {
			return e
		}
		b, e := prepareEditLocal(t.Context(), tx, actor.UUID, access, second, op)
		if e != nil {
			return e
		}
		for i, p := range []editLocalSelection{a, b} {
			id := []string{first, second}[i]
			result, e := applyEditLocal(t.Context(), tx, actor.UUID, access, id, op, p)
			if e != nil {
				return e
			}
			if result.Outcome != "updated" {
				t.Fatalf("%+v", result)
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	deletion := editOperationInput{Action: "delete_users"}
	err = s.write(t.Context(), func(tx *sql.Tx) error {
		prepared, e := prepareEditLocal(t.Context(), tx, actor.UUID, access, target, deletion)
		if e != nil {
			return e
		}
		result, e := applyEditLocal(t.Context(), tx, actor.UUID, access, target, deletion, prepared)
		if result.Outcome != "deleted" {
			t.Fatalf("%+v", result)
		}
		return e
	})
	if err != nil {
		t.Fatal(err)
	}
	var services, links int
	if err = s.reader.QueryRow("SELECT count(*) FROM service_accounts WHERE uuid IN (?,?)", first, second).Scan(&services); err != nil {
		t.Fatal(err)
	}
	if err = s.reader.QueryRow("SELECT count(*) FROM service_links WHERE user_uuid=?", target).Scan(&links); err != nil || services != 2 || links != 0 {
		t.Fatalf("services %d links %d error %v", services, links, err)
	}
	err = s.write(t.Context(), func(tx *sql.Tx) error {
		prepared, e := prepareEditLocal(t.Context(), tx, actor.UUID, access, first, op)
		if e == nil && prepared.Outcome != "skipped" {
			t.Fatalf("retired destination accepted: %+v", prepared)
		}
		return e
	})
	if err != nil {
		t.Fatal(err)
	}
}

func TestEditLocalProtectsOwnerAndExistingPrimary(t *testing.T) {
	_, s, access, _, _ := roleReadFixture(t)
	actor, err := s.Authenticate(t.Context(), access)
	if err != nil {
		t.Fatal(err)
	}
	firstOwner, err := s.CreateAccount(t.Context(), actor.UUID, "edit-first-owner", "fixture-hash", false)
	if err != nil {
		t.Fatal(err)
	}
	other, err := s.CreateAccount(t.Context(), actor.UUID, "edit-other-owner", "fixture-hash", false)
	if err != nil {
		t.Fatal(err)
	}
	service := seedService(t, s, seedServer(t, s))
	if err = s.LinkServiceAccounts(t.Context(), actor.UUID, firstOwner, []string{service}); err != nil {
		t.Fatal(err)
	}
	err = s.write(t.Context(), func(tx *sql.Tx) error {
		for _, action := range []string{"delete_users", "clear_expiration"} {
			p, e := prepareEditLocal(t.Context(), tx, actor.UUID, access, actor.UUID, editOperationInput{Action: action})
			if e != nil {
				return e
			}
			if p.Outcome != "skipped" || p.Reason != "protected_owner" {
				t.Fatalf("owner protection: %+v", p)
			}
		}
		p, e := prepareEditLocal(t.Context(), tx, actor.UUID, access, service, editOperationInput{Action: "link_local", TargetLocalUserUUID: other})
		if e != nil {
			return e
		}
		if p.Outcome != "skipped" {
			t.Fatalf("stole primary: %+v", p)
		}
		p, e = prepareEditLocal(t.Context(), tx, actor.UUID, access, service, editOperationInput{Action: "unlink_local", TargetLocalUserUUID: other})
		if e != nil {
			return e
		}
		if p.Outcome != "skipped" {
			t.Fatalf("unlinked other primary: %+v", p)
		}
		p, e = prepareEditLocal(t.Context(), tx, actor.UUID, access, service, editOperationInput{Action: "link_local", TargetLocalUserUUID: firstOwner})
		if e != nil {
			return e
		}
		if p.Outcome != "unchanged" {
			t.Fatalf("existing owner not unchanged: %+v", p)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}
