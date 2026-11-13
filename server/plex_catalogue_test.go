package main

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
)

func plexCatalogueFixture(t *testing.T, handler http.HandlerFunc) *serverConnection {
	t.Helper()
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	provider, err := newServerConnection(ProviderConfig{"plex", server.URL + "/proxy", "fixture-secret"}, server.Client())
	if err != nil {
		t.Fatal(err)
	}
	return provider
}

func TestPlexCatalogueAdapterCompleteSnapshots(t *testing.T) {
	for _, kind := range []string{"movie", "show", "artist"} {
		t.Run(kind, func(t *testing.T) {
			pages := 0
			p := plexCatalogueFixture(t, func(w http.ResponseWriter, r *http.Request) {
				pages++
				start, _ := strconv.Atoi(r.Header.Get("X-Plex-Container-Start"))
				if r.Header.Get("X-Plex-Token") != "fixture-secret" || r.Header.Get("X-Plex-Container-Size") != "200" || r.Header.Get("Accept") != "application/xml" || r.URL.Path != "/proxy/library/sections/7/all" || strings.Contains(r.URL.RawQuery, "secret") {
					t.Error("wrong private transport", r.URL, r.Header)
				}
				expectedType, element, rowKind := "1", "Video", kind
				if kind == "show" {
					expectedType, element = "2", "Directory"
				}
				if kind == "artist" { // music sections are catalogued by album
					expectedType, element, rowKind = "9", "Directory", "album"
				}
				if r.URL.Query().Get("type") != expectedType {
					t.Error("wrong item kind")
				}
				fmt.Fprintf(w, `<MediaContainer size="%d" totalSize="201" offset="%d" librarySectionID="7">`, min(200, 201-start), start)
				for n := start; n < min(start+200, 201); n++ {
					fmt.Fprintf(w, `<%s ratingKey="%d" type="%s" title="Item %d" titleSort="Sorted %d" summary="Fixture" year="2020" rating="7.5" duration="7200000" addedAt="1700000000" thumb="/library/metadata/%d/thumb/1700000000"/>`, element, n+1, rowKind, n, n, n+1)
				}
				fmt.Fprint(w, `</MediaContainer>`)
			})
			progress := 0
			items, err := p.catalogueItems(t.Context(), "7", kind, func(fetched, total int) {
				if total != 201 || fetched <= progress {
					t.Error("invalid progress", fetched, total)
				}
				progress = fetched
			})
			if err != nil || len(items) != 201 || pages != 2 || progress != 201 {
				t.Fatal(len(items), pages, progress, err)
			}
			first := items[0]
			if first.ID != "1" || first.Type != map[string]string{"movie": "movie", "show": "show", "artist": "album"}[kind] || first.SortTitle != "Sorted 0" || first.Summary != "Fixture" || first.Year == nil || *first.Year != 2020 || first.DurationMS == nil || *first.DurationMS != 7200000 || first.Rating == nil || *first.Rating != 7.5 || first.AddedAt != "2023-11-14T22:13:20.000000000Z" || first.ImageTag != "/library/metadata/1/thumb/1700000000" {
				t.Fatal(first)
			}
		})
	}
}

func TestPlexCatalogueAdapterRefusesIncompleteAndAmbiguousSnapshots(t *testing.T) {
	good := `<Video ratingKey="1" type="movie" title="Fixture"/>`
	cases := map[string]string{
		"missing total":       `<MediaContainer size="0" offset="0"/>`,
		"missing size":        `<MediaContainer totalSize="0" offset="0"/>`,
		"missing offset":      `<MediaContainer totalSize="0" size="0"/>`,
		"wrong offset":        `<MediaContainer totalSize="1" size="1" offset="1">` + good + `</MediaContainer>`,
		"wrong size":          `<MediaContainer totalSize="1" size="0" offset="0">` + good + `</MediaContainer>`,
		"oversized total":     `<MediaContainer totalSize="50001" size="0" offset="0"/>`,
		"premature empty":     `<MediaContainer totalSize="1" size="0" offset="0"/>`,
		"wrong section":       `<MediaContainer totalSize="1" size="1" offset="0" librarySectionID="8">` + good + `</MediaContainer>`,
		"duplicate attribute": `<MediaContainer totalSize="1" size="1" offset="0">` + strings.Replace(good, `ratingKey="1"`, `ratingKey="2" ratingKey="1"`, 1) + `</MediaContainer>`,
		"duplicate item":      `<MediaContainer totalSize="2" size="2" offset="0">` + good + good + `</MediaContainer>`,
		"wrong kind":          `<MediaContainer totalSize="1" size="1" offset="0"><Directory ratingKey="1" type="show" title="Wrong"/></MediaContainer>`,
		"unsafe poster":       `<MediaContainer totalSize="1" size="1" offset="0"><Video ratingKey="1" type="movie" title="Fixture" thumb="https://example.invalid/private"/></MediaContainer>`,
		"other item poster":   `<MediaContainer totalSize="1" size="1" offset="0"><Video ratingKey="1" type="movie" title="Fixture" thumb="/library/metadata/2/thumb/1"/></MediaContainer>`,
		"error text":          `<MediaContainer totalSize="0" size="0" offset="0">upstream error</MediaContainer>`,

		"wrong root":     `<html/>`,
		"multiple roots": `<MediaContainer totalSize="0" size="0" offset="0"/><MediaContainer/>`,
		"malformed":      `<MediaContainer`,
	}
	for name, body := range cases {
		t.Run(name, func(t *testing.T) {
			p := plexCatalogueFixture(t, func(w http.ResponseWriter, r *http.Request) { fmt.Fprint(w, body) })
			if items, err := p.catalogueItems(t.Context(), "7", "movie", nil); err == nil || items != nil {
				t.Fatal("incomplete snapshot accepted", items, err)
			}
		})
	}
	t.Run("changing total", func(t *testing.T) {
		p := plexCatalogueFixture(t, func(w http.ResponseWriter, r *http.Request) {
			if r.Header.Get("X-Plex-Container-Start") == "0" {
				fmt.Fprint(w, `<MediaContainer totalSize="2" size="1" offset="0">`+good+`</MediaContainer>`)
			} else {
				fmt.Fprint(w, `<MediaContainer totalSize="1" size="0" offset="1"/>`)
			}
		})
		if items, err := p.catalogueItems(t.Context(), "7", "movie", nil); err == nil || items != nil {
			t.Fatal(items, err)
		}
	})
	t.Run("repeated item across pages", func(t *testing.T) {
		p := plexCatalogueFixture(t, func(w http.ResponseWriter, r *http.Request) {
			start := r.Header.Get("X-Plex-Container-Start")
			fmt.Fprintf(w, `<MediaContainer totalSize="2" size="1" offset="%s">%s</MediaContainer>`, start, good)
		})
		if items, err := p.catalogueItems(t.Context(), "7", "movie", nil); err == nil || items != nil {
			t.Fatal(items, err)
		}
	})

	t.Run("empty and preflight", func(t *testing.T) {
		calls := 0
		p := plexCatalogueFixture(t, func(w http.ResponseWriter, r *http.Request) {
			calls++
			fmt.Fprint(w, `<MediaContainer totalSize="0" size="0" offset="0"/>`)
		})
		items, err := p.catalogueItems(t.Context(), "7", "movie", nil)
		if err != nil || items == nil || len(items) != 0 {
			t.Fatal(items, err)
		}
		for _, section := range []string{"../7", "01", "0", "-1", "7?token=secret"} {
			if _, err := p.catalogueItems(t.Context(), section, "movie", nil); err == nil {
				t.Fatal(section)
			}
		}
		if _, err := p.catalogueItems(t.Context(), "7", "photo", nil); err == nil {
			t.Fatal("unsupported kind accepted")
		}
		ctx, cancel := context.WithCancel(t.Context())
		cancel()
		if _, err := p.catalogueItems(ctx, "7", "movie", nil); err == nil {
			t.Fatal("cancelled snapshot succeeded")
		}
		if calls != 1 {
			t.Fatal("preflight sent HTTP", calls)
		}
	})
}

func TestPlexCatalogueAdapterImages(t *testing.T) {
	for _, kind := range []string{"image/png", "image/svg+xml"} {
		t.Run(kind, func(t *testing.T) {
			calls := 0
			p := plexCatalogueFixture(t, func(w http.ResponseWriter, r *http.Request) {
				calls++
				if r.URL.Path != "/proxy/library/metadata/1/thumb/123" || r.URL.RawQuery != "" || r.Header.Get("X-Plex-Token") != "fixture-secret" {
					t.Error("unsafe image request")
				}
				w.Header().Set("Content-Type", kind)
				fmt.Fprint(w, "fixture-image")
			})
			mime, body, err := p.catalogueImage(t.Context(), "1", "/library/metadata/1/thumb/123")
			if kind == "image/png" {
				if err != nil || mime != kind || string(body) != "fixture-image" {
					t.Fatal(mime, string(body), err)
				}
			} else if err == nil {
				t.Fatal("active image type accepted")
			}
			for _, bad := range []string{"https://example.invalid/", "/library/metadata/2/thumb/123", "/library/metadata/1/thumb/../x", "/library/metadata/1/thumb/123?X-Plex-Token=secret", "//example.invalid/path", "/library/metadata/1/thumb/%31"} {
				if _, _, err := p.catalogueImage(t.Context(), "1", bad); err == nil {
					t.Fatal(bad)
				}
			}
			if calls != 1 {
				t.Fatal("unsafe image sent HTTP", calls)
			}
		})
	}
	t.Run("redirect", func(t *testing.T) {
		hits := 0
		target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { hits++ }))
		defer target.Close()
		p := plexCatalogueFixture(t, func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, target.URL, 302) })
		if _, _, err := p.catalogueImage(t.Context(), "1", "/library/metadata/1/thumb"); err == nil || hits != 0 {
			t.Fatal("followed image redirect", hits, err)
		}
	})
	t.Run("bounded and redacted", func(t *testing.T) {
		p := plexCatalogueFixture(t, func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "image/png")
			fmt.Fprint(w, strings.Repeat("x", catalogueImageMax+1))
		})
		if _, body, err := p.catalogueImage(t.Context(), "1", "/library/metadata/1/thumb"); err == nil || body != nil || strings.Contains(err.Error(), "fixture-secret") {
			t.Fatal(len(body), err)
		}
		ctx, cancel := context.WithCancel(t.Context())
		cancel()
		if _, _, err := p.catalogueImage(ctx, "1", "/library/metadata/1/thumb"); err == nil {
			t.Fatal("cancelled request succeeded")
		}
	})
}
