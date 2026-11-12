package main

import (
	"encoding/base64"
	"io"
	"net/http"
	"strings"
	"testing"
)

func TestStreamingMapSettings(t *testing.T) {
	a, s, owner, delegated, user := roleReadFixture(t)
	read := func() map[string]any {
		return responseData(t, apiRequest(a, "GET", "/api/settings/streaming-map", owner, nil, nil))
	}
	base := read()
	if base["configured"] != false {
		t.Fatal(base)
	}
	body := map[string]any{"revision": base["revision"], "api_key": "fixture-map-key"}
	w := apiRequest(a, "PUT", "/api/settings/streaming-map", owner, body, nil)
	if w.Code != 200 || strings.Contains(w.Body.String(), "fixture-map-key") {
		t.Fatal(w.Code, w.Body.String())
	}
	if read()["configured"] != true {
		t.Fatal("not persisted")
	}
	if w = apiRequest(a, "PUT", "/api/settings/streaming-map", owner, body, nil); w.Code != 409 {
		t.Fatal("stale edit", w.Code)
	}
	body["revision"] = read()["revision"]
	body["api_key"] = "bad&key"
	if w = apiRequest(a, "PUT", "/api/settings/streaming-map", owner, body, nil); w.Code != 400 {
		t.Fatal("bad key", w.Code)
	}
	activityExec(t, s, "DELETE FROM admin_privileges WHERE user_uuid=?", user)
	if w = apiRequest(a, "PUT", "/api/settings/streaming-map", delegated, body, nil); w.Code != 403 {
		t.Fatal("authority", w.Code)
	}
	body["api_key"] = ""
	if w = apiRequest(a, "PUT", "/api/settings/streaming-map", owner, body, nil); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	if read()["configured"] != false {
		t.Fatal("not removed")
	}
	if w = apiRequest(a, "GET", "/api/activity/map-tiles/dark/2/1/1", owner, nil, nil); w.Code != 409 {
		t.Fatal("missing key", w.Code)
	}
	if w = apiRequest(a, "GET", "/api/activity/map-tiles/dark/2/1/1", "", nil, nil); w.Code != 401 {
		t.Fatal("anonymous tile", w.Code)
	}
}

func TestStreamingMapTileBoundsSecretsAndDeliveryFence(t *testing.T) {
	a, s, owner, _, _ := roleReadFixture(t)
	save := func(key string) {
		t.Helper()
		base := responseData(t, apiRequest(a, "GET", "/api/settings/streaming-map", owner, nil, nil))
		w := apiRequest(a, "PUT", "/api/settings/streaming-map", owner, map[string]any{"revision": base["revision"], "api_key": key}, nil)
		if w.Code != 200 {
			t.Fatal(w.Code, w.Body.String())
		}
	}
	save("fixture-map-key")
	png, _ := base64.StdEncoding.DecodeString("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aM90AAAAASUVORK5CYII=")
	calls := 0
	mode := "ok"
	a.ProviderHTTP = &http.Client{Transport: providerTransport(func(r *http.Request) (*http.Response, error) {
		calls++
		if r.URL.Scheme != "https" || r.URL.Host != "basemaps.cartocdn.com" || r.URL.Path != "/dark_all/2/1/1.png" || r.URL.Query().Get("key") != "fixture-map-key" || r.Header.Get("Authorization") != "" || r.Header.Get("Cookie") != "" {
			t.Fatal("unexpected tile request")
		}
		code, body := 200, string(png)
		switch mode {
		case "redirect":
			code = 302
		case "rejected":
			code = 403
			body = "secret-upstream-body"
		case "html":
			body = "<html>not a tile</html>"
		case "large":
			body = strings.Repeat("x", (1<<20)+1)
		case "changed":
			save("")
		case "logout":
			activityExec(t, s, "DELETE FROM app_sessions")
		}
		return &http.Response{StatusCode: code, Header: http.Header{"Location": {"https://evil.test/"}}, Body: io.NopCloser(strings.NewReader(body)), Request: r}, nil
	})}
	for _, path := range []string{"dark/13/1/1", "dark/2/4/1", "dark/2/1/4", "other/2/1/1", "dark/2/-1/1", "dark/02/1/1"} {
		w := apiRequest(a, "GET", "/api/activity/map-tiles/"+path, owner, nil, nil)
		if w.Code != 400 {
			t.Fatal(path, w.Code)
		}
	}
	if calls != 0 {
		t.Fatal("invalid coordinates contacted upstream")
	}
	for _, value := range []string{"ok", "redirect", "rejected", "html", "large", "changed"} {
		mode = value
		w := apiRequest(a, "GET", "/api/activity/map-tiles/dark/2/1/1", owner, nil, nil)
		want := 502
		if mode == "ok" {
			want = 200
		}
		if mode == "changed" {
			want = 409
		}
		if w.Code != want || strings.Contains(w.Body.String(), "fixture-map-key") || strings.Contains(w.Body.String(), "secret-upstream-body") {
			t.Fatal(mode, w.Code)
		}
		if mode == "ok" && w.Header().Get("Content-Type") != "image/png" {
			t.Fatal("not a PNG")
		}
	}
	var details string
	if err := s.reader.QueryRow("SELECT details FROM audit_events WHERE action='settings.streaming-map.save' LIMIT 1").Scan(&details); err != nil || strings.Contains(details, "fixture-map-key") {
		t.Fatal("sensitive audit", err)
	}
	save("fixture-map-key")
	mode = "logout"
	if w := apiRequest(a, "GET", "/api/activity/map-tiles/dark/2/1/1", owner, nil, nil); w.Code != 403 {
		t.Fatal("post-I/O logout", w.Code)
	}
}
