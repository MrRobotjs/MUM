package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// Credentials never reach a debug log: tokens, keys, passwords and sign-in
// codes are removed from URLs and from JSON, XML and plain-text bodies, while
// the rest of the payload stays readable.
func TestDebugLogRedaction(t *testing.T) {
	url := redactDebugURL("http://plex:32400/status/sessions?X-Plex-Token=abc123&api_key=k&limit=5")
	if strings.Contains(url, "abc123") || strings.Contains(url, "=k&") || !strings.Contains(url, "limit=5") {
		t.Fatal(url)
	}
	body := redactDebugBody(`{"User":{"Name":"viewer","AccessToken":"secret-a","Policy":{"Password":"p"}},"Sessions":[{"Id":"s1"}],"code":"PIN123","error":{"code":401},"Pw":"x"}`, "application/json")
	for _, leaked := range []string{"secret-a", `"p"`, "PIN123", `"x"`} {
		if strings.Contains(body, leaked) {
			t.Fatal("JSON secret kept", leaked, body)
		}
	}
	if !strings.Contains(body, `"viewer"`) || !strings.Contains(body, `"s1"`) || !strings.Contains(body, `"code":401`) {
		t.Fatal("JSON detail lost", body)
	}
	xml := redactDebugBody(`<MediaContainer><Device name="TV" accessToken="tok-1" key="/library/metadata/5" authenticationToken="tok-2"/></MediaContainer>`, "text/xml")
	if strings.Contains(xml, "tok-1") || strings.Contains(xml, "tok-2") || !strings.Contains(xml, `key="/library/metadata/5"`) {
		t.Fatal(xml)
	}
	if text := redactDebugBody("failed for token=xyz789 and password: hunter2", "text/plain"); strings.Contains(text, "xyz789") || strings.Contains(text, "hunter2") {
		t.Fatal(text)
	}
}

// waitDebugEntries reads a stream's newest records until there are some.
func waitDebugEntries(t *testing.T, a *App, token, query string) []map[string]any {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for {
		w := apiRequest(a, "GET", "/api/settings/debug-logging/entries?"+query, token, nil, nil)
		if w.Code != 200 {
			t.Fatal(w.Code, w.Body.String())
		}
		var entries []map[string]any
		for _, v := range responseData(t, w)["entries"].([]any) {
			entries = append(entries, v.(map[string]any))
		}
		if len(entries) > 0 || time.Now().After(deadline) {
			return entries
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// A switched-on stream records the service's responses without its key, a
// switched-off or expired one records nothing, and only administrators can
// read, download or clear the files.
func TestDebugLoggingRecordsSwitchedOnStreams(t *testing.T) {
	a, s := testApp(t)
	token, _ := bootstrapOwner(t, a)
	upstream, _ := providerFixture(t, "jellyfin")
	id := createManagedServer(t, a, token, "jellyfin", upstream.URL)
	a.ProviderHTTP = &http.Client{Transport: debugTransport{base: upstream.Client().Transport, log: a.debugLogs}}
	sync := func() {
		t.Helper()
		if w := apiRequest(a, "POST", fmt.Sprintf("/api/servers/%d/sync", id), token, nil, nil); w.Code != 200 {
			t.Fatal(w.Code, w.Body.String())
		}
	}

	w := apiRequest(a, "GET", "/api/settings/debug-logging", token, nil, nil)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	streams := responseData(t, w)["streams"].([]any)
	if len(streams) != 2 || streams[0].(map[string]any)["transport"] != "http" || streams[1].(map[string]any)["transport"] != "websocket" || streams[0].(map[string]any)["enabled"] != false {
		t.Fatal("jellyfin streams", streams)
	}

	// Off: nothing is written.
	sync()
	if err := a.debugLogs.readServers(t.Context()); err != nil {
		t.Fatal(err)
	}
	if entries := waitDebugEntries(t, a, token, "provider=jellyfin&transport=http"); len(entries) != 0 {
		t.Fatal("recorded while off", entries)
	}

	if w := apiRequest(a, "PUT", "/api/settings/debug-logging", token, map[string]any{"provider": "jellyfin", "transport": "http", "enabled": true}, nil); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	sync()
	entries := waitDebugEntries(t, a, token, "provider=jellyfin&transport=http&limit=200")
	if len(entries) == 0 || entries[0]["provider"] != "jellyfin" || entries[0]["server_id"] != float64(id) || entries[0]["status"] != float64(200) || entries[0]["body"] == "" {
		t.Fatal("entries", entries)
	}
	files, _ := os.ReadDir(filepath.Join(s.dataDir, debugLogDirectory))
	for _, f := range files {
		data, _ := os.ReadFile(filepath.Join(s.dataDir, debugLogDirectory, f.Name()))
		if strings.Contains(string(data), "fixture-secret") {
			t.Fatal("API key written to", f.Name())
		}
	}

	// Socket frames are recorded with their tokens removed.
	if w := apiRequest(a, "PUT", "/api/settings/debug-logging", token, map[string]any{"provider": "jellyfin", "transport": "websocket", "enabled": true}, nil); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	a.debugLogs.socketFrame(ManagedServer{ID: id, Name: "Fixture jellyfin", Type: "jellyfin"}, "received", []byte(`{"MessageType":"Sessions","Data":[{"UserName":"viewer"}],"AccessToken":"frame-secret"}`))
	frames := waitDebugEntries(t, a, token, "provider=jellyfin&transport=websocket")
	if len(frames) != 1 || strings.Contains(frames[0]["body"].(string), "frame-secret") || !strings.Contains(frames[0]["body"].(string), "viewer") {
		t.Fatal("frames", frames)
	}

	// An expired window stops recording without anyone switching it off.
	activityExec(t, s, "UPDATE settings SET value=? WHERE key='DEBUG_LOG_jellyfin-http'", time.Now().Add(-time.Minute).UTC().Format(time.RFC3339Nano))
	if err := a.debugLogs.load(t.Context()); err != nil {
		t.Fatal(err)
	}
	if a.debugLogs.on("jellyfin", "http") {
		t.Fatal("expired stream still on")
	}

	// Files: download by the names the log writes, nothing else.
	w = apiRequest(a, "GET", "/api/settings/debug-logging/files/jellyfin-http.log", token, nil, nil)
	if w.Code != 200 || !strings.Contains(w.Header().Get("Content-Disposition"), "attachment") || strings.Contains(w.Body.String(), "fixture-secret") {
		t.Fatal(w.Code, w.Header())
	}
	for _, name := range []string{"..%2Fmum.sqlite", "mum.sqlite", "jellyfin-http.log.4", "plex-http.log"} {
		if w := apiRequest(a, "GET", "/api/settings/debug-logging/files/"+name, token, nil, nil); w.Code != 404 {
			t.Fatal(name, w.Code)
		}
	}
	for _, body := range []map[string]any{{"provider": "plex", "transport": "http", "enabled": true}, {"provider": "jellyfin", "transport": "carrier", "enabled": true}, {"provider": "jellyfin", "transport": "http"}} {
		if w := apiRequest(a, "PUT", "/api/settings/debug-logging", token, body, nil); w.Code != 400 {
			t.Fatal(body, w.Code)
		}
	}

	member := plexDelegatedAdministrator(t, a, s, false)
	for _, request := range [][2]string{{"GET", "/api/settings/debug-logging"}, {"GET", "/api/settings/debug-logging/entries?provider=jellyfin&transport=http"}, {"GET", "/api/settings/debug-logging/files/jellyfin-http.log"}, {"DELETE", "/api/settings/debug-logging/files"}} {
		if w := apiRequest(a, request[0], request[1], member, nil, nil); w.Code != 403 {
			t.Fatal("non-administrator", request, w.Code)
		}
		if w := apiRequest(a, request[0], request[1], "", nil, nil); w.Code != 401 {
			t.Fatal("signed out", request, w.Code)
		}
	}

	w = apiRequest(a, "DELETE", "/api/settings/debug-logging/files", token, nil, nil)
	if w.Code != 200 || len(responseData(t, w)["files"].([]any)) != 0 {
		t.Fatal("clear", w.Code, w.Body.String())
	}
	var audits int
	if err := s.reader.QueryRow("SELECT count(*) FROM audit_events WHERE action LIKE 'debug_logging.%'").Scan(&audits); err != nil || audits != 4 {
		t.Fatal("audited actions", audits, err)
	}
}

// Files rotate past the size limit, keeping three older parts.
func TestDebugLogRotation(t *testing.T) {
	l := &debugPayloadLog{dir: t.TempDir(), files: map[string]*os.File{}}
	line := []byte(strings.Repeat("x", 1<<20) + "\n")
	l.mu.Lock()
	for range 30 {
		if err := l.appendLine("plex-http", line); err != nil {
			t.Fatal(err)
		}
	}
	for _, f := range l.files {
		_ = f.Close()
	}
	l.mu.Unlock()
	files, err := l.list()
	if err != nil || len(files) != 4 {
		t.Fatal(files, err)
	}
	for _, f := range files {
		if f.Size > debugLogFileBytes {
			t.Fatal("file over the limit", f)
		}
	}
	var decoded []debugLogFile
	if raw, _ := json.Marshal(files); json.Unmarshal(raw, &decoded) != nil || decoded[3].Part != 3 {
		t.Fatal(decoded)
	}
}
