package main

import (
	"fmt"
	"strings"
	"sync"
	"testing"
)

func TestServerNicknameURLConflictsAndValidation(t *testing.T) {
	a, _ := testApp(t)
	token, _ := bootstrapOwner(t, a)
	save := func(name, kind string) int {
		t.Helper()
		return apiRequest(a, "POST", "/api/servers", token, map[string]any{"server_nickname": name, "service_type": kind, "url": "http://fixture.test", "api_key": "fixture-secret"}, nil).Code
	}
	if got := save("hello-world", "jellyfin"); got != 201 {
		t.Fatal(got)
	}
	w := apiRequest(a, "POST", "/api/servers", token, map[string]any{"server_nickname": "Hello World", "service_type": "jellyfin", "url": "http://fixture.test", "api_key": "fixture-secret"}, nil)
	if w.Code != 409 || !strings.Contains(w.Body.String(), "hello-world") || !strings.Contains(strings.ToLower(w.Body.String()), "jellyfin") {
		t.Fatalf("conflict does not identify server: %d %s", w.Code, w.Body.String())
	}
	if got := save("hello-world", "plex"); got != 201 {
		t.Fatalf("cross-provider duplicate: %d", got)
	}
	for _, name := range []string{"bad/name", "only?", "+++"} {
		if got := save(name, "plex"); got != 400 {
			t.Fatal(name, got)
		}
	}
	if got := save("Plex++", "plex"); got != 201 {
		t.Fatal(got)
	}
	if got := save("Other", "jellyfin"); got != 201 {
		t.Fatal(got)
	}
	var id int64
	_ = a.store.reader.QueryRow("SELECT id FROM media_servers WHERE server_nickname='Other'").Scan(&id)
	edit := apiRequest(a, "PATCH", fmt.Sprintf("/api/servers/%d", id), token, map[string]any{"server_nickname": "hello world"}, nil)
	if edit.Code != 409 || !strings.Contains(edit.Body.String(), "hello-world") {
		t.Fatalf("edit conflict: %d %s", edit.Code, edit.Body.String())
	}
	if got := save("second server", "jellyfin"); got != 201 {
		t.Fatal(got)
	}
	if got := save("SECOND-SERVER", "jellyfin"); got != 409 {
		t.Fatal("reverse collision", got)
	}
	unchanged := apiRequest(a, "PATCH", fmt.Sprintf("/api/servers/%d", id), token, map[string]any{"server_nickname": "Other"}, nil)
	if unchanged.Code != 200 {
		t.Fatalf("unchanged nickname: %d %s", unchanged.Code, unchanged.Body.String())
	}
}

func TestServerNicknameConcurrentSlugCollision(t *testing.T) {
	a, _ := testApp(t)
	token, _ := bootstrapOwner(t, a)
	statuses := make(chan int, 2)
	var wg sync.WaitGroup
	for _, name := range []string{"Concurrent Server", "concurrent-server"} {
		wg.Add(1)
		go func(name string) {
			defer wg.Done()
			w := apiRequest(a, "POST", "/api/servers", token, map[string]any{"server_nickname": name, "service_type": "jellyfin", "url": "http://fixture.test", "api_key": "fixture-secret"}, nil)
			statuses <- w.Code
		}(name)
	}
	wg.Wait()
	close(statuses)
	created, conflicts := 0, 0
	for status := range statuses {
		if status == 201 {
			created++
		}
		if status == 409 {
			conflicts++
		}
	}
	if created != 1 || conflicts != 1 {
		t.Fatalf("created=%d conflicts=%d", created, conflicts)
	}
}
