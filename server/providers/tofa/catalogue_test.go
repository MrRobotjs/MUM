package tofa

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"app/server/providers/provider"
)

func TestDecodeMediaPageRejectsIncompleteAndInvalidResponses(t *testing.T) {
	good := `{"items":[{"id":"01234567-89ab-4cde-8fab-0123456789ab","library_id":"11234567-89ab-4cde-8fab-0123456789ab","media_type":"movie","title":"Example"}],"page":1,"per_page":1,"total":1,"total_pages":1}`
	page, err := decodeMediaPage([]byte(good))
	if err != nil || len(page.Items) != 1 || page.Total != 1 {
		t.Fatal(page, err)
	}
	for _, input := range []string{`{}`, `{"items":null,"page":1,"per_page":1,"total":0,"total_pages":0}`, `{"items":[],"page":1,"per_page":0,"total":0,"total_pages":0}`, `{"items":[],"page":1,"per_page":1,"total":-1,"total_pages":0}`, `{"items":[{"id":"bad","library_id":"11234567-89ab-4cde-8fab-0123456789ab","media_type":"movie","title":"Example"}],"page":1,"per_page":1,"total":1,"total_pages":1}`} {
		if _, err := decodeMediaPage([]byte(input)); err == nil {
			t.Fatal("accepted incomplete or invalid page", input)
		}
	}
}

func TestCatalogueRequiresCompleteStableUnrestrictedSnapshot(t *testing.T) {
	mode := "ok"
	library := "11234567-89ab-4cde-8fab-0123456789ab"
	item := "01234567-89ab-4cde-8fab-0123456789ab"
	var srv *httptest.Server
	srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer key" {
			t.Error("missing auth")
		}
		switch r.URL.Path {
		case "/api/v1/profiles":
			if mode == "restricted" {
				fmt.Fprint(w, `[{"is_primary":true,"is_kids":false,"library_ids":["other"],"max_content_rating":null}]`)
			} else {
				fmt.Fprint(w, `[{"is_primary":true,"is_kids":false,"library_ids":null,"max_content_rating":null}]`)
			}
		case "/api/v1/libraries":
			fmt.Fprintf(w, `[{"id":%q,"stats":{"item_count":1}}]`, library)
		case "/api/v1/media/changes":
			fmt.Fprint(w, `{"latest_revision":1,"changes":[],"requires_full_sync":false}`)
		case "/api/v1/media":
			if r.URL.Query().Get("library_id") != library || r.URL.Query().Get("fold_sets") != "false" {
				t.Error("incorrect media query")
			}
			total := 1
			if mode == "partial" {
				total = 0
			}
			fmt.Fprintf(w, `{"items":[{"id":%q,"library_id":%q,"media_type":"movie","title":"Fixture","poster_path":"available"}],"page":1,"per_page":200,"total":%d,"total_pages":1}`, item, library, total)
		default:
			if id, ok := strings.CutPrefix(r.URL.Path, "/api/v1/media/"); ok && !strings.Contains(id, "/") {
				fmt.Fprintf(w, `{"id":%q,"files":[{"available":false,"container":"avi"},{"available":true,"container":"mkv","bitrate":8378534,"video_codec":"h264","height":800,"display_frame_rate":23.976,"audio_codec":"eac3","file_size":6395670608,"audio_tracks":[{"codec":"eac3","channels":6}]}]}`, id)
				return
			}
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()
	s := New(provider.Config{URL: srv.URL, APIKey: "key", Transport: provider.Transport{Client: srv.Client()}})
	rows, err := s.CatalogueItems(context.Background(), library, "movie", nil)
	if err != nil || len(rows) != 1 || rows[0].Title != "Fixture" || rows[0].ImageTag == "" || rows[0].Media == nil || rows[0].Media.Container != "MKV" || *rows[0].Media.BitrateKbps != 8378 || rows[0].Media.VideoResolution != "1080p" || rows[0].Media.VideoFrameRate != "24p" || *rows[0].Media.AudioChannels != 6 {
		t.Fatal(rows, err)
	}
	for _, m := range []string{"restricted", "partial"} {
		mode = m
		if _, err = s.CatalogueItems(context.Background(), library, "movie", nil); err == nil {
			t.Fatal("accepted", m)
		}
	}
}

func TestCatalogueImageRedirectKeepsCredentialsOnOrigin(t *testing.T) {
	var leaked bool
	other := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { leaked = true }))
	defer other.Close()
	cross := false
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/image" {
			if r.Header.Get("Authorization") != "Bearer key" {
				t.Error("missing authorization")
			}
			w.Header().Set("Content-Type", "image/png")
			fmt.Fprint(w, "image")
			return
		}
		if cross {
			http.Redirect(w, r, other.URL, http.StatusFound)
		} else {
			http.Redirect(w, r, "/image", http.StatusFound)
		}
	}))
	defer upstream.Close()
	s := New(provider.Config{URL: upstream.URL, APIKey: "key", Transport: provider.Transport{Client: upstream.Client()}})
	id := "01234567-89ab-4cde-8fab-0123456789ab"
	kind, body, err := s.CatalogueImage(context.Background(), id, "poster")
	if err != nil || kind != "image/png" || string(body) != "image" {
		t.Fatal(kind, err)
	}
	cross = true
	if _, _, err = s.CatalogueImage(context.Background(), id, "poster"); err == nil || leaked {
		t.Fatal("unsafe redirect accepted")
	}
}

func TestCatalogueRejectsChangingOrDuplicatePages(t *testing.T) {
	library := "11234567-89ab-4cde-8fab-0123456789ab"
	mode := "good"
	revisionReads := 0
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/v1/profiles":
			fmt.Fprint(w, `[{"is_primary":true,"is_kids":false,"library_ids":null,"max_content_rating":null}]`)
		case "/api/v1/libraries":
			fmt.Fprintf(w, `[{"id":%q,"stats":{"item_count":2}}]`, library)
		case "/api/v1/media/changes":
			revisionReads++
			revision := 1
			if mode == "changed" && revisionReads > 1 {
				revision = 2
			}
			if mode == "always_changed" {
				revision = revisionReads
			}
			fmt.Fprintf(w, `{"latest_revision":%d}`, revision)
		case "/api/v1/media":
			p := r.URL.Query().Get("page")
			id := "01234567-89ab-4cde-8fab-0123456789ab"
			if p == "2" && mode != "duplicate" {
				id = "11234567-89ab-4cde-8fab-0123456789ac"
			}
			fmt.Fprintf(w, `{"items":[{"id":%q,"library_id":%q,"media_type":"movie","title":"Example"}],"page":%s,"per_page":1,"total":2,"total_pages":2}`, id, library, p)
		default:
			if id, ok := strings.CutPrefix(r.URL.Path, "/api/v1/media/"); ok && !strings.Contains(id, "/") {
				fmt.Fprintf(w, `{"id":%q,"files":[{"available":false,"container":"avi"},{"available":true,"container":"mkv","bitrate":8378534,"video_codec":"h264","height":800,"display_frame_rate":23.976,"audio_codec":"eac3","file_size":6395670608,"audio_tracks":[{"codec":"eac3","channels":6}]}]}`, id)
				return
			}
			http.NotFound(w, r)
		}
	}))
	defer upstream.Close()
	s := New(provider.Config{URL: upstream.URL, Transport: provider.Transport{Client: upstream.Client()}})
	for _, m := range []string{"good", "duplicate", "changed", "always_changed"} {
		mode = m
		revisionReads = 0
		items, err := s.CatalogueItems(context.Background(), library, "movie", nil)
		if m == "good" || m == "changed" {
			if err != nil || len(items) != 2 {
				t.Fatal(items, err)
			}
		} else if err == nil {
			t.Fatal("accepted", m)
		}
	}
}

func TestCatalogueAcceptsVerifiedMergedVersions(t *testing.T) {
	library := "11234567-89ab-4cde-8fab-0123456789ab"
	first := "01234567-89ab-4cde-8fab-0123456789ab"
	second := "21234567-89ab-4cde-8fab-0123456789ab"
	mode := "merged"
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/v1/profiles":
			fmt.Fprint(w, `[{"is_primary":true,"is_kids":false,"library_ids":null,"max_content_rating":null}]`)
		case "/api/v1/libraries":
			fmt.Fprintf(w, `[{"id":%q,"merge_versions":%t,"stats":{"item_count":2}}]`, library, mode != "merge_disabled")
		case "/api/v1/media/changes":
			fmt.Fprint(w, `{"latest_revision":1}`)
		case "/api/v1/media":
			fmt.Fprintf(w, `{"items":[{"id":%q,"library_id":%q,"media_type":"movie","title":"Example","tmdb_id":17}],"page":1,"per_page":200,"total":1,"total_pages":1}`, first, library)
		case "/api/v1/media/files":
			if mode == "missing_file" {
				fmt.Fprintf(w, `{"items":[{"media_id":%q}],"next_after":null}`, first)
			} else {
				fmt.Fprintf(w, `{"items":[{"media_id":%q},{"media_id":%q}],"next_after":null}`, first, second)
			}
		case "/api/v1/media/" + second:
			id := 17
			if mode == "unrelated" {
				id = 18
			}
			fmt.Fprintf(w, `{"id":%q,"library_id":%q,"media_type":"movie","tmdb_id":%d}`, second, library, id)
		default:
			if id, ok := strings.CutPrefix(r.URL.Path, "/api/v1/media/"); ok && !strings.Contains(id, "/") {
				fmt.Fprintf(w, `{"id":%q,"files":[{"available":false,"container":"avi"},{"available":true,"container":"mkv","bitrate":8378534,"video_codec":"h264","height":800,"display_frame_rate":23.976,"audio_codec":"eac3","file_size":6395670608,"audio_tracks":[{"codec":"eac3","channels":6}]}]}`, id)
				return
			}
			http.NotFound(w, r)
		}
	}))
	defer upstream.Close()
	s := New(provider.Config{URL: upstream.URL, Transport: provider.Transport{Client: upstream.Client()}})
	items, err := s.CatalogueItems(context.Background(), library, "movie", nil)
	if err != nil || len(items) != 1 {
		t.Fatal(items, err)
	}
	for _, mode = range []string{"unrelated", "missing_file", "merge_disabled"} {
		if _, err := s.CatalogueItems(context.Background(), library, "movie", nil); err == nil {
			t.Fatal("accepted an unverified snapshot", mode)
		}
	}
}
