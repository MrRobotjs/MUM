package main

import (
	"testing"
)

// An ordinary users/libraries sync bumps the content revision. It must not
// silently revoke the owner's activity-monitoring consent.
func TestOrdinarySyncPreservesMonitoringConsent(t *testing.T) {
	upstream, _ := providerFixture(t, "jellyfin")
	a, s := testApp(t)
	token, _ := bootstrapOwner(t, a)
	owner, _ := s.Authenticate(t.Context(), token)
	server := createManagedServer(t, a, token, "jellyfin", upstream.URL)
	configureTestMonitor(t, a, token, server, true)
	snapshot, err := a.loadServer(t.Context(), server)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := a.syncServer(t.Context(), owner.UUID, token, snapshot, true, true); err != nil {
		t.Fatal("sync", err)
	}
	claim, err := a.claimActivityMonitor(t.Context())
	if err != nil || claim == nil {
		t.Fatal("ordinary sync revoked monitoring consent", err)
	}
	if task := monitorSnapshot(t, a, token)["tasks"].([]any)[0].(map[string]any); task["state"] == "paused" || task["enabled"] != true {
		t.Fatal("task reported ineligible after sync", task)
	}
}

// Each configuration input, including provider enablement, revokes consent.
// Nickname/public URL edits and unchanged writes do not.
func TestServerConfigRevisionTriggers(t *testing.T) {
	_, s := testApp(t)
	id := seedServer(t, s)
	read := func() int64 {
		t.Helper()
		var value int64
		if err := s.reader.QueryRow("SELECT config_revision FROM media_servers WHERE id=?", id).Scan(&value); err != nil {
			t.Fatal(err)
		}
		return value
	}
	for _, tc := range []struct {
		query string
		bump  bool
	}{
		{"UPDATE media_servers SET revision=revision+1,last_sync_at='x' WHERE id=?", false},
		{"UPDATE media_servers SET server_nickname='renamed',public_url='https://public.invalid' WHERE id=?", false},
		{"UPDATE media_servers SET url=url WHERE id=?", false},
		{"UPDATE media_servers SET url='http://other.invalid' WHERE id=?", true},
		{"UPDATE media_servers SET api_key='rotated' WHERE id=?", true},
		{"UPDATE media_servers SET is_active=0 WHERE id=?", true},
		{"UPDATE provider_settings SET enabled=0 WHERE provider_id='jellyfin' AND ?>0", true},
		{"UPDATE provider_settings SET enabled=0 WHERE provider_id='jellyfin' AND ?>0", false},
	} {
		before := read()
		activityExec(t, s, tc.query, id)
		if changed := read() != before; changed != tc.bump {
			t.Fatal(tc.query, "changed", changed)
		}
	}
}
