package main

import (
	"database/sql"
	"errors"
	"strings"
	"sync"
	"testing"
)

func profileNotesBody(record map[string]any, notes string) map[string]any {
	return map[string]any{"expected_actor_uuid": record["actor_uuid"], "expected_user_uuid": record["user_uuid"], "note_revision": record["note_revision"], "role_revision": record["role_revision"], "link_revision": record["link_revision"], "notes": notes}
}

func TestProfileNotesLifecycleExactTextAndAudit(t *testing.T) {
	for _, kind := range []string{"human", "service"} {
		t.Run(kind, func(t *testing.T) {
			a, s := testApp(t)
			token, _ := bootstrapOwner(t, a)
			owner, _ := s.Authenticate(t.Context(), token)
			target := owner.UUID
			if kind == "service" {
				target = seedService(t, s, seedServer(t, s))
			}
			path := "/api/users/" + target + "/notes"
			before := responseData(t, apiRequest(a, "GET", path, token, nil, nil))
			cap := before["capabilities"].(map[string]any)
			if cap["edit_notes"] != true || cap["activation"] != false || cap["expiry"] != false || cap["provider_policy"] != false || cap["whitelist"] != false {
				t.Fatal(cap)
			}
			notes := "  Private annotation é 😀\nsecond\tline\r\n "
			saved := responseData(t, apiRequest(a, "PUT", path, token, profileNotesBody(before, notes), nil))
			if saved["notes"] != notes || saved["note_revision"] != "2" {
				t.Fatal(saved)
			}
			if w := apiRequest(a, "PUT", path, token, profileNotesBody(before, "stale"), nil); w.Code != 409 {
				t.Fatal("stale edit", w.Code)
			}
			cleared := responseData(t, apiRequest(a, "PUT", path, token, profileNotesBody(saved, ""), nil))
			if cleared["notes"] != "" || cleared["note_revision"] != "3" {
				t.Fatal(cleared)
			}
			// Same visible text does not restore an earlier note revision.
			if w := apiRequest(a, "PUT", path, token, profileNotesBody(before, "ABA"), nil); w.Code != 409 {
				t.Fatal("ABA", w.Code)
			}
			var audits int
			var details string
			if err := s.reader.QueryRow("SELECT count(*),max(details) FROM audit_events WHERE action='profile.notes.save'").Scan(&audits, &details); err != nil || audits != 2 || !strings.Contains(details, target) || strings.Contains(details, "Private annotation") {
				t.Fatal(audits, details, err)
			}
		})
	}
}

func TestProfileNotesStrictInputAndRevisionGuards(t *testing.T) {
	for _, mode := range []string{"missing", "null", "unknown", "control", "long", "utf8-bytes", "wrong-actor", "wrong-target", "note-revision", "role-revision", "link-revision", "external-note-update", "unchanged"} {
		t.Run(mode, func(t *testing.T) {
			a, s := testApp(t)
			token, _ := bootstrapOwner(t, a)
			owner, _ := s.Authenticate(t.Context(), token)
			path := "/api/users/" + owner.UUID + "/notes"
			before := responseData(t, apiRequest(a, "GET", path, token, nil, nil))
			body := profileNotesBody(before, "new")
			want := 409
			switch mode {
			case "missing":
				delete(body, "notes")
				want = 400
			case "null":
				body["notes"] = nil
				want = 400
			case "unknown":
				body["is_active"] = false
				want = 400
			case "control":
				body["notes"] = "bad\x00"
				want = 400
			case "long":
				body["notes"] = strings.Repeat("x", 16385)
				want = 400
			case "utf8-bytes":
				body["notes"] = strings.Repeat("é", 8193)
				want = 400
			case "wrong-actor":
				body["expected_actor_uuid"] = newUUID()
				want = 403
			case "wrong-target":
				body["expected_user_uuid"] = newUUID()
			case "note-revision":
				body["note_revision"] = "0"
			case "role-revision":
				body["role_revision"] = "0"
			case "link-revision":
				body["link_revision"] = "0"
			case "external-note-update":
				if _, err := s.writer.Exec("UPDATE user_accounts SET notes='external' WHERE uuid=?", owner.UUID); err != nil {
					t.Fatal(err)
				}
			case "unchanged":
				body["notes"] = ""
			}
			if w := apiRequest(a, "PUT", path, token, body, nil); w.Code != want {
				t.Fatal(w.Code, w.Body.String())
			}
			var audits int
			s.reader.QueryRow("SELECT count(*) FROM audit_events WHERE action='profile.notes.save'").Scan(&audits)
			if audits != 0 {
				t.Fatal("denied write audited as save")
			}
		})
	}
}

func TestProfileNotesDelegatedServiceOwnershipAndSession(t *testing.T) {
	a, s, ownerToken, token, actor := roleReadFixture(t)
	owner, _ := s.Authenticate(t.Context(), ownerToken)
	target, err := s.CreateAccount(t.Context(), owner.UUID, "notes-target", "fixture-hash", false)
	if err != nil {
		t.Fatal(err)
	}
	service := seedService(t, s, seedServer(t, s))
	path := func(user string) string { return "/api/users/" + user + "/notes" }
	if w := apiRequest(a, "GET", path(service), token, nil, nil); w.Code != 403 {
		t.Fatal("unowned service", w.Code)
	}
	if err = s.LinkServiceAccounts(t.Context(), owner.UUID, target, []string{service}); err != nil {
		t.Fatal(err)
	}
	before := responseData(t, apiRequest(a, "GET", path(service), token, nil, nil))
	responseData(t, apiRequest(a, "PUT", path(service), token, profileNotesBody(before, "delegated"), nil))
	for _, user := range []string{actor, owner.UUID} {
		if w := apiRequest(a, "GET", path(user), token, nil, nil); w.Code != 403 {
			t.Fatal("protected human", w.Code)
		}
	}
	before = responseData(t, apiRequest(a, "GET", path(service), token, nil, nil))
	if _, err = s.writer.Exec("INSERT INTO admin_privileges VALUES(?,'high')", target); err != nil {
		t.Fatal(err)
	}
	if w := apiRequest(a, "PUT", path(service), token, profileNotesBody(before, "blocked"), nil); w.Code != 403 {
		t.Fatal("promoted owner", w.Code)
	}
	if _, err = s.writer.Exec("DELETE FROM admin_privileges WHERE user_uuid=?", target); err != nil {
		t.Fatal(err)
	}
	if err = s.UnlinkServiceAccount(t.Context(), owner.UUID, target, service); err != nil {
		t.Fatal(err)
	}
	if w := apiRequest(a, "GET", path(service), token, nil, nil); w.Code != 403 {
		t.Fatal("removed ownership", w.Code)
	}
	// Owner reads still work, but a link cycle invalidates their earlier proof.
	before = responseData(t, apiRequest(a, "GET", path(service), ownerToken, nil, nil))
	if err = s.LinkServiceAccounts(t.Context(), owner.UUID, target, []string{service}); err != nil {
		t.Fatal(err)
	}
	if err = s.UnlinkServiceAccount(t.Context(), owner.UUID, target, service); err != nil {
		t.Fatal(err)
	}
	if w := apiRequest(a, "PUT", path(service), ownerToken, profileNotesBody(before, "cycle"), nil); w.Code != 409 {
		t.Fatal("link ABA", w.Code)
	}
	err = s.write(t.Context(), func(tx *sql.Tx) error {
		if _, err := tx.Exec("DELETE FROM session_access_tokens WHERE token_hash=?", tokenHash(token)); err != nil {
			return err
		}
		_, err := readProfileNotes(t.Context(), tx, actor, token, target)
		if !errors.Is(err, ErrForbidden) {
			t.Fatalf("live session: %v", err)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if w := apiRequest(a, "GET", path(service), "", nil, nil); w.Code != 401 {
		t.Fatal(w.Code)
	}
}

func TestProfileNotesConcurrentSaveCommitsOnce(t *testing.T) {
	a, s := testApp(t)
	token, _ := bootstrapOwner(t, a)
	owner, _ := s.Authenticate(t.Context(), token)
	path := "/api/users/" + owner.UUID + "/notes"
	before := responseData(t, apiRequest(a, "GET", path, token, nil, nil))
	results := make(chan int, 2)
	var workers sync.WaitGroup
	for range 2 {
		workers.Go(func() { results <- apiRequest(a, "PUT", path, token, profileNotesBody(before, "one winner"), nil).Code })
	}
	workers.Wait()
	close(results)
	codes := map[int]int{}
	for code := range results {
		codes[code]++
	}
	if codes[200] != 1 || codes[409] != 1 {
		t.Fatal(codes)
	}
	var revision int
	if err := s.reader.QueryRow("SELECT revision FROM profile_note_state WHERE uuid=?", owner.UUID).Scan(&revision); err != nil || revision != 2 {
		t.Fatal(revision, err)
	}
}

func TestProfileNotesDurableFailuresRollBack(t *testing.T) {
	for _, mode := range []string{"audit", "revision-overflow"} {
		t.Run(mode, func(t *testing.T) {
			a, s := testApp(t)
			token, _ := bootstrapOwner(t, a)
			owner, _ := s.Authenticate(t.Context(), token)
			path := "/api/users/" + owner.UUID + "/notes"
			if mode == "audit" {
				if _, err := s.writer.Exec(`CREATE TRIGGER reject_note_audit BEFORE INSERT ON audit_events WHEN NEW.action='profile.notes.save' BEGIN SELECT RAISE(ABORT,'fixture failure'); END`); err != nil {
					t.Fatal(err)
				}
			} else {
				if _, err := s.writer.Exec("UPDATE profile_note_state SET revision=9223372036854775807 WHERE uuid=?", owner.UUID); err != nil {
					t.Fatal(err)
				}
			}
			before := responseData(t, apiRequest(a, "GET", path, token, nil, nil))
			if w := apiRequest(a, "PUT", path, token, profileNotesBody(before, "must roll back"), nil); w.Code < 400 {
				t.Fatal("failed write admitted", w.Code)
			}
			after := responseData(t, apiRequest(a, "GET", path, token, nil, nil))
			if after["notes"] != before["notes"] || after["note_revision"] != before["note_revision"] {
				t.Fatal("partial save", after)
			}
		})
	}
}
