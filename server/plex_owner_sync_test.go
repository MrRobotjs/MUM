package main

import (
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"
)

func TestPlexOwnerIsManagedCatalogRole(t *testing.T) {
	upstream, client, _ := extendedProviderFixture(t, "plex")
	a, store := testApp(t)
	a.ProviderHTTP = client
	token, _ := bootstrapOwner(t, a)
	id := createManagedServer(t, a, token, "plex", upstream.URL+"/proxy")
	var role string
	if err := store.reader.QueryRow(`SELECT id FROM user_roles WHERE name='Owner' AND is_auto_managed=1`).Scan(&role); err != nil {
		t.Fatalf("automatic Owner role missing: %v", err)
	}
	if w := apiRequest(a, "POST", fmt.Sprintf("/api/servers/%d/sync", id), token, nil, nil); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	var owners, friends int
	if err := store.reader.QueryRow(`SELECT count(*) FILTER (WHERE a.external_user_id='1'),count(*) FILTER (WHERE a.external_user_id='2') FROM identity_user_roles m JOIN service_accounts a ON a.uuid=m.user_uuid WHERE a.server_id=? AND m.role_id=?`, id, role).Scan(&owners, &friends); err != nil {
		t.Fatal(err)
	}
	if owners != 1 || friends != 0 {
		t.Fatalf("owner memberships=%d friend memberships=%d", owners, friends)
	}
	base := responseData(t, apiRequest(a, "GET", "/api/user-role-catalog", token, nil, nil))
	change := catalogChangeBody(base, "update", role)
	change["role"] = map[string]any{"name": "Plex Owner", "description": nil, "color": "#123abc", "icon": "fa-solid fa-crown", "badge_style": "outline"}
	if w := apiRequest(a, "POST", "/api/user-role-catalog/changes", token, change, nil); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	if w := apiRequest(a, "POST", fmt.Sprintf("/api/servers/%d/sync", id), token, nil, nil); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	var name string
	if err := store.reader.QueryRow(`SELECT r.name FROM user_roles r JOIN identity_user_roles m ON m.role_id=r.id JOIN service_accounts a ON a.uuid=m.user_uuid WHERE a.server_id=? AND a.external_user_id='1' AND r.id=?`, id, role).Scan(&name); err != nil || name != "Plex Owner" {
		t.Fatalf("renamed role lost on sync: %q %v", name, err)
	}
}

func TestPlexOwnerRoleMigrationBackfillsAndAvoidsManualCollision(t *testing.T) {
	for _, collision := range []bool{false, true} {
		t.Run(fmt.Sprint(collision), func(t *testing.T) {
			path, db := openSchemaBefore(t, "092")
			for _, q := range []string{`INSERT INTO media_servers(id,server_nickname,service_type,url) VALUES(1,'fixture','plex','http://fixture.invalid')`, `INSERT INTO identities(uuid,kind) VALUES('plex-owner','service'),('plex-friend','service')`, `INSERT INTO service_accounts(uuid,server_id,external_user_id,created_at,updated_at) VALUES('plex-owner',1,'1','2026','2026'),('plex-friend',1,'2','2026','2026')`} {
				if _, err := db.Exec(q); err != nil {
					t.Fatal(err)
				}
			}
			if collision {
				if _, err := db.Exec(`INSERT INTO user_roles(id,name,is_auto_managed) VALUES('manual-owner','Owner',0)`); err != nil {
					t.Fatal(err)
				}
			}
			if err := db.Close(); err != nil {
				t.Fatal(err)
			}
			s, err := OpenStore(t.Context(), path)
			if err != nil {
				t.Fatal(err)
			}
			defer s.Close()
			var roles, owner, friend int
			if err := s.reader.QueryRow(`SELECT (SELECT count(*) FROM plex_owner_role),(SELECT count(*) FROM identity_user_roles WHERE user_uuid='plex-owner'),(SELECT count(*) FROM identity_user_roles WHERE user_uuid='plex-friend')`).Scan(&roles, &owner, &friend); err != nil {
				t.Fatal(err)
			}
			want := 1
			if collision {
				want = 0
			}
			if roles != want || owner != want || friend != 0 {
				t.Fatalf("roles=%d owner=%d friend=%d", roles, owner, friend)
			}
		})
	}
}

func TestPlexOwnerHomeStatusFollowsExplicitAccountFlag(t *testing.T) {
	upstream, client, _ := extendedProviderFixture(t, "plex")
	base := client.Transport
	flag := ` home="1"`
	client.Transport = providerTransport(func(r *http.Request) (*http.Response, error) {
		response, err := base.RoundTrip(r)
		if err != nil || r.URL.Path != "/users/account" {
			return response, err
		}
		body, err := io.ReadAll(response.Body)
		response.Body.Close()
		if err != nil {
			return nil, err
		}
		value := strings.Replace(string(body), `<user `, `<user`+flag+` `, 1)
		response.Body = io.NopCloser(strings.NewReader(value))
		response.ContentLength = int64(len(value))
		return response, nil
	})
	a, store := testApp(t)
	a.ProviderHTTP = client
	token, _ := bootstrapOwner(t, a)
	id := createManagedServer(t, a, token, "plex", upstream.URL+"/proxy")
	for _, step := range []struct {
		flag string
		want bool
	}{{` home="1"`, true}, {``, true}, {` home="0"`, false}} {
		flag = step.flag
		w := apiRequest(a, "POST", fmt.Sprintf("/api/servers/%d/sync", id), token, nil, nil)
		if w.Code != 200 {
			t.Fatal(w.Code, w.Body.String())
		}
		var got bool
		if err := store.reader.QueryRow(`SELECT EXISTS(SELECT 1 FROM service_accounts a JOIN identity_user_roles m ON m.user_uuid=a.uuid JOIN relationship_roles r ON r.role_id=m.role_id WHERE a.server_id=? AND a.external_user_id='1' AND r.kind='home_user')`, id).Scan(&got); err != nil {
			t.Fatal(err)
		}
		if got != step.want {
			t.Fatalf("flag %q: home label=%v, want %v", flag, got, step.want)
		}
	}
}

// The server owner never appears in plex.tv's shared-user list. Sync adds the
// token's account as the server's local account 1 (the ID Plex sessions report
// for the owner) with full library access, updating an activity-created record
// instead of duplicating it.
func TestPlexSyncAddsServerOwnerAsLocalAccountOne(t *testing.T) {
	upstream, client, mode := extendedProviderFixture(t, "plex")
	a, store := testApp(t)
	a.ProviderHTTP = client
	token, _ := bootstrapOwner(t, a)
	id := createManagedServer(t, a, token, "plex", upstream.URL+"/proxy")
	// Activity monitoring saw the owner stream before any user sync.
	activityExec(t, store, "INSERT INTO identities(uuid,kind) VALUES('owner-observed','service')")
	activityExec(t, store, `INSERT INTO service_accounts(uuid,server_id,external_user_id,external_username,service_settings,created_at,updated_at) VALUES('owner-observed',?,'1','ServerOwner','{"activity_observed":true}','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')`, id)
	path := fmt.Sprintf("/api/servers/%d/sync", id)
	if w := apiRequest(a, "POST", path, token, nil, nil); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	var count int
	var uuid, name, email, avatar, settings string
	var active bool
	if err := store.reader.QueryRow(`SELECT count(*),max(uuid),max(external_username),coalesce(max(external_email),''),coalesce(max(external_avatar_url),''),max(service_settings),max(is_active) FROM service_accounts WHERE server_id=? AND external_user_id IN ('1','9001')`, id).Scan(&count, &uuid, &name, &email, &avatar, &settings, &active); err != nil {
		t.Fatal(err)
	}
	if count != 1 || uuid != "owner-observed" {
		t.Fatalf("owner duplicated or replaced: count=%d uuid=%s", count, uuid)
	}
	if name != "ServerOwner" || email != "owner@example.invalid" || avatar != "https://plex.tv/users/0123456789abcdef/avatar?c=5" || !active {
		t.Fatalf("owner profile: %q %q %q %v", name, email, avatar, active)
	}
	if !strings.Contains(settings, `"all_libraries":true`) || strings.Contains(settings, "never-persist") {
		t.Fatalf("owner should have full access and no secrets: %s", settings)
	}
	profile := responseData(t, apiRequest(a, "GET", "/api/users/owner-observed", token, nil, nil))
	roles, ok := profile["user_roles"].([]any)
	if !ok {
		t.Fatalf("missing roles: %#v", profile)
	}
	foundOwner := false
	for _, value := range roles {
		if role, ok := value.(map[string]any); ok && role["name"] == "Owner" {
			foundOwner = true
		}
	}
	if !foundOwner {
		t.Fatal("Plex server owner is missing the Owner badge")
	}
	// If the owner cannot be read, the sync fails rather than deactivating them.
	mode.Store(4)
	if w := apiRequest(a, "POST", path, token, nil, nil); w.Code == 200 {
		t.Fatal("sync without the owner account accepted")
	}
	if err := store.reader.QueryRow(`SELECT is_active FROM service_accounts WHERE uuid='owner-observed'`).Scan(&active); err != nil || !active {
		t.Fatal("owner deactivated by a failed sync", err)
	}
}
