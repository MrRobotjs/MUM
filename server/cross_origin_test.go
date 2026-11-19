package main

import (
	"bytes"
	"encoding/json"
	"net/http/httptest"
	"testing"
)

// Behind an HTTPS reverse proxy that MUM wasn't told to trust, a browser's
// own sign-in still works: the page and MUM share a host, and only the scheme
// differs between the browser (https) and the proxy's connection (http).
// Requests from another site are refused whether the browser says so with
// Sec-Fetch-Site or only sends Origin; tools that send neither are allowed.
func TestCrossOriginProtection(t *testing.T) {
	a, _ := testApp(t)
	bootstrapOwner(t, a)
	login := func(host string, headers map[string]string) int {
		body, _ := json.Marshal(map[string]string{"username": "owner", "password": "a-strong-new-password"})
		r := httptest.NewRequest("POST", "http://"+host+"/api/auth/login", bytes.NewReader(body))
		r.RemoteAddr = "172.25.0.1:50000"
		r.Header.Set("Content-Type", "application/json")
		for name, value := range headers {
			r.Header.Set(name, value)
		}
		w := httptest.NewRecorder()
		a.ServeHTTP(w, r)
		return w.Code
	}
	allowed := map[string]map[string]string{
		"proxied https page, same host":       {"Origin": "https://mum.example.com", "Sec-Fetch-Site": "same-origin"},
		"proxied https page, Origin only":     {"Origin": "https://mum.example.com"},
		"typed address or bookmark":           {"Sec-Fetch-Site": "none"},
		"a tool that sends no browser header": {},
	}
	for name, headers := range allowed {
		if code := login("mum.example.com", headers); code != 200 {
			t.Fatal(name, "refused", code)
		}
	}
	refused := map[string]map[string]string{
		"another site":                         {"Origin": "https://evil.invalid", "Sec-Fetch-Site": "cross-site"},
		"another site, Origin only":            {"Origin": "https://evil.invalid"},
		"a sibling subdomain":                  {"Origin": "https://other.example.com", "Sec-Fetch-Site": "same-site"},
		"cross-site without Origin":            {"Sec-Fetch-Site": "cross-site"},
		"same host name claimed, other site":   {"Origin": "https://mum.example.com", "Sec-Fetch-Site": "cross-site"},
		"Origin naming another host, no fetch": {"Origin": "https://mum.example.com.evil.invalid"},
	}
	for name, headers := range refused {
		if code := login("mum.example.com", headers); code != 403 {
			t.Fatal(name, "admitted", code)
		}
	}
}
