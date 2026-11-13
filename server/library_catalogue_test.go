package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"testing"
)

// catalogueUpstream is a disposable Jellyfin fixture with one movie library.
type catalogueUpstream struct {
	mu       sync.Mutex
	items    []map[string]any
	episodes map[string][]map[string]any // series ID -> episodes
	onPage   func(start int)             // called before serving a page
	pages    int
	imageHit int
}

func (u *catalogueUpstream) setItems(n int, prefix string) {
	u.mu.Lock()
	defer u.mu.Unlock()
	u.items = nil
	for i := 0; i < n; i++ {
		item := map[string]any{"Id": fmt.Sprintf("%s%04d", prefix, i), "Name": fmt.Sprintf("Movie %04d", i), "SortName": fmt.Sprintf("movie %04d", i), "Type": "Movie", "ProductionYear": 1990 + i%30, "CommunityRating": 7.5, "RunTimeTicks": 72000000000, "Overview": "A disposable fixture film.", "DateCreated": "2026-01-02T03:04:05.0000000Z"}
		if i%2 == 0 {
			item["ImageTags"] = map[string]string{"Primary": fmt.Sprintf("tag%04d", i)}
		}
		u.items = append(u.items, item)
	}
}

func newCatalogueUpstream(t *testing.T) (*catalogueUpstream, *httptest.Server) {
	u := &catalogueUpstream{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-Emby-Token") != "fixture-secret" {
			w.WriteHeader(401)
			return
		}
		switch {
		case r.URL.Path == "/System/Info":
			_ = json.NewEncoder(w).Encode(map[string]string{"ServerName": "Catalogue fixture", "Version": "10.10"})
		case r.URL.Path == "/Library/VirtualFolders":
			_ = json.NewEncoder(w).Encode([]map[string]string{{"ItemId": "movies", "Name": "Movies", "CollectionType": "movies"}})
		case r.URL.Path == "/Users":
			_ = json.NewEncoder(w).Encode([]any{})
		case r.URL.Path == "/Items":
			parent := r.URL.Query().Get("ParentId")
			if r.URL.Query().Get("Recursive") != "true" {
				w.WriteHeader(400)
				return
			}
			start, _ := strconv.Atoi(r.URL.Query().Get("StartIndex"))
			limit, _ := strconv.Atoi(r.URL.Query().Get("Limit"))
			u.mu.Lock()
			hook := u.onPage
			u.pages++
			u.mu.Unlock()
			if hook != nil {
				hook(start)
			}
			u.mu.Lock()
			source := u.items
			if parent != "movies" {
				var ok bool
				if source, ok = u.episodes[parent]; !ok || r.URL.Query().Get("IncludeItemTypes") != "Episode" && r.URL.Query().Get("IncludeItemTypes") != "Audio" {
					u.mu.Unlock()
					w.WriteHeader(400)
					return
				}
			}
			end := min(start+limit, len(source))
			page := []map[string]any{}
			if start < end {
				page = source[start:end]
			}
			body := map[string]any{"Items": page, "TotalRecordCount": len(source), "StartIndex": start}
			u.mu.Unlock()
			_ = json.NewEncoder(w).Encode(body)
		case strings.HasPrefix(r.URL.Path, "/Items/") && strings.HasSuffix(r.URL.Path, "/Images/Primary"):
			u.mu.Lock()
			u.imageHit++
			u.mu.Unlock()
			w.Header().Set("Content-Type", "image/png")
			_, _ = w.Write([]byte("\x89PNG fixture"))
		default:
			w.WriteHeader(404)
		}
	}))
	t.Cleanup(server.Close)
	return u, server
}

type catalogueFixture struct {
	a        *App
	s        *Store
	token    string
	library  int64
	upstream *catalogueUpstream
}

func newCatalogueFixture(t *testing.T, items int) catalogueFixture {
	t.Helper()
	upstream, server := newCatalogueUpstream(t)
	upstream.setItems(items, "a")
	a, s := testApp(t)
	token, _ := bootstrapOwner(t, a)
	id := createManagedServer(t, a, token, "jellyfin", server.URL)
	if w := apiRequest(a, "POST", fmt.Sprintf("/api/servers/%d/sync-libraries", id), token, nil, nil); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	var library int64
	if err := s.reader.QueryRow("SELECT id FROM media_libraries WHERE server_id=?", id).Scan(&library); err != nil {
		t.Fatal(err)
	}
	return catalogueFixture{a, s, token, library, upstream}
}

func (f catalogueFixture) path(suffix string) string {
	return fmt.Sprintf("/api/libraries/%d%s", f.library, suffix)
}

func (f catalogueFixture) itemCount(t *testing.T) int {
	t.Helper()
	var n int
	if err := f.s.reader.QueryRow("SELECT count(*) FROM media_items WHERE library_id=?", f.library).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

type catalogueList struct {
	Data []catalogueItemRow `json:"data"`
	Meta struct {
		Revision   int64 `json:"catalogue_revision"`
		Pagination struct {
			Total int `json:"total_items"`
			Pages int `json:"total_pages"`
		} `json:"pagination"`
	} `json:"meta"`
}

func (f catalogueFixture) list(t *testing.T, query string) catalogueList {
	t.Helper()
	w := apiRequest(f.a, "GET", f.path("/media?"+query), f.token, nil, nil)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	var out catalogueList
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	return out
}

func TestLibraryCatalogueSyncListDetailImagesAndPurge(t *testing.T) {
	f := newCatalogueFixture(t, 450)
	library := responseData(t, apiRequest(f.a, "GET", f.path(""), f.token, nil, nil))
	catalogue := library["catalogue"].(map[string]any)
	if catalogue["supported"] != true || catalogue["revision"].(float64) != 1 || catalogue["item_count"] != nil {
		t.Fatal(catalogue)
	}
	if w := apiRequest(f.a, "POST", f.path("/sync"), f.token, map[string]any{"expected_catalogue_revision": 5}, nil); w.Code != 409 {
		t.Fatal("stale catalogue revision accepted", w.Code)
	}
	if w := apiRequest(f.a, "POST", f.path("/sync?sync_episodes=1"), f.token, nil, nil); w.Code != 400 || !strings.Contains(w.Body.String(), "INVALID_SYNC_EPISODES") {
		t.Fatal(w.Code, w.Body.String())
	}
	w := apiRequest(f.a, "POST", f.path("/sync"), f.token, map[string]any{"expected_catalogue_revision": 1}, nil)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	result := responseData(t, w)
	counts := result["result"].(map[string]any)
	if result["success"] != true || result["revision"].(float64) != 2 || counts["added"].(float64) != 450 || counts["updated"].(float64) != 0 || counts["removed"].(float64) != 0 {
		t.Fatal(result)
	}
	if f.upstream.pages != 3 {
		t.Fatal("expected three provider pages, got", f.upstream.pages)
	}
	list := f.list(t, "page=1&page_size=24&sort_by=title_asc")
	if list.Meta.Pagination.Total != 450 || list.Meta.Pagination.Pages != 19 || list.Meta.Revision != 2 || len(list.Data) != 24 || list.Data[0].Title != "Movie 0000" {
		t.Fatal(list.Meta, len(list.Data))
	}
	if list.Data[0].Thumb == "" || list.Data[1].Thumb != "" || list.Data[0].DurationMS == nil || *list.Data[0].DurationMS != 7200000 || list.Data[0].Summary != "" {
		t.Fatal("unexpected list row", list.Data[0], list.Data[1])
	}
	if strings.Contains(list.Data[0].Thumb, "fixture-secret") || !strings.HasPrefix(list.Data[0].Thumb, "/api/media/images/") {
		t.Fatal("thumb is not a signed local URL", list.Data[0].Thumb)
	}
	if searched := f.list(t, "search=movie%2004"); searched.Meta.Pagination.Total != 50 {
		t.Fatal("search", searched.Meta.Pagination.Total)
	}
	if desc := f.list(t, "sort_by=title_desc&page_size=1"); desc.Data[0].Title != "Movie 0449" {
		t.Fatal(desc.Data[0].Title)
	}
	for _, query := range []string{"sort_by=plays_desc", "page_size=500", "page=0"} {
		if w := apiRequest(f.a, "GET", f.path("/media?"+query), f.token, nil, nil); w.Code != 400 {
			t.Fatal(query, w.Code)
		}
	}
	detail := responseData(t, apiRequest(f.a, "GET", f.path(fmt.Sprintf("/media/%d?include_library=true", list.Data[0].ID)), f.token, nil, nil))
	libraryInfo := detail["library"].(map[string]any)
	if detail["summary"] != "A disposable fixture film." || libraryInfo["server"].(map[string]any)["service_type"] != "jellyfin" {
		t.Fatal(detail)
	}
	// Signed image: served with safe headers; tampering, another item and a
	// revoked session are refused before the provider is contacted.
	thumb := list.Data[0].Thumb
	img := apiRequest(f.a, "GET", thumb, "", nil, nil)
	if img.Code != 200 || img.Header().Get("Content-Type") != "image/png" || img.Header().Get("X-Content-Type-Options") != "nosniff" || !strings.HasPrefix(img.Header().Get("Cache-Control"), "private") {
		t.Fatal(img.Code, img.Header())
	}
	parsed, _ := url.Parse(thumb)
	q := parsed.Query()
	forged := fmt.Sprintf("/api/media/images/%d?%s", list.Data[2].ID, q.Encode())
	q.Set("e", strconv.FormatInt(mustInt(t, q.Get("e"))+1, 10))
	for _, bad := range []string{forged, parsed.Path + "?" + q.Encode()} {
		if w := apiRequest(f.a, "GET", bad, "", nil, nil); w.Code != 403 {
			t.Fatal("forged image link accepted", bad, w.Code)
		}
	}
	hits := f.upstream.imageHit
	activityExec(t, f.s, "DELETE FROM app_sessions")
	if w := apiRequest(f.a, "GET", thumb, "", nil, nil); w.Code != 403 || f.upstream.imageHit != hits {
		t.Fatal("revoked session image fetched", w.Code)
	}
	f.token, _ = loginOwner(t, f.a)
	// A changed upstream reports exact differences.
	f.upstream.mu.Lock()
	f.upstream.items = f.upstream.items[10:]
	f.upstream.items[0]["Name"] = "Renamed"
	for i := 0; i < 5; i++ {
		f.upstream.items = append(f.upstream.items, map[string]any{"Id": fmt.Sprintf("new%d", i), "Name": fmt.Sprintf("New %d", i), "Type": "Series"})
	}
	f.upstream.mu.Unlock()
	counts = responseData(t, apiRequest(f.a, "POST", f.path("/sync"), f.token, nil, nil))["result"].(map[string]any)
	if counts["added"].(float64) != 5 || counts["updated"].(float64) != 1 || counts["removed"].(float64) != 10 || f.itemCount(t) != 445 {
		t.Fatal(counts, f.itemCount(t))
	}
	var audits int
	f.s.reader.QueryRow("SELECT count(*) FROM audit_events WHERE action='library.catalogue.sync'").Scan(&audits)
	if audits != 2 {
		t.Fatal("audits", audits)
	}
	purged := responseData(t, apiRequest(f.a, "POST", f.path("/purge"), f.token, map[string]any{"expected_catalogue_revision": 3}, nil))
	if purged["deleted_count"].(float64) != 445 || purged["revision"].(float64) != 4 || f.itemCount(t) != 0 {
		t.Fatal(purged)
	}
	if w := apiRequest(f.a, "POST", f.path("/purge"), f.token, map[string]any{"expected_catalogue_revision": 3}, nil); w.Code != 409 {
		t.Fatal("stale purge accepted", w.Code)
	}
}

func mustInt(t *testing.T, raw string) int64 {
	t.Helper()
	n, err := strconv.ParseInt(raw, 10, 64)
	if err != nil {
		t.Fatal(err)
	}
	return n
}

func loginOwner(t *testing.T, a *App) (string, *http.Cookie) {
	t.Helper()
	w := apiRequest(a, "POST", "/api/auth/login", "", map[string]string{"username": "owner", "password": "a-strong-new-password"}, nil)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	return responseData(t, w)["access_token"].(string), w.Result().Cookies()[0]
}

func TestLibraryCatalogueRejectsIncompleteOrStaleSnapshots(t *testing.T) {
	f := newCatalogueFixture(t, 300)
	if w := apiRequest(f.a, "POST", f.path("/sync"), f.token, nil, nil); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	sync := func(mutate func(start int)) int {
		f.upstream.mu.Lock()
		f.upstream.onPage = mutate
		f.upstream.mu.Unlock()
		defer func() { f.upstream.mu.Lock(); f.upstream.onPage = nil; f.upstream.mu.Unlock() }()
		return apiRequest(f.a, "POST", f.path("/sync"), f.token, nil, nil).Code
	}
	// The total changes between pages.
	if code := sync(func(start int) {
		if start > 0 {
			f.upstream.setItems(301, "a")
		}
	}); code != 502 {
		t.Fatal("changed total accepted", code)
	}
	// A page repeats an item already seen.
	f.upstream.setItems(300, "a")
	if code := sync(func(start int) {
		if start > 0 {
			f.upstream.mu.Lock()
			f.upstream.items[200]["Id"] = "a0000"
			f.upstream.mu.Unlock()
		}
	}); code != 502 {
		t.Fatal("duplicate item accepted", code)
	}
	// The catalogue advanced while the provider was being read.
	f.upstream.setItems(250, "b")
	if code := sync(func(start int) {
		if start > 0 {
			activityExec(t, f.s, "UPDATE media_libraries SET catalogue_revision=catalogue_revision+1 WHERE id=?", f.library)
		}
	}); code != 409 {
		t.Fatal("stale snapshot committed", code)
	}
	if f.itemCount(t) != 300 {
		t.Fatal("failed syncs changed the previous catalogue", f.itemCount(t))
	}
	var title string
	f.s.reader.QueryRow("SELECT title FROM media_items WHERE library_id=? ORDER BY id LIMIT 1", f.library).Scan(&title)
	if title != "Movie 0000" {
		t.Fatal(title)
	}
	// A provider without a catalogue adapter and a non-administrator are refused.
	activityExec(t, f.s, "INSERT INTO media_servers(server_nickname,service_type,url,api_key) VALUES('Kavita fixture','kavita','http://127.0.0.1:9','key')")
	activityExec(t, f.s, "INSERT INTO media_libraries(internal_id,server_id,external_id,name) VALUES('k-lib',(SELECT id FROM media_servers WHERE service_type='kavita'),'1','Books')")
	var kavita int64
	f.s.reader.QueryRow("SELECT id FROM media_libraries WHERE internal_id='k-lib'").Scan(&kavita)
	if w := apiRequest(f.a, "POST", fmt.Sprintf("/api/libraries/%d/sync", kavita), f.token, nil, nil); w.Code != 409 || !strings.Contains(w.Body.String(), "CATALOGUE_UNSUPPORTED") {
		t.Fatal(w.Code, w.Body.String())
	}
	owner, _ := f.s.Authenticate(t.Context(), f.token)
	member, err := f.s.CreateAccount(t.Context(), owner.UUID, "member", "encoded", false)
	if err != nil {
		t.Fatal(err)
	}
	tokens, err := f.s.issueSession(t.Context(), member, false)
	if err != nil {
		t.Fatal(err)
	}
	for _, req := range [][2]string{{"POST", "/sync"}, {"POST", "/purge"}, {"GET", "/media"}, {"GET", "/sync-status"}} {
		if w := apiRequest(f.a, req[0], f.path(req[1]), tokens.Access, nil, nil); w.Code != 403 {
			t.Fatal(req, w.Code)
		}
	}
	status := responseData(t, apiRequest(f.a, "GET", f.path("/sync-status"), f.token, nil, nil))
	if status["is_syncing"] != false {
		t.Fatal(status)
	}
}

func TestLibraryCatalogueSyncStatusAndBusyGuard(t *testing.T) {
	f := newCatalogueFixture(t, 250)
	release := make(chan struct{})
	entered := make(chan struct{}, 1)
	f.upstream.onPage = func(start int) {
		if start > 0 {
			entered <- struct{}{}
			<-release
		}
	}
	done := make(chan int)
	go func() { done <- apiRequest(f.a, "POST", f.path("/sync"), f.token, nil, nil).Code }()
	<-entered
	status := responseData(t, apiRequest(f.a, "GET", f.path("/sync-status"), f.token, nil, nil))
	progress := status["progress"].(map[string]any)
	if status["is_syncing"] != true || progress["total_fetched"].(float64) != 200 || progress["total_items"].(float64) != 250 {
		t.Fatal(status)
	}
	for _, path := range []string{"/sync", "/purge"} {
		if w := apiRequest(f.a, "POST", f.path(path), f.token, nil, nil); w.Code != 409 || !strings.Contains(w.Body.String(), "CATALOGUE_SYNC_BUSY") {
			t.Fatal(path, w.Code, w.Body.String())
		}
	}
	if f.itemCount(t) != 0 {
		t.Fatal("items written before the snapshot completed")
	}
	close(release)
	if code := <-done; code != 200 || f.itemCount(t) != 250 {
		t.Fatal(code, f.itemCount(t))
	}
}

func TestProviderMetadataAdvertisesCompiledProvidersAndCatalogueOnlyWhereImplemented(t *testing.T) {
	a, _ := testApp(t)
	token, _ := bootstrapOwner(t, a)
	w := apiRequest(a, "GET", "/api/providers", token, nil, nil)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	var out struct {
		Data []struct {
			ID           string   `json:"id"`
			PluginType   string   `json:"plugin_type"`
			Capabilities []string `json:"capabilities"`
		} `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	if len(out.Data) != len(compiledProviders) {
		t.Fatal("provider count", len(out.Data))
	}
	for _, p := range out.Data {
		// Compiled providers cannot be uninstalled; the page hides Uninstall for "core".
		if p.PluginType != "core" {
			t.Fatal(p.ID, "plugin_type", p.PluginType)
		}
		advertised := false
		for _, c := range p.Capabilities {
			advertised = advertised || c == "libraries.items.sync"
		}
		if advertised != (p.ID == "jellyfin" || p.ID == "emby" || p.ID == "plex") {
			t.Fatal(p.ID, "catalogue capability", advertised)
		}
	}
}
