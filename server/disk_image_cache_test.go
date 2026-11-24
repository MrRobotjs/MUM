package main

import (
	"bytes"
	"errors"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestDiskImageCachePersistsAndEnforcesLimits(t *testing.T) {
	dir := t.TempDir()
	policy := diskCachePolicy{mode: "shared", sharedBytes: 1000, serverBytes: map[int64]int64{1: 700, 2: 700}}
	c, err := openDiskImageCache(dir)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	a := imageCacheKey{server: 1, revision: 1, purpose: "poster", external: "a"}
	b := imageCacheKey{server: 2, revision: 1, purpose: "poster", external: "b"}
	if err := c.put(a, "plex", "Plex++", "image/png", bytes.Repeat([]byte("a"), 200), now, policy, c.generation(a.server)); err != nil {
		t.Fatal(err)
	}
	c, err = openDiskImageCache(dir)
	if err != nil {
		t.Fatal(err)
	}
	if _, body, ok := c.get(a, now); !ok || len(body) != 200 {
		t.Fatal("cache did not survive restart")
	}
	if err := c.put(b, "jellyfin", "Jelly++", "image/png", bytes.Repeat([]byte("b"), 750), now.Add(time.Second), policy, c.generation(b.server)); err != nil {
		t.Fatal(err)
	}
	if _, _, ok := c.get(a, now.Add(2*time.Second)); ok {
		t.Fatal("shared limit did not evict least recently used image")
	}
	policy.mode = "per_server"
	if err := c.put(a, "plex", "Plex++", "image/png", bytes.Repeat([]byte("a"), 200), now.Add(3*time.Second), policy, c.generation(a.server)); err != nil {
		t.Fatal(err)
	}
	if _, _, ok := c.get(b, now.Add(4*time.Second)); ok {
		t.Fatal("per-server limit did not evict oversized server image")
	}
	if err := c.clear(1); err != nil {
		t.Fatal(err)
	}
	c, err = openDiskImageCache(dir)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, ok := c.get(a, now.Add(5*time.Second)); ok {
		t.Fatal("clear did not persist")
	}
}

func TestDiskImageCacheServesStaleImageWhenProviderUnavailable(t *testing.T) {
	f := newCatalogueFixture(t, 1)
	if w := apiRequest(f.a, http.MethodPost, f.path("/sync"), f.token, map[string]any{"expected_catalogue_revision": 1}, nil); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	thumb := f.list(t, "page=1&page_size=24").Data[0].Thumb
	if w := apiRequest(f.a, http.MethodGet, thumb, "", nil, nil); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	var server int64
	if err := f.s.reader.QueryRow(`SELECT server_id FROM media_libraries WHERE id=?`, f.library).Scan(&server); err != nil {
		t.Fatal(err)
	}
	f.a.imageCache.clear(server)
	f.a.imageCache.ttl = time.Nanosecond
	f.a.ProviderHTTP = &http.Client{Transport: providerTransport(func(*http.Request) (*http.Response, error) { return nil, errors.New("provider offline") })}
	if w := apiRequest(f.a, http.MethodGet, thumb, "", nil, nil); w.Code != 200 {
		t.Fatal("stale poster unavailable", w.Code, w.Body.String())
	}
	activityExec(t, f.s, `UPDATE media_servers SET cache_images=0 WHERE id=?`, server)
	if w := apiRequest(f.a, http.MethodGet, thumb, "", nil, nil); w.Code == 200 {
		t.Fatal("disabled cache served a poster")
	}
}

func TestDiskImageCacheRenameAndInFlightClear(t *testing.T) {
	dir := t.TempDir()
	c, err := openDiskImageCache(dir)
	if err != nil {
		t.Fatal(err)
	}
	key := imageCacheKey{server: 7, revision: 1, purpose: "media-poster", external: "image"}
	policy := diskCachePolicy{mode: "shared", sharedBytes: 1 << 20, serverBytes: map[int64]int64{}}
	now := time.Now()
	version := c.generation(7)
	if err := c.put(key, "plex", "Old Name", "image/png", []byte("image"), now, policy, version); err != nil {
		t.Fatal(err)
	}
	if err := c.renameServer(7, "plex", "New Name"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dir, diskCacheDir, "Plex", "New-Name--7", cacheFileName(key))); err != nil {
		t.Fatal("renamed cache missing", err)
	}
	if _, body, ok := c.get(key, now); !ok || string(body) != "image" {
		t.Fatal("rename lost image")
	}
	version = c.generation(7)
	if err := c.clear(7); err != nil {
		t.Fatal(err)
	}
	if err := c.put(key, "plex", "New Name", "image/png", []byte("stale"), now, policy, version); err != nil {
		t.Fatal(err)
	}
	if _, _, ok := c.get(key, now); ok {
		t.Fatal("cleared cache repopulated by in-flight request")
	}
}

func TestDiskImageCacheServesAuthorizedPosterAfterRestart(t *testing.T) {
	f := newCatalogueFixture(t, 1)
	if w := apiRequest(f.a, http.MethodPost, f.path("/sync"), f.token, map[string]any{"expected_catalogue_revision": 1}, nil); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	thumb := f.list(t, "page=1&page_size=24").Data[0].Thumb
	if w := apiRequest(f.a, http.MethodGet, thumb, "", nil, nil); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	var server int64
	if err := f.s.reader.QueryRow(`SELECT server_id FROM media_libraries WHERE id=?`, f.library).Scan(&server); err != nil {
		t.Fatal(err)
	}
	f.a.imageCache.clear(server)
	var err error
	f.a.diskImages, err = openDiskImageCache(f.s.dataDir)
	if err != nil {
		t.Fatal(err)
	}
	hits := f.upstream.imageHit
	if w := apiRequest(f.a, http.MethodGet, thumb, "", nil, nil); w.Code != 200 || f.upstream.imageHit != hits {
		t.Fatal("disk cache missed", w.Code, f.upstream.imageHit, hits)
	}
	activityExec(t, f.s, `DELETE FROM app_sessions`)
	if w := apiRequest(f.a, http.MethodGet, thumb, "", nil, nil); w.Code != 403 {
		t.Fatal("revoked session read cached poster", w.Code)
	}
}

func TestDiskImageCacheFindsHistoryPosterByMediaIdentity(t *testing.T) {
	c, err := openDiskImageCache(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	key := imageCacheKey{server: 1, revision: 1, purpose: "media-poster", external: "tagged"}
	policy := diskCachePolicy{mode: "shared", sharedBytes: 1 << 20, serverBytes: map[int64]int64{}}
	if err := c.putMedia(key, "plex", "Plex++", "image/png", []byte("poster"), now, policy, c.generation(1), "media-identity"); err != nil {
		t.Fatal(err)
	}
	if _, body, _, ok := c.getMedia(1, 1, "media-identity", now); !ok || string(body) != "poster" {
		t.Fatal("historical image did not reuse catalogue image")
	}
	if _, _, _, ok := c.getMedia(2, 1, "media-identity", now); ok {
		t.Fatal("image escaped server identity")
	}
}

func TestRetainedHistoryUsesCachedCataloguePosterWithoutImageReference(t *testing.T) {
	f := newCatalogueFixture(t, 1)
	if w := apiRequest(f.a, http.MethodPost, f.path("/sync"), f.token, map[string]any{"expected_catalogue_revision": 1}, nil); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	thumb := f.list(t, "page=1&page_size=24").Data[0].Thumb
	if w := apiRequest(f.a, http.MethodGet, thumb, "", nil, nil); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	var server int64
	if err := f.s.reader.QueryRow(`SELECT server_id FROM media_libraries WHERE id=?`, f.library).Scan(&server); err != nil {
		t.Fatal(err)
	}
	service := seedService(t, f.s, server)
	now := utcTimestamp(time.Now())
	activityExec(t, f.s, `INSERT INTO media_activity_history(server_id,external_session_id,service_uuid,item_id,media_type,title,first_seen_at,last_seen_at,paused,library_name) VALUES(?,'session',?,'a0000','movie','Movie',?,?,0,'Movies')`, server, service, now, now)
	var row int64
	if err := f.s.reader.QueryRow(`SELECT max(id) FROM media_activity_history`).Scan(&row); err != nil {
		t.Fatal(err)
	}
	activityExec(t, f.s, `DELETE FROM media_items WHERE library_id=?`, f.library)
	f.a.imageCache.clear(server)
	var err error
	f.a.diskImages, err = openDiskImageCache(f.s.dataDir)
	if err != nil {
		t.Fatal(err)
	}
	stats := apiRequest(f.a, http.MethodGet, "/api/activity/statistics?days=7", f.token, nil, nil)
	if stats.Code != 200 {
		t.Fatal(stats.Code, stats.Body.String())
	}
	var found bool
	var dashboardPoster string
	for _, section := range responseData(t, stats)["sections"].([]any) {
		group := section.(map[string]any)
		if group["kind"] != "movies" {
			continue
		}
		for _, entry := range group["items"].([]any) {
			item := entry.(map[string]any)
			if item["title"] == "Movie" {
				found = true
				if item["not_in_library"] != true || item["poster_url"] == nil {
					t.Fatalf("missing indicator or cached poster: %v", item)
				}
				dashboardPoster = item["poster_url"].(string)
			}
		}
	}
	if !found {
		t.Fatal("historical movie absent from activity")
	}
	if w := apiRequest(f.a, http.MethodGet, dashboardPoster, "", nil, nil); w.Code != 200 {
		t.Fatal("dashboard cached poster unavailable", w.Code, w.Body.String())
	}
	parsed, _ := url.Parse(thumb)
	session := parsed.Query().Get("s")
	link := f.a.signedImageURL(activityHistoryPosterPurpose, "/api/activity/history-images", session, row, time.Now())
	hits := f.upstream.imageHit
	if w := apiRequest(f.a, http.MethodGet, link, "", nil, nil); w.Code != 200 || f.upstream.imageHit != hits {
		t.Fatal("retained cached poster unavailable", w.Code, w.Body.String())
	}
	activityExec(t, f.s, `INSERT INTO media_activity_history(server_id,external_session_id,service_uuid,item_id,parent_item_id,media_type,title,first_seen_at,last_seen_at,paused,poster_item) VALUES(?,'episode',?,'episode-id','a0000','episode','Episode',?,?,0,'episode-id')`, server, service, now, now)
	var episode int64
	if err := f.s.reader.QueryRow(`SELECT max(id) FROM media_activity_history`).Scan(&episode); err != nil {
		t.Fatal(err)
	}
	episodeLink := f.a.signedImageURL(activityHistoryPosterPurpose, "/api/activity/history-images", session, episode, time.Now())
	if w := apiRequest(f.a, http.MethodGet, episodeLink, "", nil, nil); w.Code != 200 {
		t.Fatal("parent cached poster unavailable", w.Code, w.Body.String())
	}
	activityExec(t, f.s, `DELETE FROM app_sessions`)
	if w := apiRequest(f.a, http.MethodGet, link, "", nil, nil); w.Code != 403 {
		t.Fatal("revoked session read retained poster", w.Code)
	}
}
