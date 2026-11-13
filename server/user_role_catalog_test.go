package main

import (
	"encoding/json"
	"strconv"
	"sync"
	"testing"
)

func TestUserRoleCatalogDistinctUserListFilters(t *testing.T) {
	a, s, owner, _, actor, target := humanRolesFixture(t)
	if _, err := s.writer.Exec("UPDATE admin_roles SET name='Friend' WHERE id='high'"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.writer.Exec("INSERT INTO identity_user_roles VALUES(?,'manual-b')", target); err != nil {
		t.Fatal(err)
	}
	for _, filter := range []struct{ query, want string }{{"user_role_id=manual-b", target}, {"admin_role_id=high", actor}} {
		w := apiRequest(a, "GET", "/api/users?"+filter.query, owner, nil, nil)
		var response struct {
			Data []struct {
				UUID string `json:"uuid"`
			} `json:"data"`
		}
		if err := json.Unmarshal(w.Body.Bytes(), &response); err != nil || w.Code != 200 || len(response.Data) != 1 || response.Data[0].UUID != filter.want {
			t.Fatal(filter.query, w.Code, w.Body.String(), err)
		}
	}
	for _, query := range []string{"role=Friend", "user_role_id=manual-b&admin_role_id=high"} {
		if w := apiRequest(a, "GET", "/api/users?"+query, owner, nil, nil); w.Code != 400 {
			t.Fatal(query, w.Code)
		}
	}
}

func catalogChangeBody(p map[string]any, operation, id string) map[string]any {
	out := map[string]any{"expected_actor_uuid": p["actor_uuid"], "catalog_revision": p["catalog_revision"], "role_revision": p["role_revision"], "link_revision": p["link_revision"], "operation": operation, "acknowledge_visual_only": true}
	if id != "" {
		out["role_id"] = id
	}
	if operation == "create" || operation == "update" {
		out["role"] = map[string]any{"name": "Visual family", "description": "One\nTwo", "color": "#123abc", "icon": "fa-solid fa-tag", "badge_style": "outline"}
	}
	if operation == "delete" {
		out["acknowledge_delete"] = true
	}
	return out
}
func catalogRole(t *testing.T, p map[string]any, id string) map[string]any {
	t.Helper()
	for _, r := range p["roles"].([]any) {
		role := r.(map[string]any)
		if role["id"] == id {
			return role
		}
	}
	t.Fatal("role absent", id)
	return nil
}

func TestUserRoleCatalogOwnerMetadataAndEmptyDeletionPreserveMemberships(t *testing.T) {
	a, s, owner, _, _, target := humanRolesFixture(t)
	base := responseData(t, apiRequest(a, "GET", "/api/user-role-catalog", owner, nil, nil))
	created := responseData(t, apiRequest(a, "POST", "/api/user-role-catalog/changes", owner, catalogChangeBody(base, "create", ""), nil))
	id := created["role_id"].(string)
	service := seedService(t, s, seedServer(t, s))
	p, _ := s.Authenticate(t.Context(), owner)
	if err := s.LinkServiceAccounts(t.Context(), p.UUID, target, []string{service}); err != nil {
		t.Fatal(err)
	}
	for _, member := range []string{target, service} {
		if _, err := s.writer.Exec("INSERT INTO identity_user_roles VALUES(?,?)", member, id); err != nil {
			t.Fatal(err)
		}
	}
	session, err := s.issueSession(t.Context(), target, false)
	if err != nil {
		t.Fatal(err)
	}
	base = responseData(t, apiRequest(a, "GET", "/api/user-role-catalog", owner, nil, nil))
	entry := catalogRole(t, base, id)
	if entry["can_update"] != true || entry["can_delete"] != false || entry["user_count"] != float64(2) {
		t.Fatal(entry)
	}
	body := catalogChangeBody(base, "update", id)
	body["role"].(map[string]any)["name"] = "administrator"
	responseData(t, apiRequest(a, "POST", "/api/user-role-catalog/changes", owner, body, nil))
	principal, err := s.Authenticate(t.Context(), session.Access)
	if err != nil || principal.Admin {
		t.Fatal("visual metadata altered authority", err)
	}
	var members int
	if err = s.reader.QueryRow("SELECT count(*) FROM identity_user_roles WHERE role_id=?", id).Scan(&members); err != nil || members != 2 {
		t.Fatal(members, err)
	}
	profile := responseData(t, apiRequest(a, "GET", "/api/users/"+target, owner, nil, nil))
	found := false
	for _, r := range profile["user_roles"].([]any) {
		row := r.(map[string]any)
		if row["name"] == "administrator" {
			found = row["color"] == "#123abc" && row["badge_style"] == "outline"
		}
	}
	if !found {
		t.Fatal(profile)
	}
	base = responseData(t, apiRequest(a, "GET", "/api/user-role-catalog", owner, nil, nil))
	if w := apiRequest(a, "POST", "/api/user-role-catalog/changes", owner, catalogChangeBody(base, "delete", id), nil); w.Code != 403 {
		t.Fatal("assigned role deleted", w.Code)
	}
	responseData(t, apiRequest(a, "POST", "/api/user-role-catalog/changes", owner, catalogChangeBody(base, "delete", "manual-b"), nil))
	var raw string
	if err = s.reader.QueryRow("SELECT details FROM audit_events WHERE action='user_role.catalog.change' AND json_extract(details,'$.operation')='update'").Scan(&raw); err != nil {
		t.Fatal(err)
	}
	var audit struct {
		Affected []string               `json:"affected_identity_ids"`
		Before   []userRoleCatalogEntry `json:"before"`
		After    []userRoleCatalogEntry `json:"after"`
	}
	if err = json.Unmarshal([]byte(raw), &audit); err != nil || len(audit.Affected) != 2 || audit.Before[0].Name != "Visual family" || audit.After[0].Name != "administrator" {
		t.Fatal(raw, err)
	}
}

func TestUserRoleCatalogCompleteReorderAndProfileBadgeOrder(t *testing.T) {
	a, s, owner, _, _, target := humanRolesFixture(t)
	if _, err := s.writer.Exec("DELETE FROM user_roles WHERE id='automatic'"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.writer.Exec("INSERT INTO identity_user_roles(user_uuid,role_id) VALUES(?,'manual-a'),(?,'manual-b')", target, target); err != nil {
		t.Fatal(err)
	}
	base := responseData(t, apiRequest(a, "GET", "/api/user-role-catalog", owner, nil, nil))
	if base["can_reorder"] != true {
		t.Fatal(base)
	}
	body := catalogChangeBody(base, "reorder", "")
	body["positions"] = []userRoleCatalogPosition{{"manual-a", 10}, {"manual-b", 20}}
	receipt := responseData(t, apiRequest(a, "POST", "/api/user-role-catalog/changes", owner, body, nil))
	before, _ := strconv.ParseInt(base["catalog_revision"].(string), 10, 64)
	after, _ := strconv.ParseInt(receipt["catalog_revision"].(string), 10, 64)
	if after != before+2 {
		t.Fatal(receipt)
	}
	profile := responseData(t, apiRequest(a, "GET", "/api/users/"+target, owner, nil, nil))
	roles := profile["user_roles"].([]any)
	if roles[0].(map[string]any)["name"] != "Friend" {
		t.Fatal(roles)
	}
	var count int
	if err := s.reader.QueryRow("SELECT count(*) FROM audit_events WHERE action='user_role.catalog.change' AND json_array_length(json_extract(details,'$.affected_identity_ids'))=1").Scan(&count); err != nil || count != 1 {
		t.Fatal("incomplete order audit", count, err)
	}
}

func TestUserRoleCatalogProtectedHumanServiceAndPendingMembers(t *testing.T) {
	for _, mode := range []string{"owner", "owned-service", "unlinked-service", "inactive-human", "automatic", "pending", "global-review", "personal-operation", "delegate"} {
		t.Run(mode, func(t *testing.T) {
			a, s, owner, admin, _, target := humanRolesFixture(t)
			p, _ := s.Authenticate(t.Context(), owner)
			member := target
			id := "manual-a"
			access := owner
			want := 403
			switch mode {
			case "owner":
				member = p.UUID
			case "owned-service", "unlinked-service":
				member = seedService(t, s, seedServer(t, s))
				if mode == "owned-service" {
					if err := s.LinkServiceAccounts(t.Context(), p.UUID, p.UUID, []string{member}); err != nil {
						t.Fatal(err)
					}
				} else {
					want = 200
				}
			case "inactive-human":
				if _, err := s.writer.Exec("UPDATE user_accounts SET is_active=0,access_expires_at='2000-01-01T00:00:00Z',password_hash=NULL WHERE uuid=?", target); err != nil {
					t.Fatal(err)
				}
				want = 200
			case "automatic":
				// Automatic roles can be renamed and restyled, as in Flask.
				id = "automatic"
				want = 200
			case "pending":
				if _, err := s.writer.Exec(`INSERT INTO provisioning_jobs(id,user_uuid,status,created_at,updated_at) VALUES('catalog-job',?,'failed','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')`, target); err != nil {
					t.Fatal(err)
				}
			case "global-review":
				if _, err := s.writer.Exec(`INSERT INTO provisioning_jobs(id,user_uuid,status,review_token,created_at,updated_at) VALUES('catalog-job',?,'failed','claimed','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')`, p.UUID); err != nil {
					t.Fatal(err)
				}
			case "personal-operation":
				if _, err := s.writer.Exec(`INSERT INTO plex_authorizations(id,owner_uuid,browser_hash,status,expires_at,poll_after,operation_token,created_at,updated_at) VALUES('catalog-proof',?,'fixture','pending','2099-01-01T00:00:00Z','2026-01-01T00:00:00Z','claimed','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')`, target); err != nil {
					t.Fatal(err)
				}
			case "delegate":
				access = admin
			}
			if id != "automatic" {
				if _, err := s.writer.Exec("INSERT INTO identity_user_roles VALUES(?,?)", member, id); err != nil {
					t.Fatal(err)
				}
			}
			base := responseData(t, apiRequest(a, "GET", "/api/user-role-catalog", access, nil, nil))
			if w := apiRequest(a, "POST", "/api/user-role-catalog/changes", access, catalogChangeBody(base, "update", id), nil); w.Code != want {
				t.Fatal(mode, w.Code, w.Body.String())
			}
		})
	}
}

func TestUserRoleCatalogStaleProofsAndInvalidChanges(t *testing.T) {
	for _, mode := range []string{"actor", "catalog", "role", "link", "member-cycle", "link-cycle", "role-cycle", "duplicate-name", "bad-color", "bad-description", "auto-field", "missing-ack", "mixed", "noop", "session", "permission", "reorder-automatic", "missing-order", "duplicate-order", "partial-order", "unknown-order"} {
		t.Run(mode, func(t *testing.T) {
			a, s, owner, admin, actor, target := humanRolesFixture(t)
			if mode == "duplicate-order" || mode == "partial-order" || mode == "unknown-order" {
				if _, err := s.writer.Exec("DELETE FROM user_roles WHERE id='automatic'"); err != nil {
					t.Fatal(err)
				}
			}
			base := responseData(t, apiRequest(a, "GET", "/api/user-role-catalog", owner, nil, nil))
			body := catalogChangeBody(base, "update", "manual-a")
			want := 409
			access := owner
			switch mode {
			case "actor":
				body["expected_actor_uuid"] = target
				want = 403
			case "catalog":
				body["catalog_revision"] = "0"
			case "role":
				body["role_revision"] = "0"
			case "link":
				body["link_revision"] = "0"
			case "member-cycle":
				if _, err := s.writer.Exec("INSERT INTO identity_user_roles VALUES(?,'manual-a')", target); err != nil {
					t.Fatal(err)
				}
				if _, err := s.writer.Exec("DELETE FROM identity_user_roles WHERE user_uuid=? AND role_id='manual-a'", target); err != nil {
					t.Fatal(err)
				}
			case "link-cycle":
				service := seedService(t, s, seedServer(t, s))
				if _, err := s.writer.Exec("INSERT INTO service_links(user_uuid,service_uuid,link_kind,created_at) VALUES(?,?,'owner','2026-01-01T00:00:00Z')", target, service); err != nil {
					t.Fatal(err)
				}
				if _, err := s.writer.Exec("DELETE FROM service_links WHERE service_uuid=?", service); err != nil {
					t.Fatal(err)
				}
			case "role-cycle":
				if _, err := s.writer.Exec("UPDATE user_roles SET is_auto_managed=1 WHERE id='manual-a'"); err != nil {
					t.Fatal(err)
				}
				if _, err := s.writer.Exec("UPDATE user_roles SET is_auto_managed=0 WHERE id='manual-a'"); err != nil {
					t.Fatal(err)
				}
			case "duplicate-name":
				body["role"].(map[string]any)["name"] = "friend"
			case "bad-color":
				body["role"].(map[string]any)["color"] = "red"
				want = 400
			case "bad-description":
				body["role"].(map[string]any)["description"] = "bad\x00"
				want = 400
			case "auto-field":
				body["is_auto_managed"] = true
				want = 400
			case "missing-ack":
				delete(body, "acknowledge_visual_only")
				want = 400
			case "mixed":
				body["positions"] = []userRoleCatalogPosition{{"manual-a", 0}}
				want = 400
			case "noop":
				body["role"] = map[string]any{"name": "Family", "description": nil, "color": "#808080", "icon": nil, "badge_style": "default"}
			case "session":
				p, _ := s.Authenticate(t.Context(), owner)
				if _, err := s.writer.Exec("DELETE FROM app_sessions WHERE user_uuid=?", p.UUID); err != nil {
					t.Fatal(err)
				}
				want = 401
			case "permission":
				access = admin
				body["expected_actor_uuid"] = actor
				if _, err := s.writer.Exec("DELETE FROM admin_privileges WHERE user_uuid=?", actor); err != nil {
					t.Fatal(err)
				}
				want = 403
			case "reorder-automatic":
				// Automatic roles can be moved; only their position changes.
				body = catalogChangeBody(base, "reorder", "")
				body["positions"] = []userRoleCatalogPosition{{"manual-a", 1}, {"manual-b", 2}, {"automatic", 0}}
				want = 200
			case "missing-order":
				body = catalogChangeBody(base, "reorder", "")
				want = 400
			case "duplicate-order":
				body = catalogChangeBody(base, "reorder", "")
				body["positions"] = []userRoleCatalogPosition{{"manual-a", 1}, {"manual-a", 2}}
			case "partial-order":
				body = catalogChangeBody(base, "reorder", "")
				body["positions"] = []userRoleCatalogPosition{{"manual-a", 1}, {"manual-b", 2}, {"extra", 3}}
			case "unknown-order":
				body = catalogChangeBody(base, "reorder", "")
				body["positions"] = []userRoleCatalogPosition{{"manual-a", 1}, {"missing", 2}}
			}
			if w := apiRequest(a, "POST", "/api/user-role-catalog/changes", access, body, nil); w.Code != want {
				t.Fatal(mode, w.Code, w.Body.String())
			}
		})
	}
}

func TestUserRoleCatalogRollbackAndConcurrentMetadataWrites(t *testing.T) {
	a, s, owner, _, _, _ := humanRolesFixture(t)
	base := responseData(t, apiRequest(a, "GET", "/api/user-role-catalog", owner, nil, nil))
	if _, err := s.writer.Exec(`CREATE TRIGGER fail_catalog_audit BEFORE INSERT ON audit_events WHEN NEW.action='user_role.catalog.change' BEGIN SELECT RAISE(ABORT,'fixture'); END`); err != nil {
		t.Fatal(err)
	}
	if w := apiRequest(a, "POST", "/api/user-role-catalog/changes", owner, catalogChangeBody(base, "update", "manual-a"), nil); w.Code != 500 {
		t.Fatal(w.Code)
	}
	after := responseData(t, apiRequest(a, "GET", "/api/user-role-catalog", owner, nil, nil))
	if after["catalog_revision"] != base["catalog_revision"] || catalogRole(t, after, "manual-a")["name"] != "Family" {
		t.Fatal("failed audit did not roll back", after)
	}
	if _, err := s.writer.Exec("DROP TRIGGER fail_catalog_audit"); err != nil {
		t.Fatal(err)
	}
	codes := make(chan int, 2)
	var wg sync.WaitGroup
	for range 2 {
		wg.Go(func() {
			codes <- apiRequest(a, "POST", "/api/user-role-catalog/changes", owner, catalogChangeBody(base, "update", "manual-a"), nil).Code
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
