package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

func activityFixtureRow() map[string]any {
	return map[string]any{"Id": "session", "UserId": "user", "NowPlayingItem": map[string]any{"Id": "item", "Name": "A film", "Type": "Movie", "RunTimeTicks": int64(100000000)}, "PlayState": map[string]any{"IsPaused": false, "PositionTicks": int64(10000000)}, "AdditionalUsers": []any{}}
}
func TestActivityProviderStrictCompleteResponse(t *testing.T) {
	for _, kind := range []string{"jellyfin", "emby"} {
		t.Run(kind, func(t *testing.T) {
			row := activityFixtureRow()
			row["RemoteEndPoint"] = "private-ip"
			row["AccessToken"] = "private-key"
			row["UserName"] = "not-an-identity"
			body, _ := json.Marshal([]any{row, map[string]any{"Id": "idle", "NowPlayingItem": nil}})
			snapshot, err := parseActivitySnapshot(kind, body)
			if err != nil || len(snapshot.Sessions) != 1 || snapshot.ObservedAt.IsZero() || snapshot.Sessions[0].Paused {
				t.Fatal(snapshot, err)
			}
			encoded, _ := json.Marshal(snapshot)
			for _, private := range []string{"private-ip", "private-key", "not-an-identity", "RemoteEndPoint"} {
				if strings.Contains(string(encoded), private) {
					t.Fatal("raw private data retained", private)
				}
			}
			empty, err := parseActivitySnapshot(kind, []byte(`[]`))
			if err != nil || empty.Sessions == nil || len(empty.Sessions) != 0 {
				t.Fatal("genuine empty response rejected", err)
			}
		})
	}
}
func TestActivityProviderRejectsAmbiguousOrPartialResponses(t *testing.T) {
	for _, mode := range []string{"null", "object", "truncated", "duplicate-session", "missing-id", "missing-user", "missing-pause", "null-pause", "bad-position", "negative-duration", "overshoot", "unknown-kind", "cowatch", "duplicate-key", "case-alias", "optional-alias", "unknown-duplicate", "oversized", "too-many", "too-deep", "partial-tail"} {
		t.Run(mode, func(t *testing.T) {
			row := activityFixtureRow()
			rows := []any{row}
			var body []byte
			switch mode {
			case "missing-id":
				delete(row, "Id")
			case "missing-user":
				delete(row, "UserId")
			case "missing-pause":
				delete(row["PlayState"].(map[string]any), "IsPaused")
			case "null-pause":
				row["PlayState"].(map[string]any)["IsPaused"] = nil
			case "bad-position":
				row["PlayState"].(map[string]any)["PositionTicks"] = 1.5
			case "negative-duration":
				row["NowPlayingItem"].(map[string]any)["RunTimeTicks"] = -1
			case "overshoot":
				row["NowPlayingItem"].(map[string]any)["RunTimeTicks"] = 0
			case "unknown-kind":
				row["NowPlayingItem"].(map[string]any)["Type"] = "LiveTvChannel"
			case "cowatch":
				row["AdditionalUsers"] = []any{map[string]any{"UserId": "another"}}
			case "duplicate-session":
				rows = append(rows, activityFixtureRow())
			case "case-alias":
				row["nowPlayingItem"] = row["NowPlayingItem"]
				delete(row, "NowPlayingItem")
			case "optional-alias":
				row["PlayState"].(map[string]any)["positionTicks"] = 0
			case "too-many":
				rows = []any{}
				for i := 0; i < 1001; i++ {
					rows = append(rows, map[string]any{"Id": i})
				}
			case "partial-tail":
				rows = append(rows, map[string]any{"Id": "bad", "NowPlayingItem": map[string]any{}})
			}
			body, _ = json.Marshal(rows)
			switch mode {
			case "null":
				body = []byte(`null`)
			case "object":
				body = []byte(`{"Items":[]}`)
			case "truncated":
				body = body[:len(body)-1]
			case "duplicate-key":
				body = []byte(`[{"Id":"first","Id":"second"}]`)
			case "unknown-duplicate":
				body = []byte(`[{"Id":"idle","Unknown":{"a":1,"a":2}}]`)
			case "oversized":
				body = []byte("[" + strings.Repeat(" ", 2<<20) + "]")
			case "too-deep":
				body = []byte(strings.Repeat("[", 35) + strings.Repeat("]", 35))
			}
			snapshot, err := parseActivitySnapshot("jellyfin", body)
			if err == nil || len(snapshot.Sessions) != 0 || !snapshot.ObservedAt.IsZero() {
				t.Fatal("partial or ambiguous response accepted", mode, err)
			}
		})
	}
}
func TestActivityProviderBoundedAuthenticatedTransport(t *testing.T) {
	for _, kind := range []string{"jellyfin", "emby"} {
		t.Run(kind, func(t *testing.T) {
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				expected := "/root/Sessions"
				if kind == "emby" {
					expected = "/root/emby/Sessions"
				}
				if r.URL.RequestURI() != expected || r.Header.Get("X-Emby-Token") != "fixture-key" {
					t.Error("wrong endpoint or auth", r.URL.RequestURI())
				}
				if kind == "jellyfin" && !strings.Contains(r.Header.Get("Accept"), "PascalCase") {
					t.Error("case profile not explicit")
				}
				_ = json.NewEncoder(w).Encode([]any{activityFixtureRow()})
			}))
			defer upstream.Close()
			provider, err := newMediaProvider(ProviderConfig{kind, upstream.URL + "/root", "fixture-key"}, nil)
			if err != nil {
				t.Fatal(err)
			}
			snapshot, err := provider.(*jsonProvider).readActivitySnapshot(t.Context())
			if err != nil || len(snapshot.Sessions) != 1 {
				t.Fatal(err)
			}
		})
	}
	var stolen atomic.Int32
	destination := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { stolen.Add(1) }))
	defer destination.Close()
	redirect := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, destination.URL, 302) }))
	defer redirect.Close()
	provider, _ := newMediaProvider(ProviderConfig{"jellyfin", redirect.URL, "fixture-key"}, nil)
	if _, err := provider.(*jsonProvider).readActivitySnapshot(t.Context()); err == nil || stolen.Load() != 0 {
		t.Fatal("redirect followed with provider credentials")
	}
	for _, status := range []int{204, 206, 401, 500} {
		t.Run(http.StatusText(status), func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(status); _, _ = w.Write([]byte(`[]`)) }))
			defer server.Close()
			p, _ := newMediaProvider(ProviderConfig{"jellyfin", server.URL, "fixture-key"}, nil)
			if _, err := p.(*jsonProvider).readActivitySnapshot(t.Context()); err == nil {
				t.Fatal("non-complete status accepted")
			}
		})
	}
	if _, err := parseActivitySnapshot("plex", []byte(`[]`)); err == nil {
		t.Fatal("unsupported provider acquired activity support")
	}
}
