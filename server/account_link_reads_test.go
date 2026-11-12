package main

import (
	"database/sql"
	"strings"
	"testing"
)

func TestAccountLinkSelectorSnapshotAndInactiveTarget(t *testing.T) {
	a, s := testApp(t)
	token, _ := bootstrapOwner(t, a)
	owner, _ := s.Authenticate(t.Context(), token)
	target, err := s.CreateAccount(t.Context(), owner.UUID, "selector-target", "fixture-hash", false)
	if err != nil {
		t.Fatal(err)
	}
	server := seedServer(t, s)
	linked, available, other, inactive, delegate := seedService(t, s, server), seedService(t, s, server), seedService(t, s, server), seedService(t, s, server), seedService(t, s, server)
	if err = s.LinkServiceAccounts(t.Context(), owner.UUID, target, []string{linked}); err != nil {
		t.Fatal(err)
	}
	if err = s.LinkServiceAccounts(t.Context(), owner.UUID, owner.UUID, []string{other}); err != nil {
		t.Fatal(err)
	}
	if _, err = s.writer.Exec("UPDATE service_accounts SET is_active=0 WHERE uuid=?", inactive); err != nil {
		t.Fatal(err)
	}
	if _, err = s.writer.Exec("INSERT INTO service_links(user_uuid,service_uuid,link_kind,created_at) VALUES(?,?,'delegate','2026-01-01T00:00:00Z')", target, delegate); err != nil {
		t.Fatal(err)
	}
	path := "/api/account-links/" + target + "/accounts"
	w := apiRequest(a, "GET", path, token, nil, nil)
	p := responseData(t, w)
	if p["actor_uuid"] != owner.UUID || p["user_uuid"] != target || p["can_link"] != true || p["can_unlink"] != true {
		t.Fatal(p)
	}
	if rows := p["linked_accounts"].([]any); len(rows) != 1 || rows[0].(map[string]any)["uuid"] != linked {
		t.Fatal(rows)
	}
	if rows := p["available_accounts"].([]any); len(rows) != 1 || rows[0].(map[string]any)["uuid"] != available {
		t.Fatal(rows)
	}
	for _, secret := range []string{"external_user_id", "password_hash", "api_key", "user_raw_data"} {
		if strings.Contains(w.Body.String(), secret) {
			t.Fatal("private projection", secret)
		}
	}
	pair := responseData(t, apiRequest(a, "GET", "/api/account-links/"+target+"/"+linked, token, nil, nil))
	for _, key := range []string{"role_revision", "link_revision", "profile_revision"} {
		if p[key] != pair[key] {
			t.Fatal("revision mismatch", key)
		}
	}
	if _, err = s.writer.Exec("UPDATE user_accounts SET is_active=0 WHERE uuid=?", target); err != nil {
		t.Fatal(err)
	}
	p = responseData(t, apiRequest(a, "GET", path, token, nil, nil))
	if p["can_link"] != false || len(p["available_accounts"].([]any)) != 0 || len(p["linked_accounts"].([]any)) != 1 {
		t.Fatal(p)
	}
}

func TestAccountLinkSelectorAuthorityAndBounds(t *testing.T) {
	a, s, ownerToken, token, actor := roleReadFixture(t)
	owner, _ := s.Authenticate(t.Context(), ownerToken)
	target, err := s.CreateAccount(t.Context(), owner.UUID, "bounded-selector", "fixture-hash", false)
	if err != nil {
		t.Fatal(err)
	}
	path := func(user string) string { return "/api/account-links/" + user + "/accounts" }
	responseData(t, apiRequest(a, "GET", path(target), token, nil, nil))
	for _, user := range []string{actor, owner.UUID} {
		if w := apiRequest(a, "GET", path(user), token, nil, nil); w.Code != 403 {
			t.Fatal("hierarchy", w.Code)
		}
	}
	if w := apiRequest(a, "GET", path(target), "", nil, nil); w.Code != 401 {
		t.Fatal(w.Code)
	}
	if w := apiRequest(a, "GET", path(target)+"?page=1", token, nil, nil); w.Code != 400 {
		t.Fatal(w.Code)
	}
	server := seedServer(t, s)
	err = s.write(t.Context(), func(tx *sql.Tx) error {
		if _, err := tx.Exec(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<1001)
   INSERT INTO identities(uuid,kind) SELECT printf('00000000-0000-0000-0000-%012d',x),'service' FROM n`); err != nil {
			return err
		}
		_, err := tx.Exec(`INSERT INTO service_accounts(uuid,server_id,external_user_id,created_at,updated_at)
   SELECT uuid,?,uuid,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z' FROM identities WHERE kind='service'`, server)
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	if w := apiRequest(a, "GET", path(target), token, nil, nil); w.Code != 409 {
		t.Fatal("truncated selector admitted", w.Code, w.Body.String())
	}
}
