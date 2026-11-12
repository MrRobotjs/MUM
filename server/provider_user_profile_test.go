package main

import (
	"app/server/providers/plex"
	"database/sql"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"
)

// Only the disposable fixture transport is used; no Plex request reaches the network.
func TestPlexUserProfileSnapshotSync(t *testing.T) {
	upstream, client, _ := extendedProviderFixture(t, "plex")
	base := client.Transport
	thumb, accepted := "https://plex.tv/users/fixture-user/avatar?c=123&X-Plex-Token=never-persist", "1700000000"
	client.Transport = providerTransport(func(r *http.Request) (*http.Response, error) {
		response, err := base.RoundTrip(r)
		if err != nil {
			return response, err
		}
		if r.URL.Path != "/api/users/" && !strings.HasSuffix(r.URL.Path, "/shared_servers") {
			return response, nil
		}
		body, err := io.ReadAll(response.Body)
		response.Body.Close()
		if err != nil {
			return nil, err
		}
		value := strings.Replace(string(body), `username="Reader"`, `username="Reader" thumb="`+strings.ReplaceAll(thumb, "&", "&amp;")+`"`, 1)
		value = strings.Replace(value, `userID="2"`, `userID="2" acceptedAt="`+accepted+`"`, 1)
		response.Body = io.NopCloser(strings.NewReader(value))
		response.ContentLength = int64(len(value))
		return response, nil
	})
	a, store := testApp(t)
	a.ProviderHTTP = client
	token, _ := bootstrapOwner(t, a)
	id := createManagedServer(t, a, token, "plex", upstream.URL+"/proxy")
	path := fmt.Sprintf("/api/servers/%d/sync", id)
	for _, state := range []struct{ thumb, accepted, avatar, joined string }{
		{thumb, accepted, "https://plex.tv/users/fixture-user/avatar?c=123", "2023-11-14T22:13:20Z"},
		{"https://untrusted.invalid/avatar?token=never-persist", "999999999999999999999", "https://plex.tv/users/fixture-user/avatar?c=123", "2023-11-14T22:13:20Z"},
		{"", "", "https://plex.tv/users/fixture-user/avatar?c=123", "2023-11-14T22:13:20Z"},
		{"/accounts/42/thumb", "1700000001", "/accounts/42/thumb", "2023-11-14T22:13:21Z"},
	} {
		thumb, accepted = state.thumb, state.accepted
		if w := apiRequest(a, "POST", path, token, nil, nil); w.Code != 200 {
			t.Fatal(w.Code, w.Body.String())
		}
		var avatar, joined, settings, libraries string
		if err := store.reader.QueryRow(`SELECT coalesce(external_avatar_url,''),coalesce(service_join_date,''),service_settings,allowed_library_ids FROM service_accounts WHERE server_id=? AND external_user_id='2'`, id).Scan(&avatar, &joined, &settings, &libraries); err != nil {
			t.Fatal(err)
		}
		if avatar != state.avatar || joined != state.joined {
			t.Fatalf("profile = %q %q; want %q %q", avatar, joined, state.avatar, state.joined)
		}
		if libraries != `["shelf"]` || strings.Contains(settings, "never-persist") {
			t.Fatalf("sharing data changed or secret retained: %s %s", libraries, settings)
		}
		var roles int
		if err := store.reader.QueryRow(`SELECT count(*) FROM identity_user_roles`).Scan(&roles); err != nil || roles != 0 {
			t.Fatalf("profile sync changed role grants: %d %v", roles, err)
		}
	}
}

func TestNonProfileProviderSyncPreservesStoredPresentation(t *testing.T) {
	upstream, client, _ := extendedProviderFixture(t, "komga")
	a, store := testApp(t)
	a.ProviderHTTP = client
	token, _ := bootstrapOwner(t, a)
	id := createManagedServer(t, a, token, "komga", upstream.URL+"/proxy")
	path := fmt.Sprintf("/api/servers/%d/sync", id)
	if w := apiRequest(a, "POST", path, token, nil, nil); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	if err := store.write(t.Context(), func(tx *sql.Tx) error {
		_, err := tx.ExecContext(t.Context(), `UPDATE service_accounts SET external_avatar_url='stored-avatar',service_join_date='2020-01-01T00:00:00Z' WHERE server_id=?`, id)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	if w := apiRequest(a, "POST", path, token, nil, nil); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	var avatar, joined string
	if err := store.reader.QueryRow(`SELECT external_avatar_url,service_join_date FROM service_accounts WHERE server_id=?`, id).Scan(&avatar, &joined); err != nil {
		t.Fatal(err)
	}
	if avatar != "stored-avatar" || joined != "2020-01-01T00:00:00Z" {
		t.Fatalf("non-reporting provider erased metadata: %q %q", avatar, joined)
	}
}

func TestPlexShareJoinDateUsesOnlyAcceptedUnixSeconds(t *testing.T) {
	for _, value := range []string{"", "0", "-1", "+1700000000", "1700000000.0", "2023-11-14T22:13:20Z", "253402300800", "999999999999999999999", " 1700000000"} {
		if got := plex.ShareJoinDate(value); got != "" {
			t.Fatalf("invalid acceptedAt %q yielded %q", value, got)
		}
	}
	if got := plex.ShareJoinDate("1700000000"); got != "2023-11-14T22:13:20Z" {
		t.Fatal(got)
	}
}

func TestPlexActivityBackfillsAvatarOnlyAfterValidIdentityClaim(t *testing.T) {
	a, store := testApp(t)
	token, _ := bootstrapOwner(t, a)
	owner, err := store.Authenticate(t.Context(), token)
	if err != nil {
		t.Fatal(err)
	}
	server := createManagedServer(t, a, token, "plex", "http://127.0.0.1:1")
	begin := func() activityReadClaim {
		claim, err := store.beginActivityRead(t.Context(), owner.UUID, token, server)
		if err != nil {
			t.Fatal(err)
		}
		return claim
	}
	apply := func(claim activityReadClaim, invalid bool) error {
		snapshot, err := parseActivitySnapshot("plex", []byte(strings.Replace(plexPlaying, `title="Viewer"`, `title="Viewer" thumb="https://plex.tv/users/fixture-user/avatar?X-Plex-Token=never-persist"`, 1)))
		if err != nil {
			t.Fatal(err)
		}
		if invalid {
			snapshot.Sessions = append(snapshot.Sessions, snapshot.Sessions[0])
		}
		return store.write(t.Context(), func(tx *sql.Tx) error {
			_, err := commitActivitySnapshot(t.Context(), tx, claim, snapshot)
			return err
		})
	}
	stale := begin()
	current := begin()
	if err := apply(stale, false); !errors.Is(err, ErrConflict) {
		t.Fatalf("stale claim accepted: %v", err)
	}
	if err := apply(current, true); err == nil {
		t.Fatal("invalid snapshot accepted")
	}
	var count int
	if err := store.reader.QueryRow(`SELECT count(*) FROM service_accounts WHERE server_id=?`, server).Scan(&count); err != nil || count != 0 {
		t.Fatalf("rejected snapshot retained identity/profile: %d %v", count, err)
	}
	if err := apply(current, false); err != nil {
		t.Fatal(err)
	}
	var avatar string
	var joined sql.NullString
	if err := store.reader.QueryRow(`SELECT coalesce(external_avatar_url,''),service_join_date FROM service_accounts WHERE server_id=? AND external_user_id='42'`, server).Scan(&avatar, &joined); err != nil {
		t.Fatal(err)
	}
	if avatar != "https://plex.tv/users/fixture-user/avatar" || joined.Valid {
		t.Fatalf("incorrect PMS presentation backfill: %q %v", avatar, joined)
	}
	activityExec(t, store, `UPDATE service_accounts SET external_avatar_url='https://plex.tv/users/cloud-user/avatar' WHERE server_id=?`, server)
	if err := apply(begin(), false); err != nil {
		t.Fatal(err)
	}
	if err := store.reader.QueryRow(`SELECT external_avatar_url FROM service_accounts WHERE server_id=? AND external_user_id='42'`, server).Scan(&avatar); err != nil {
		t.Fatal(err)
	}
	if avatar != "https://plex.tv/users/cloud-user/avatar" {
		t.Fatalf("PMS overwrote cloud profile: %q", avatar)
	}
	for _, table := range []string{"service_links", "identity_user_roles"} {
		if err := store.reader.QueryRow(`SELECT count(*) FROM ` + table).Scan(&count); err != nil || count != 0 {
			t.Fatalf("PMS profile inferred grants/ownership: %s %d %v", table, count, err)
		}
	}
}
