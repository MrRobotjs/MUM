package main

import (
	"fmt"
	"net/http"
	"testing"
	"time"
)

func TestImageCacheBoundsExpiryAndClear(t *testing.T) {
	cache := imageCache{limit: 6, ttl: time.Minute}
	now := time.Now()
	a := imageCacheKey{server: 1, purpose: "poster", external: "1"}
	b := imageCacheKey{server: 2, purpose: "poster", external: "2"}
	cache.put(a, "image/png", []byte("abc"), now, cache.generation(a.server))
	if _, body, ok := cache.get(a, now); !ok || string(body) != "abc" {
		t.Fatal("missing cached image")
	}
	cache.put(b, "image/png", []byte("defg"), now, cache.generation(b.server))
	if _, _, ok := cache.get(a, now); ok {
		t.Fatal("cache exceeded its byte limit")
	}
	if _, _, ok := cache.get(b, now.Add(time.Minute)); ok {
		t.Fatal("expired entry delivered")
	}
	generation := cache.generation(a.server)
	cache.clear(a.server)
	cache.put(a, "image/png", []byte("abc"), now, generation)
	if _, _, ok := cache.get(a, now); ok {
		t.Fatal("clear allowed an in-flight fetch to repopulate the cache")
	}
}

func TestServerImageCacheSettingDefaultAndUpdate(t *testing.T) {
	a, s := testApp(t)
	token, _ := bootstrapOwner(t, a)
	server := createManagedServer(t, a, token, "plex", "http://127.0.0.1:1")
	path := fmt.Sprintf("/api/servers/%d", server)
	view := apiRequest(a, http.MethodGet, path, token, nil, nil)
	if view.Code != 200 || responseData(t, view)["cache_images"] != true {
		t.Fatal(view.Code, view.Body.String())
	}
	update := apiRequest(a, http.MethodPatch, path, token, map[string]any{"cache_images": false}, nil)
	if update.Code != 200 {
		t.Fatal(update.Code, update.Body.String())
	}
	var enabled bool
	if err := s.reader.QueryRow("SELECT cache_images FROM media_servers WHERE id=?", server).Scan(&enabled); err != nil || enabled {
		t.Fatal(enabled, err)
	}
	view = apiRequest(a, http.MethodGet, path, token, nil, nil)
	if view.Code != 200 || responseData(t, view)["cache_images"] != false {
		t.Fatal(view.Code, view.Body.String())
	}
}
