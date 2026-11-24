package main

import (
	"context"
	"database/sql"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"
)

func TestServerRefreshJobsAreClaimedWithoutSignedInSession(t *testing.T) {
	a, s := testApp(t)
	token, _ := bootstrapOwner(t, a)
	id := createManagedServer(t, a, token, "jellyfin", "http://example.invalid")
	activityExec(t, s, "DELETE FROM app_sessions")
	if err := s.write(t.Context(), func(tx *sql.Tx) error { return prepareServerRefreshJobs(t.Context(), tx) }); err != nil {
		t.Fatal(err)
	}
	claim, err := a.claimServerRefreshJob(t.Context())
	if err != nil || claim == nil || claim.Server != id {
		t.Fatal(claim, err)
	}
	if err := s.write(context.Background(), func(tx *sql.Tx) error { return checkServerRefreshClaim(context.Background(), tx, claim) }); err != nil {
		t.Fatal(err)
	}
	other, err := a.claimServerRefreshJob(t.Context())
	if err != nil || other == nil || other.Server != id || other.Scope == claim.Scope {
		t.Fatal("independent scope not claimed", other, err)
	}
	activityExec(t, s, "UPDATE server_refresh_schedules SET revision=revision+1 WHERE server_id=? AND scope=?", id, claim.Scope)
	if err := s.write(t.Context(), func(tx *sql.Tx) error { return checkServerRefreshClaim(t.Context(), tx, claim) }); err == nil {
		t.Fatal("settings change did not fence stale claim")
	}
}

func TestServerRefreshStartupFlagDefersOverdueScope(t *testing.T) {
	a, s := testApp(t)
	token, _ := bootstrapOwner(t, a)
	id := createManagedServer(t, a, token, "jellyfin", "http://example.invalid")
	activityExec(t, s, "UPDATE server_refresh_schedules SET refresh_on_startup=0,next_run_at='2000-01-01T00:00:00Z' WHERE server_id=? AND scope='users'", id)
	if err := s.write(t.Context(), func(tx *sql.Tx) error { return prepareServerRefreshJobs(t.Context(), tx) }); err != nil {
		t.Fatal(err)
	}
	claim, err := a.claimServerRefreshJob(t.Context())
	if err != nil || claim == nil || claim.Scope != "libraries" {
		t.Fatal(claim, err)
	}
	claim, err = a.claimServerRefreshJob(t.Context())
	if err != nil || claim != nil {
		t.Fatal("deferred users claimed", claim, err)
	}
}

func TestServerRefreshUserJobRunsWithoutSignedInSession(t *testing.T) {
	a, s := testApp(t)
	token, _ := bootstrapOwner(t, a)
	upstream, _ := providerFixture(t, "jellyfin")
	id := createManagedServer(t, a, token, "jellyfin", upstream.URL)
	activityExec(t, s, "DELETE FROM app_sessions")
	activityExec(t, s, "UPDATE server_refresh_schedules SET next_run_at='2000-01-01T00:00:00Z' WHERE server_id=? AND scope='users'", id)
	if err := a.runOneServerRefresh(t.Context()); err != nil {
		t.Fatal(err)
	}
	var state string
	var count int
	if err := s.reader.QueryRow("SELECT run_state FROM server_refresh_schedules WHERE server_id=? AND scope='users'", id).Scan(&state); err != nil {
		t.Fatal(err)
	}
	if err := s.reader.QueryRow("SELECT count(*) FROM service_accounts WHERE server_id=?", id).Scan(&count); err != nil || state != "succeeded" || count == 0 {
		t.Fatal(state, count, err)
	}
}

func TestServerRefreshFailureDoesNotReportSuccess(t *testing.T) {
	a, s := testApp(t)
	token, _ := bootstrapOwner(t, a)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusServiceUnavailable) }))
	defer upstream.Close()
	id := createManagedServer(t, a, token, "jellyfin", upstream.URL)
	activityExec(t, s, "UPDATE server_refresh_schedules SET next_run_at='2000-01-01T00:00:00Z' WHERE server_id=? AND scope='users'", id)
	if err := a.runOneServerRefresh(t.Context()); err != nil {
		t.Fatal(err)
	}
	var state, code string
	if err := s.reader.QueryRow("SELECT run_state,last_code FROM server_refresh_schedules WHERE server_id=? AND scope='users'", id).Scan(&state, &code); err != nil || state != "failed" || code != "FAILED" {
		t.Fatal(state, code, err)
	}
}

func TestServerRefreshClaimFences(t *testing.T) {
	for _, mode := range []string{"configuration", "owner", "provider", "settings", "lease"} {
		t.Run(mode, func(t *testing.T) {
			a, s := testApp(t)
			token, _ := bootstrapOwner(t, a)
			id := createManagedServer(t, a, token, "jellyfin", "http://example.invalid")
			claim, err := a.claimServerRefreshJob(t.Context())
			if err != nil || claim == nil {
				t.Fatal(claim, err)
			}
			switch mode {
			case "configuration":
				activityExec(t, s, "UPDATE media_servers SET url='http://changed.invalid' WHERE id=?", id)
			case "owner":
				claim.Actor = newUUID()
			case "provider":
				activityExec(t, s, "UPDATE provider_settings SET enabled=0 WHERE provider_id='jellyfin'")
			case "settings":
				activityExec(t, s, "UPDATE server_refresh_schedules SET revision=revision+1 WHERE server_id=? AND scope=?", id, claim.Scope)
			case "lease":
				activityExec(t, s, "UPDATE server_refresh_schedules SET lease_until='2000-01-01T00:00:00Z' WHERE server_id=? AND scope=?", id, claim.Scope)
			}
			if err := s.write(t.Context(), func(tx *sql.Tx) error { return checkServerRefreshClaim(t.Context(), tx, claim) }); err == nil {
				t.Fatal("stale claim accepted", mode)
			}
		})
	}
}

func TestServerRefreshChangingLibraryIntervalDoesNotCancelUserJob(t *testing.T) {
	a, s := testApp(t)
	token, _ := bootstrapOwner(t, a)
	id := createManagedServer(t, a, token, "jellyfin", "http://example.invalid")
	claim, err := a.claimServerRefreshJobScope(t.Context(), "users")
	if err != nil || claim == nil {
		t.Fatal(claim, err)
	}
	path := fmt.Sprintf("/api/servers/%d/refresh-settings", id)
	current := responseData(t, apiRequest(a, "GET", path, token, nil, nil))
	body := map[string]any{"revision": current["revision"], "server_revision": current["server_revision"], "users_interval_hours": 1, "libraries_interval_hours": 2, "users_on_startup": true, "libraries_on_startup": true, "include_episodes_and_tracks": true}
	if w := apiRequest(a, "PUT", path, token, body, nil); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	if err := s.write(t.Context(), func(tx *sql.Tx) error { return checkServerRefreshClaim(t.Context(), tx, claim) }); err != nil {
		t.Fatal("unrelated change cancelled user job", err)
	}
}

func TestServerRefreshExpiredClaimIsInterruptedNotReplayed(t *testing.T) {
	a, s := testApp(t)
	token, _ := bootstrapOwner(t, a)
	id := createManagedServer(t, a, token, "jellyfin", "http://example.invalid")
	activityExec(t, s, "UPDATE server_refresh_schedules SET next_run_at='2099-01-01T00:00:00Z' WHERE server_id=? AND scope='users'", id)
	claim, err := a.claimServerRefreshJob(t.Context())
	if err != nil || claim == nil {
		t.Fatal(claim, err)
	}
	activityExec(t, s, "UPDATE server_refresh_schedules SET lease_until='2000-01-01T00:00:00Z' WHERE server_id=? AND scope=?", id, claim.Scope)
	other, err := a.claimServerRefreshJob(t.Context())
	if err != nil || other != nil {
		t.Fatal("expired claim replayed", other, err)
	}
	var state, code string
	if err := s.reader.QueryRow("SELECT run_state,last_code FROM server_refresh_schedules WHERE server_id=? AND scope=?", id, claim.Scope).Scan(&state, &code); err != nil || state != "interrupted" || code != "INTERRUPTED" {
		t.Fatal(state, code, err)
	}
}

func TestServerRefreshCancelsBlockedProviderOnShutdown(t *testing.T) {
	a, s := testApp(t)
	token, _ := bootstrapOwner(t, a)
	started := make(chan struct{})
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-started:
		default:
			close(started)
		}
		<-r.Context().Done()
	}))
	defer upstream.Close()
	id := createManagedServer(t, a, token, "jellyfin", upstream.URL)
	activityExec(t, s, "UPDATE server_refresh_schedules SET next_run_at=CASE WHEN scope='users' THEN '2000-01-01T00:00:00Z' ELSE '2099-01-01T00:00:00Z' END WHERE server_id=?", id)
	ctx, cancel := context.WithCancel(t.Context())
	done := make(chan error, 1)
	go func() { done <- a.runOneServerRefresh(ctx) }()
	select {
	case <-started:
	case <-time.After(3 * time.Second):
		t.Fatal("provider request did not start")
	}
	if !a.syncRun.TryLock() {
		t.Fatal("background refresh blocks activity monitoring")
	}
	a.syncRun.Unlock()
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("refresh did not stop")
	}
	var state string
	if err := s.reader.QueryRow("SELECT run_state FROM server_refresh_schedules WHERE server_id=? AND scope='users'", id).Scan(&state); err != nil || state != "cancelled" {
		t.Fatal(state, err)
	}
}

func TestServerRefreshLibraryJobRefreshesCatalogueWithoutSession(t *testing.T) {
	f := newCatalogueFixture(t, 1)
	var server int64
	if err := f.s.reader.QueryRow("SELECT server_id FROM media_libraries WHERE id=?", f.library).Scan(&server); err != nil {
		t.Fatal(err)
	}
	activityExec(t, f.s, "DELETE FROM app_sessions")
	activityExec(t, f.s, "UPDATE server_refresh_schedules SET next_run_at=CASE WHEN scope='libraries' THEN '2000-01-01T00:00:00Z' ELSE '2099-01-01T00:00:00Z' END WHERE server_id=?", server)
	if err := f.a.runOneServerRefresh(t.Context()); err != nil {
		t.Fatal(err)
	}
	var state string
	var items int
	if err := f.s.reader.QueryRow("SELECT run_state FROM server_refresh_schedules WHERE server_id=? AND scope='libraries'", server).Scan(&state); err != nil {
		t.Fatal(err)
	}
	if err := f.s.reader.QueryRow("SELECT count(*) FROM media_items WHERE library_id=?", f.library).Scan(&items); err != nil || state != "succeeded" || items != 1 {
		t.Fatal(state, items, err)
	}
}

func TestServerRefreshEpisodesOption(t *testing.T) {
	for _, include := range []bool{false, true} {
		t.Run(fmt.Sprint(include), func(t *testing.T) {
			f := newCatalogueFixture(t, 0)
			var server int64
			if err := f.s.reader.QueryRow("SELECT server_id FROM media_libraries WHERE id=?", f.library).Scan(&server); err != nil {
				t.Fatal(err)
			}
			activityExec(t, f.s, "UPDATE media_libraries SET library_type='tvshows' WHERE id=?", f.library)
			f.upstream.mu.Lock()
			f.upstream.libraryType = "tvshows"
			f.upstream.items = []map[string]any{{"Id": "series1", "Name": "Fixture show", "Type": "Series"}}
			f.upstream.episodes = map[string][]map[string]any{"series1": fixtureEpisodes("series1", 1, "episode")}
			f.upstream.mu.Unlock()
			activityExec(t, f.s, "UPDATE server_refresh_settings SET include_episodes_and_tracks=? WHERE server_id=?", include, server)
			activityExec(t, f.s, "DELETE FROM app_sessions")
			activityExec(t, f.s, "UPDATE server_refresh_schedules SET next_run_at=CASE WHEN scope='libraries' THEN '2000-01-01T00:00:00Z' ELSE '2099-01-01T00:00:00Z' END WHERE server_id=?", server)
			if err := f.a.runOneServerRefresh(t.Context()); err != nil {
				t.Fatal(err)
			}
			var state string
			var count int
			if err := f.s.reader.QueryRow("SELECT run_state FROM server_refresh_schedules WHERE server_id=? AND scope='libraries'", server).Scan(&state); err != nil {
				t.Fatal(err)
			}
			if err := f.s.reader.QueryRow("SELECT count(*) FROM media_items WHERE library_id=? AND parent_id='series1'", f.library).Scan(&count); err != nil {
				t.Fatal(err)
			}
			want := 0
			if include {
				want = 1
			}
			if state != "succeeded" || count != want {
				t.Fatal(state, count, want)
			}
		})
	}
}

func TestServerRefreshMusicTracksOption(t *testing.T) {
	for _, include := range []bool{false, true} {
		t.Run(fmt.Sprint(include), func(t *testing.T) {
			f := newCatalogueFixture(t, 0)
			var server int64
			if err := f.s.reader.QueryRow("SELECT server_id FROM media_libraries WHERE id=?", f.library).Scan(&server); err != nil {
				t.Fatal(err)
			}
			f.upstream.mu.Lock()
			f.upstream.libraryType = "music"
			f.upstream.items = []map[string]any{{"Id": "album1", "Name": "Record", "Type": "MusicAlbum"}}
			f.upstream.episodes = map[string][]map[string]any{"album1": {{"Id": "track1", "Name": "Song", "Type": "Audio", "AlbumId": "album1", "ParentIndexNumber": 1, "IndexNumber": 1}}}
			f.upstream.mu.Unlock()
			activityExec(t, f.s, "UPDATE server_refresh_settings SET include_episodes_and_tracks=? WHERE server_id=?", include, server)
			activityExec(t, f.s, "DELETE FROM app_sessions")
			activityExec(t, f.s, "UPDATE server_refresh_schedules SET next_run_at=CASE WHEN scope='libraries' THEN '2000-01-01T00:00:00Z' ELSE '2099-01-01T00:00:00Z' END WHERE server_id=?", server)
			if err := f.a.runOneServerRefresh(t.Context()); err != nil {
				t.Fatal(err)
			}
			var state string
			var count int
			if err := f.s.reader.QueryRow("SELECT run_state FROM server_refresh_schedules WHERE server_id=? AND scope='libraries'", server).Scan(&state); err != nil {
				t.Fatal(err)
			}
			if err := f.s.reader.QueryRow("SELECT count(*) FROM media_items WHERE library_id=? AND parent_id='album1' AND item_type='track'", f.library).Scan(&count); err != nil {
				t.Fatal(err)
			}
			want := 0
			if include {
				want = 1
			}
			if state != "succeeded" || count != want {
				t.Fatal(state, count, want)
			}
		})
	}
}

func TestServerRefreshFailedTracksPreservePreviousTracks(t *testing.T) {
	f := newCatalogueFixture(t, 0)
	var server int64
	if err := f.s.reader.QueryRow("SELECT server_id FROM media_libraries WHERE id=?", f.library).Scan(&server); err != nil {
		t.Fatal(err)
	}
	f.upstream.mu.Lock()
	f.upstream.libraryType = "music"
	f.upstream.items = []map[string]any{{"Id": "album1", "Name": "Record", "Type": "MusicAlbum"}}
	f.upstream.episodes = map[string][]map[string]any{"album1": {{"Id": "track1", "Name": "Song", "Type": "Audio", "AlbumId": "album1", "ParentIndexNumber": 1, "IndexNumber": 1}}}
	f.upstream.mu.Unlock()
	activityExec(t, f.s, "UPDATE server_refresh_schedules SET next_run_at=CASE WHEN scope='libraries' THEN '2000-01-01T00:00:00Z' ELSE '2099-01-01T00:00:00Z' END WHERE server_id=?", server)
	if err := f.a.runOneServerRefresh(t.Context()); err != nil {
		t.Fatal(err)
	}
	f.upstream.mu.Lock()
	f.upstream.episodes["album1"][0]["AlbumId"] = "other"
	f.upstream.mu.Unlock()
	activityExec(t, f.s, "UPDATE server_refresh_schedules SET next_run_at='2000-01-01T00:00:00Z' WHERE server_id=? AND scope='libraries'", server)
	if err := f.a.runOneServerRefresh(t.Context()); err != nil {
		t.Fatal(err)
	}
	var state string
	var count int
	if err := f.s.reader.QueryRow("SELECT run_state FROM server_refresh_schedules WHERE server_id=? AND scope='libraries'", server).Scan(&state); err != nil {
		t.Fatal(err)
	}
	if err := f.s.reader.QueryRow("SELECT count(*) FROM media_items WHERE library_id=? AND parent_id='album1' AND external_id='track1'", f.library).Scan(&count); err != nil || state != "failed" || count != 1 {
		t.Fatal(state, count, err)
	}
}

func TestServerRefreshEpisodeFailurePreservesPreviousEpisodes(t *testing.T) {
	f := newCatalogueFixture(t, 0)
	var server int64
	if err := f.s.reader.QueryRow("SELECT server_id FROM media_libraries WHERE id=?", f.library).Scan(&server); err != nil {
		t.Fatal(err)
	}
	f.upstream.mu.Lock()
	f.upstream.libraryType = "tvshows"
	f.upstream.items = []map[string]any{{"Id": "series1", "Name": "Fixture show", "Type": "Series"}}
	f.upstream.episodes = map[string][]map[string]any{"series1": fixtureEpisodes("series1", 1, "episode")}
	f.upstream.mu.Unlock()
	activityExec(t, f.s, "UPDATE server_refresh_schedules SET next_run_at=CASE WHEN scope='libraries' THEN '2000-01-01T00:00:00Z' ELSE '2099-01-01T00:00:00Z' END WHERE server_id=?", server)
	if err := f.a.runOneServerRefresh(t.Context()); err != nil {
		t.Fatal(err)
	}
	f.upstream.mu.Lock()
	f.upstream.episodes["series1"] = []map[string]any{{"Id": "broken", "Name": "Broken", "Type": "Episode", "SeriesId": "other"}}
	f.upstream.mu.Unlock()
	activityExec(t, f.s, "UPDATE server_refresh_schedules SET next_run_at='2000-01-01T00:00:00Z' WHERE server_id=? AND scope='libraries'", server)
	if err := f.a.runOneServerRefresh(t.Context()); err != nil {
		t.Fatal(err)
	}
	var state string
	var count int
	if err := f.s.reader.QueryRow("SELECT run_state FROM server_refresh_schedules WHERE server_id=? AND scope='libraries'", server).Scan(&state); err != nil {
		t.Fatal(err)
	}
	if err := f.s.reader.QueryRow("SELECT count(*) FROM media_items WHERE library_id=? AND parent_id='series1' AND external_id='episode000'", f.library).Scan(&count); err != nil || state != "failed" || count != 1 {
		t.Fatal(state, count, err)
	}
}

func TestServerRefreshSchedulerRunsAtStartupWithoutSessions(t *testing.T) {
	f := newCatalogueFixture(t, 1)
	var server int64
	if err := f.s.reader.QueryRow("SELECT server_id FROM media_libraries WHERE id=?", f.library).Scan(&server); err != nil {
		t.Fatal(err)
	}
	activityExec(t, f.s, "DELETE FROM app_sessions")
	if err := f.a.StartScheduler(); err != nil {
		t.Fatal(err)
	}
	waitProviderSocket(t, func() bool {
		var count int
		_ = f.s.reader.QueryRow("SELECT count(*) FROM server_refresh_schedules WHERE server_id=? AND run_state='succeeded'", server).Scan(&count)
		return count == 2
	})
	f.a.StopScheduler()
	if err := f.a.WaitScheduler(t.Context()); err != nil {
		t.Fatal(err)
	}
}

func TestServerRefreshUsersRunDuringLongCatalogue(t *testing.T) {
	f := newCatalogueFixture(t, 1)
	var server int64
	if err := f.s.reader.QueryRow("SELECT server_id FROM media_libraries WHERE id=?", f.library).Scan(&server); err != nil {
		t.Fatal(err)
	}
	started, release := make(chan struct{}), make(chan struct{})
	var releaseOnce sync.Once
	defer releaseOnce.Do(func() { close(release) })
	f.upstream.mu.Lock()
	f.upstream.onPage = func(int) {
		select {
		case <-started:
		default:
			close(started)
		}
		<-release
	}
	f.upstream.mu.Unlock()
	activityExec(t, f.s, "UPDATE server_refresh_schedules SET next_run_at='2000-01-01T00:00:00Z' WHERE server_id=?", server)
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- f.a.runOneServerRefreshScope(ctx, "libraries") }()
	select {
	case <-started:
	case <-time.After(3 * time.Second):
		t.Fatal("catalogue did not start")
	}
	if err := f.a.runOneServerRefreshScope(t.Context(), "users"); err != nil {
		t.Fatal(err)
	}
	var state string
	if err := f.s.reader.QueryRow("SELECT run_state FROM server_refresh_schedules WHERE server_id=? AND scope='users'", server).Scan(&state); err != nil || state != "succeeded" {
		t.Fatal(state, err)
	}
	cancel()
	releaseOnce.Do(func() { close(release) })
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("catalogue did not cancel")
	}
}

func TestServerRefreshSettingsDefaultAndIndependentSchedules(t *testing.T) {
	a, s := testApp(t)
	token, _ := bootstrapOwner(t, a)
	server := createManagedServer(t, a, token, "jellyfin", "http://example.invalid")
	var episodes, startup, interval int
	if err := s.reader.QueryRow("SELECT include_episodes_and_tracks FROM server_refresh_settings WHERE server_id=?", server).Scan(&episodes); err != nil || episodes != 1 {
		t.Fatalf("episodes: %d, %v", episodes, err)
	}
	for _, kind := range []string{"users", "libraries"} {
		if err := s.reader.QueryRow("SELECT refresh_on_startup,interval_seconds FROM server_refresh_schedules WHERE server_id=? AND scope=?", server, kind).Scan(&startup, &interval); err != nil || startup != 1 || interval != 3600 {
			t.Fatalf("%s: %d %d %v", kind, startup, interval, err)
		}
	}
	var scheduled int
	if err := s.reader.QueryRow("SELECT count(*) FROM server_refresh_schedules WHERE server_id=? AND next_run_at IS NOT NULL", server).Scan(&scheduled); err != nil || scheduled != 2 {
		t.Fatal("new server schedules", scheduled, err)
	}
}

func TestServerRefreshScheduledTaskStatusHasDistinctScopes(t *testing.T) {
	a, _ := testApp(t)
	token, _ := bootstrapOwner(t, a)
	createManagedServer(t, a, token, "jellyfin", "http://example.invalid")
	value := taskSnapshot(t, a, token)
	rows := value["tasks"].([]any)
	if len(rows) != 2 {
		t.Fatal(rows)
	}
	seen := map[string]bool{}
	for _, row := range rows {
		task := row.(map[string]any)
		seen[task["scope"].(string)] = true
		if task["provider"] != "jellyfin" || task["enabled"] != true {
			t.Fatal(task)
		}
	}
	if !seen["users"] || !seen["libraries"] {
		t.Fatal(seen)
	}
}

func TestServerRefreshSettingsRejectStaleAndSaveIndependentPreferences(t *testing.T) {
	a, _ := testApp(t)
	token, _ := bootstrapOwner(t, a)
	server := createManagedServer(t, a, token, "jellyfin", "http://example.invalid")
	path := fmt.Sprintf("/api/servers/%d/refresh-settings", server)
	read := apiRequest(a, "GET", path, token, nil, nil)
	if read.Code != 200 {
		t.Fatal(read.Code, read.Body.String())
	}
	current := responseData(t, read)
	body := map[string]any{"revision": current["revision"], "server_revision": current["server_revision"], "users_interval_hours": 2, "libraries_interval_hours": 6, "users_on_startup": false, "libraries_on_startup": true, "include_episodes_and_tracks": true}
	write := apiRequest(a, "PUT", path, token, body, nil)
	if write.Code != 200 {
		t.Fatal(write.Code, write.Body.String())
	}
	stale := apiRequest(a, "PUT", path, token, body, nil)
	if stale.Code != 409 {
		t.Fatal("stale settings must fail", stale.Code, stale.Body.String())
	}
	updated := responseData(t, apiRequest(a, "GET", path, token, nil, nil))
	if updated["users_interval_hours"] != float64(2) || updated["libraries_interval_hours"] != float64(6) || updated["users_on_startup"] != false || updated["libraries_on_startup"] != true {
		t.Fatal(updated)
	}
}

func TestServerRefreshSettingsRequireAuthorityAndCompleteInput(t *testing.T) {
	a, s, owner, delegate, user := roleReadFixture(t)
	id := seedServer(t, s)
	path := fmt.Sprintf("/api/servers/%d/refresh-settings", id)
	if _, err := s.writer.Exec("DELETE FROM admin_role_permissions WHERE role_id='high'"); err != nil {
		t.Fatal(err)
	}
	if w := apiRequest(a, "GET", path, delegate, nil, nil); w.Code == 200 {
		t.Fatal("delegate read", w.Body.String())
	}
	read := apiRequest(a, "GET", path, owner, nil, nil)
	if read.Code != 200 {
		t.Fatal(read.Code, read.Body.String())
	}
	data := responseData(t, read)
	body := map[string]any{"revision": data["revision"], "server_revision": data["server_revision"], "users_interval_hours": 1, "libraries_interval_hours": 1, "users_on_startup": true, "libraries_on_startup": true, "include_episodes_and_tracks": true}
	if w := apiRequest(a, "PUT", path, delegate, body, nil); w.Code == 200 {
		t.Fatal("delegate write", user)
	}
	delete(body, "server_revision")
	if w := apiRequest(a, "PUT", path, owner, body, nil); w.Code != 400 {
		t.Fatal("missing revision", w.Code, w.Body.String())
	}
	body["server_revision"] = data["server_revision"]
	body["users_interval_hours"] = 0
	if w := apiRequest(a, "PUT", path, owner, body, nil); w.Code != 400 {
		t.Fatal("invalid interval", w.Code, w.Body.String())
	}
}

func TestServerRefreshSettingsUseConfigurationRevision(t *testing.T) {
	a, s := testApp(t)
	token, _ := bootstrapOwner(t, a)
	id := createManagedServer(t, a, token, "jellyfin", "http://example.invalid")
	path := fmt.Sprintf("/api/servers/%d/refresh-settings", id)
	get := func() map[string]any { return responseData(t, apiRequest(a, "GET", path, token, nil, nil)) }
	values := get()
	body := map[string]any{"revision": values["revision"], "server_revision": values["server_revision"], "users_interval_hours": 2, "libraries_interval_hours": 1, "users_on_startup": true, "libraries_on_startup": true, "include_episodes_and_tracks": true}
	activityExec(t, s, "UPDATE media_servers SET revision=revision+1 WHERE id=?", id)
	if w := apiRequest(a, "PUT", path, token, body, nil); w.Code != 200 {
		t.Fatal("ordinary sync invalidated settings", w.Code, w.Body.String())
	}
	values = get()
	body["revision"] = values["revision"]
	body["server_revision"] = values["server_revision"]
	activityExec(t, s, "UPDATE media_servers SET url='http://changed.invalid' WHERE id=?", id)
	if w := apiRequest(a, "PUT", path, token, body, nil); w.Code != 409 {
		t.Fatal("changed configuration accepted", w.Code, w.Body.String())
	}
}
