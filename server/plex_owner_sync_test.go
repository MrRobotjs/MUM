package main

import (
	"fmt"
	"strings"
	"testing"
)

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
	// If the owner cannot be read, the sync fails rather than deactivating them.
	mode.Store(4)
	if w := apiRequest(a, "POST", path, token, nil, nil); w.Code == 200 {
		t.Fatal("sync without the owner account accepted")
	}
	if err := store.reader.QueryRow(`SELECT is_active FROM service_accounts WHERE uuid='owner-observed'`).Scan(&active); err != nil || !active {
		t.Fatal("owner deactivated by a failed sync", err)
	}
}
