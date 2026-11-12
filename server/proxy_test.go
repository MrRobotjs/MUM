package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strings"
	"testing"
)

// proxiedLogin sends a login as a browser at https://mum.example.com would,
// arriving from remote (a reverse proxy or a direct client).
func proxiedLogin(a *App, remote, forwardedFor, password string) *httptest.ResponseRecorder {
	body, _ := json.Marshal(map[string]string{"username": "owner", "password": password})
	r := httptest.NewRequest("POST", "http://127.0.0.1:5699/api/auth/login", bytes.NewReader(body))
	r.RemoteAddr = remote
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Origin", "https://mum.example.com")
	r.Header.Set("X-Forwarded-Proto", "https")
	r.Header.Set("X-Forwarded-Host", "mum.example.com")
	if forwardedFor != "" {
		r.Header.Set("X-Forwarded-For", forwardedFor)
	}
	w := httptest.NewRecorder()
	a.ServeHTTP(w, r)
	return w
}

func TestTrustedReverseProxyHTTPSLogin(t *testing.T) {
	a, _ := testApp(t)
	bootstrapOwner(t, a)
	a.TrustedProxies = []netip.Prefix{netip.MustParsePrefix("10.0.0.1/32")}
	w := proxiedLogin(a, "10.0.0.1:44000", "203.0.113.7", "a-strong-new-password")
	if w.Code != 200 {
		t.Fatal("proxied HTTPS login refused", w.Code, w.Body.String())
	}
	if cookie := w.Header().Get("Set-Cookie"); !strings.Contains(cookie, "mum_refresh=") || !strings.Contains(cookie, "Secure") {
		t.Fatal("refresh cookie not Secure behind an HTTPS proxy", cookie)
	}
	// The same headers from an address that is not a trusted proxy are ignored.
	if w := proxiedLogin(a, "198.51.100.9:1234", "203.0.113.7", "a-strong-new-password"); w.Code != 403 {
		t.Fatal("forwarded headers from an untrusted sender were honoured", w.Code)
	}
}

func TestTrustedProxyRateLimitsEachClient(t *testing.T) {
	a, _ := testApp(t)
	bootstrapOwner(t, a)
	a.TrustedProxies = []netip.Prefix{netip.MustParsePrefix("10.0.0.0/8")}
	for i := 0; i < 20; i++ {
		if w := proxiedLogin(a, "10.0.0.1:1", "203.0.113.7", "wrong-password-attempt"); w.Code != 401 {
			t.Fatal("attempt", i, w.Code, w.Body.String())
		}
	}
	if w := proxiedLogin(a, "10.0.0.1:1", "203.0.113.7", "wrong-password-attempt"); w.Code != http.StatusTooManyRequests {
		t.Fatal("client not limited", w.Code)
	}
	// A spoofed leading entry does not escape the limit: the rightmost address
	// not belonging to a trusted proxy identifies the client.
	if w := proxiedLogin(a, "10.0.0.1:1", "198.51.100.1, 203.0.113.7, 10.0.0.2", "wrong-password-attempt"); w.Code != http.StatusTooManyRequests {
		t.Fatal("spoofed X-Forwarded-For escaped the limit", w.Code)
	}
	// Another client behind the same proxy is unaffected.
	if w := proxiedLogin(a, "10.0.0.1:1", "203.0.113.8", "a-strong-new-password"); w.Code != 200 {
		t.Fatal("other client shared the limit", w.Code, w.Body.String())
	}
}
