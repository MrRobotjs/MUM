package tofa

import (
	"app/server/providers/provider"
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestEpisodesIncludeOnlyAvailableFilesAndRejectInvalidSnapshots(t *testing.T) {
	show := "01234567-89ab-4cde-8fab-0123456789ab"
	lib := "11234567-89ab-4cde-8fab-0123456789ab"
	season := "21234567-89ab-4cde-8fab-0123456789ab"
	e1 := "31234567-89ab-4cde-8fab-0123456789ab"
	e2 := "41234567-89ab-4cde-8fab-0123456789ab"
	mode := "valid"
	revisions := 0
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/v1/media/changes":
			revisions++
			revision := 1
			if mode == "changed" && revisions > 1 {
				revision = 2
			}
			if mode == "always_changed" {
				revision = revisions
			}
			fmt.Fprintf(w, `{"latest_revision":%d}`, revision)
		case "/api/v1/profiles":
			fmt.Fprint(w, `[{"is_primary":true,"is_kids":false,"library_ids":null,"max_content_rating":null}]`)
		case "/api/v1/libraries":
			fmt.Fprintf(w, `[{"id":%q,"merge_versions":false,"stats":{"item_count":1}}]`, lib)
		case "/api/v1/media/" + show:
			available := `true`
			if mode == "bad_availability" {
				available = `null`
			}
			fmt.Fprintf(w, `{"id":%q,"library_id":%q,"media_type":"tv","seasons":[{"id":%q,"media_id":%q,"season_number":1,"episodes":[{"id":%q,"season_id":%q,"episode_number":1,"title":"Episode one","still_path":"images/stills/example.jpg","files":[{"available":%s}]},{"id":%q,"season_id":%q,"episode_number":2,"title":"Missing","files":[]}]}]}`, show, lib, season, show, e1, season, available, e2, season)
		default:
			http.NotFound(w, r)
		}
	}))
	defer upstream.Close()
	s := New(provider.Config{URL: upstream.URL, Transport: provider.Transport{Client: upstream.Client()}})
	got, err := s.CatalogueEpisodes(context.Background(), show)
	if err != nil || len(got) != 1 || got[0].ID != e1 || got[0].Season == nil || *got[0].Season != 1 || got[0].ImageTag != "images/stills/example.jpg" {
		t.Fatal(got, err)
	}
	mode = "bad_availability"
	if _, err = s.CatalogueEpisodes(context.Background(), show); err == nil {
		t.Fatal("accepted missing availability")
	}
	mode = "changed"
	revisions = 0
	if _, err = s.CatalogueEpisodes(context.Background(), show); err != nil {
		t.Fatal("transient revision change was not retried", err)
	}
	mode = "always_changed"
	revisions = 0
	if _, err = s.CatalogueEpisodes(context.Background(), show); err == nil {
		t.Fatal("accepted changing catalogue")
	}
}

func TestEpisodesMergeVersionsWithoutDuplicateNumbers(t *testing.T) {
	show := "01234567-89ab-4cde-8fab-0123456789ab"
	other := "51234567-89ab-4cde-8fab-0123456789ab"
	lib := "11234567-89ab-4cde-8fab-0123456789ab"
	mode := "ok"
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/v1/media/changes":
			fmt.Fprint(w, `{"latest_revision":1}`)
		case "/api/v1/profiles":
			fmt.Fprint(w, `[{"is_primary":true,"is_kids":false,"library_ids":null,"max_content_rating":null}]`)
		case "/api/v1/libraries":
			fmt.Fprintf(w, `[{"id":%q,"merge_versions":true,"stats":{"item_count":2}}]`, lib)
		case "/api/v1/media/files":
			if mode == "missing_identity" {
				fmt.Fprintf(w, `{"items":[{"media_id":%q,"media_type":"tv","tmdb_id":null}],"next_after":null}`, other)
			} else if mode == "visible_without_tmdb" {
				fmt.Fprintf(w, `{"items":[{"media_id":"91234567-89ab-4cde-8fab-0123456789ab","media_type":"tv","tmdb_id":null}],"next_after":null}`)
			} else {
				fmt.Fprintf(w, `{"items":[{"media_id":%q,"media_type":"tv","tmdb_id":5},{"media_id":%q,"media_type":"tv","tmdb_id":5}],"next_after":null}`, show, other)
			}
		case "/api/v1/media/" + show:
			fmt.Fprintf(w, `{"id":%q,"library_id":%q,"media_type":"tv","tmdb_id":5,"seasons":[{"id":"21234567-89ab-4cde-8fab-0123456789ab","media_id":%q,"season_number":1,"episodes":[{"id":"31234567-89ab-4cde-8fab-0123456789ab","season_id":"21234567-89ab-4cde-8fab-0123456789ab","episode_number":1,"title":"One","files":[{"available":true}]}]}]}`, show, lib, show)
		case "/api/v1/media/" + other:
			if mode == "missing_identity" {
				fmt.Fprintf(w, `{"id":%q,"library_id":%q,"media_type":"tv","tmdb_id":null}`, other, lib)
				return
			}
			fmt.Fprintf(w, `{"id":%q,"library_id":%q,"media_type":"tv","tmdb_id":5,"seasons":[{"id":"61234567-89ab-4cde-8fab-0123456789ab","media_id":%q,"season_number":1,"episodes":[{"id":"71234567-89ab-4cde-8fab-0123456789ab","season_id":"61234567-89ab-4cde-8fab-0123456789ab","episode_number":1,"title":"One alternate","files":[{"available":true}]},{"id":"81234567-89ab-4cde-8fab-0123456789ab","season_id":"61234567-89ab-4cde-8fab-0123456789ab","episode_number":2,"title":"Two","files":[{"available":true}]}]}]}`, other, lib, other)
		case "/api/v1/media":
			fmt.Fprintf(w, `{"items":[{"id":%q,"library_id":%q,"media_type":"tv","title":"One"},{"id":"91234567-89ab-4cde-8fab-0123456789ab","library_id":%q,"media_type":"tv","title":"Other"}],"page":1,"per_page":200,"total":2,"total_pages":1}`, show, lib, lib)
		default:
			http.NotFound(w, r)
		}
	}))
	defer upstream.Close()
	s := New(provider.Config{URL: upstream.URL, Transport: provider.Transport{Client: upstream.Client()}})
	got, err := s.CatalogueEpisodes(context.Background(), show)
	if err != nil || len(got) != 2 || got[0].Title != "One" || got[1].Title != "Two" {
		t.Fatal(got, err)
	}
	mode = "visible_without_tmdb"
	if got, err := s.CatalogueEpisodes(context.Background(), show); err != nil || len(got) != 1 {
		t.Fatal("unrelated visible show without TMDB blocked sync", got, err)
	}
	mode = "missing_identity"
	if _, err = s.CatalogueEpisodes(context.Background(), show); err == nil {
		t.Fatal("accepted incomplete merged identity")
	}
}

func TestEpisodeStillFetchRejectsUnsafePaths(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/cache/images/stills/example.jpg" || r.Header.Get("Authorization") != "Bearer key" {
			t.Error("incorrect authenticated still request")
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "image/jpeg")
		fmt.Fprint(w, "image")
	}))
	defer upstream.Close()
	s := New(provider.Config{URL: upstream.URL, APIKey: "key", Transport: provider.Transport{Client: upstream.Client()}})
	id := "01234567-89ab-4cde-8fab-0123456789ab"
	kind, data, err := s.CatalogueImage(context.Background(), id, "images/stills/example.jpg")
	if err != nil || kind != "image/jpeg" || string(data) != "image" {
		t.Fatal(kind, err)
	}
	for _, bad := range []string{"images/stills/../../secret.jpg", "https://evil.example/image.jpg", "images/stills/x.jpg?token=secret", "images/stills/x.svg"} {
		if _, _, err := s.CatalogueImage(context.Background(), id, bad); err == nil {
			t.Fatal("accepted unsafe image path")
		}
	}
}
