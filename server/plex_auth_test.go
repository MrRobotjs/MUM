package main

import (
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

const plexFixtureToken = "eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiI5OTkifQ.c2lnbmF0dXJl"
const plexFixtureCode = "strongAuthorizationCode123456"

type plexAuthFixture struct {
	server                                      *httptest.Server
	client                                      *http.Client
	mu                                          sync.Mutex
	beforeAccount                               func()
	mode, clientID, keyID                       string
	public                                      ed25519.PublicKey
	creates, polls, accounts, refreshes, nonces int
}

func (f *plexAuthFixture) verifyJWT(t *testing.T, value, nonce string) {
	t.Helper()
	parts := strings.Split(value, ".")
	if len(parts) != 3 {
		t.Error("missing signed device assertion")
		return
	}
	signature, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil || !ed25519.Verify(f.public, []byte(parts[0]+"."+parts[1]), signature) {
		t.Error("invalid device signature")
	}
	h, _ := base64.RawURLEncoding.DecodeString(parts[0])
	c, _ := base64.RawURLEncoding.DecodeString(parts[1])
	var header struct {
		Algorithm string `json:"alg"`
		KeyID     string `json:"kid"`
		Type      string `json:"typ"`
	}
	var claims struct {
		Audience string `json:"aud"`
		Issuer   string `json:"iss"`
		Issued   int64  `json:"iat"`
		Expires  int64  `json:"exp"`
		Nonce    string `json:"nonce"`
		Scope    string `json:"scope"`
	}
	if json.Unmarshal(h, &header) != nil || json.Unmarshal(c, &claims) != nil {
		t.Error("invalid JWT JSON")
	}
	if header.Algorithm != "EdDSA" || header.KeyID != f.keyID || header.Type != "JWT" || claims.Audience != "plex.tv" || claims.Issuer != f.clientID || claims.Nonce != nonce || claims.Expires-claims.Issued != 60 || claims.Issued > time.Now().Unix()+2 || claims.Expires <= time.Now().Unix() || claims.Scope != "username,email,restricted,anonymous" {
		t.Error("invalid assertion headers or bounded claims")
	}
}
func newPlexAuthFixture(t *testing.T, mode string) *plexAuthFixture {
	t.Helper()
	f := &plexAuthFixture{mode: mode}
	f.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		if r.Header.Get("Accept") != "application/json" || r.Header.Get("X-Plex-Product") != "MUM" || r.Header.Get("X-Plex-Client-Identifier") == "" {
			t.Error("missing Plex client headers")
		}
		w.Header().Set("Content-Type", "application/json")
		if f.mode == "malformed-json" {
			fmt.Fprint(w, "not-json")
			return
		}
		if f.mode == "oversized-response" {
			fmt.Fprint(w, strings.Repeat("x", (1<<20)+1))
			return
		}
		if f.mode == "redirect" {
			http.Redirect(w, r, "https://forbidden.invalid/private", 302)
			return
		}
		switch r.Method + " " + r.URL.Path {
		case "POST /api/v2/pins":
			if r.URL.RawQuery != "" || r.Header.Get("X-Plex-Token") != "" || r.Header.Get("Content-Type") != "application/json" {
				t.Error("unexpected PIN credentials/encoding")
			}
			var raw struct {
				Strong bool `json:"strong"`
				JWK    struct {
					Type      string `json:"kty"`
					Curve     string `json:"crv"`
					X         string `json:"x"`
					KeyID     string `json:"kid"`
					Algorithm string `json:"alg"`
				} `json:"jwk"`
			}
			if json.NewDecoder(r.Body).Decode(&raw) != nil {
				t.Error("malformed JWK request")
			}
			f.clientID = r.Header.Get("X-Plex-Client-Identifier")
			f.keyID = raw.JWK.KeyID
			pub, err := base64.RawURLEncoding.DecodeString(raw.JWK.X)
			f.public = ed25519.PublicKey(pub)
			if !raw.Strong || raw.JWK.Type != "OKP" || raw.JWK.Curve != "Ed25519" || raw.JWK.Algorithm != "EdDSA" || len(pub) != ed25519.PublicKeySize || err != nil || f.keyID == "" {
				t.Error("unsafe PIN/JWK request")
			}
			f.creates++
			code := plexFixtureCode
			expires := time.Now().Add(10 * time.Minute).UTC().Format(time.RFC3339)
			if f.mode == "short-code" {
				code = "1234"
			}
			if f.mode == "expired-create" {
				expires = time.Now().Add(-time.Minute).UTC().Format(time.RFC3339)
			}
			if f.mode == "create-error" {
				http.Error(w, "private-cloud-error", 503)
				return
			}
			json.NewEncoder(w).Encode(map[string]any{"id": 42, "code": code, "expiresAt": expires, "authToken": nil})
		case "GET /api/v2/pins/42":
			if len(r.URL.Query()) != 1 || r.Header.Get("X-Plex-Token") != "" || r.Header.Get("X-Plex-Client-Identifier") != f.clientID {
				t.Error("PIN poll binding/authentication mismatch")
			}
			f.verifyJWT(t, r.URL.Query().Get("deviceJWT"), "")
			f.polls++
			var token any = plexFixtureToken
			if f.mode == "pending" {
				token = nil
			}
			if f.mode == "static-token" {
				token = "old-static-token"
			}
			row := map[string]any{"id": 42, "code": plexFixtureCode, "authToken": token}
			if f.mode == "wrong-client" {
				row["clientIdentifier"] = "different-device"
			}
			switch f.mode {
			case "wrong-pin":
				row["id"] = 43
			case "wrong-code":
				row["code"] = "anotherStrongCode123456"
			case "missing-token":
				delete(row, "authToken")
			case "token-number":
				row["authToken"] = 12
			}
			if f.mode == "poll-error" {
				http.Error(w, "private-cloud-error", 503)
				return
			}
			json.NewEncoder(w).Encode(row)
		case "GET /api/v2/user":
			f.accounts++
			if f.beforeAccount != nil {
				f.beforeAccount()
			}
			if r.Header.Get("X-Plex-Token") != plexFixtureToken || r.URL.RawQuery != "" {
				t.Error("account token must be header-only")
			}
			if f.mode == "account-error" {
				http.Error(w, "private-cloud-error", 401)
				return
			}
			row := map[string]any{"id": 2, "username": "reader", "email": "reader@example.invalid", "restricted": false, "anonymous": false, "authToken": "never-serialize-cloud-secret"}
			switch f.mode {
			case "account-mismatch":
				row["id"] = 3
			case "restricted":
				row["restricted"] = true
			case "anonymous":
				row["anonymous"] = true
			case "missing-restriction":
				delete(row, "restricted")
			case "missing-username":
				delete(row, "username")
			case "bad-id":
				row["id"] = 0
			}
			json.NewEncoder(w).Encode(row)
		case "GET /api/v2/auth/nonce":
			if r.Header.Get("X-Plex-Token") != "" || r.URL.RawQuery != "" {
				t.Error("nonce must not send credentials")
			}
			f.nonces++
			nonce := "fixture-nonce-1234567890123456"
			if f.mode == "bad-nonce" {
				nonce = "bad"
			}
			json.NewEncoder(w).Encode(map[string]string{"nonce": nonce})
		case "POST /api/v2/auth/token":
			var body struct {
				JWT string `json:"jwt"`
			}
			if json.NewDecoder(r.Body).Decode(&body) != nil {
				t.Error("missing device JWT")
			}
			f.verifyJWT(t, body.JWT, "fixture-nonce-1234567890123456")
			f.refreshes++
			if f.mode == "refresh-error" {
				http.Error(w, "private-cloud-error", 503)
				return
			}
			json.NewEncoder(w).Encode(map[string]string{"auth_token": plexFixtureToken})
		default:
			t.Errorf("unexpected Plex auth request %s %s", r.Method, r.URL.Path)
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(f.server.Close)
	f.client = f.server.Client()
	base := f.client.Transport
	f.client.Transport = providerTransport(func(r *http.Request) (*http.Response, error) {
		if r.URL.Scheme != "https" || (r.URL.Host != "clients.plex.tv" && r.URL.Host != "plex.tv") {
			t.Error("unexpected cloud destination")
			return nil, fmt.Errorf("blocked")
		}
		if (r.URL.Path == "/api/v2/user") != (r.URL.Host == "plex.tv") {
			t.Error("incorrect fixed cloud API host")
		}
		copy := r.Clone(r.Context())
		u := *r.URL
		copy.URL = &u
		copy.URL.Scheme = "http"
		copy.URL.Host = strings.TrimPrefix(f.server.URL, "http://")
		return base.RoundTrip(copy)
	})
	return f
}
func TestPlexDevicePINAndBoundRefresh(t *testing.T) {
	f := newPlexAuthFixture(t, "")
	p, err := newPlexDeviceAuth(f.client)
	if err != nil {
		t.Fatal(err)
	}
	pin, err := p.beginPIN(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(pin.authorizationURL, "https://app.plex.tv/auth#?") || strings.Contains(pin.authorizationURL, "forwardUrl") || !strings.Contains(pin.authorizationURL, "code="+plexFixtureCode) {
		t.Fatal("unsafe authorization destination")
	}
	result, err := p.pollPIN(t.Context(), pin)
	if err != nil || result.Pending || result.Account == nil || result.Account.ID != "2" || result.authToken != plexFixtureToken {
		t.Fatal(result, err)
	}
	// The token fixture claims a different subject; identity comes from the
	// authenticated account endpoint rather than an unverified JWT payload.
	refreshed, err := p.refreshAccount(t.Context(), "2")
	if err != nil || refreshed.Account.ID != "2" {
		t.Fatal(refreshed, err)
	}
	for _, value := range []any{p, pin, result, refreshed} {
		data, err := json.Marshal(value)
		if err != nil {
			t.Fatal(err)
		}
		for _, secret := range []string{plexFixtureToken, plexFixtureCode, string(p.privateKey), "never-serialize-cloud-secret"} {
			if strings.Contains(string(data), secret) {
				t.Fatal("private protocol material serialized")
			}
		}
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.creates != 1 || f.polls != 1 || f.accounts != 2 || f.refreshes != 1 || f.nonces != 1 {
		t.Fatal("unexpected protocol replay")
	}
	// Plex invitations share the server (plex_invitation_share.go); there is no
	// recorded-account recovery for Plex.
	if supportsRecordedRecovery("plex") {
		t.Fatal("Plex has no recorded-account recovery")
	}
}
func TestPlexPINPendingIsNotAccountProof(t *testing.T) {
	f := newPlexAuthFixture(t, "pending")
	p, _ := newPlexDeviceAuth(f.client)
	pin, err := p.beginPIN(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	result, err := p.pollPIN(t.Context(), pin)
	if err != nil || !result.Pending || result.Account != nil || result.authToken != "" {
		t.Fatal(result, err)
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.accounts != 0 {
		t.Fatal("unapproved PIN became an identity")
	}
}
func TestPlexAuthRejectsUnsafeResponsesWithoutReplay(t *testing.T) {
	for _, mode := range []string{"short-code", "expired-create", "create-error", "wrong-pin", "wrong-code", "missing-token", "token-number", "static-token", "poll-error", "account-error", "restricted", "anonymous", "missing-restriction", "missing-username", "bad-id", "wrong-client"} {
		t.Run(mode, func(t *testing.T) {
			f := newPlexAuthFixture(t, mode)
			p, _ := newPlexDeviceAuth(f.client)
			pin, err := p.beginPIN(t.Context())
			if err == nil {
				_, err = p.pollPIN(t.Context(), pin)
			}
			if err == nil || strings.Contains(err.Error(), "private-cloud-error") {
				t.Fatal("unsafe/unsanitized outcome", err)
			}
			f.mu.Lock()
			defer f.mu.Unlock()
			if f.creates != 1 || f.polls > 1 || f.accounts > 1 {
				t.Fatal("authentication mutation replayed")
			}
		})
	}
}
func TestPlexRefreshCannotSwitchIdentity(t *testing.T) {
	for _, mode := range []string{"account-mismatch", "bad-nonce", "refresh-error"} {
		t.Run(mode, func(t *testing.T) {
			f := newPlexAuthFixture(t, "")
			p, _ := newPlexDeviceAuth(f.client)
			if _, err := p.beginPIN(t.Context()); err != nil {
				t.Fatal(err)
			}
			f.mu.Lock()
			f.mode = mode
			f.mu.Unlock()
			if _, err := p.refreshAccount(t.Context(), "2"); err == nil || strings.Contains(err.Error(), "private-cloud-error") {
				t.Fatal(err)
			}
			f.mu.Lock()
			defer f.mu.Unlock()
			if f.refreshes > 1 || f.accounts > 1 {
				t.Fatal("refresh replayed")
			}
		})
	}
}
func TestPlexAuthExpiryBindingCancellationAndRedirects(t *testing.T) {
	f := newPlexAuthFixture(t, "")
	p, _ := newPlexDeviceAuth(f.client)
	pin, err := p.beginPIN(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	other, _ := newPlexDeviceAuth(f.client)
	if _, err := other.pollPIN(t.Context(), pin); err == nil {
		t.Fatal("PIN accepted by a different device")
	}
	expired := pin
	expired.expires = time.Now().Add(-time.Second)
	if _, err := p.pollPIN(t.Context(), expired); err == nil {
		t.Fatal("expired local PIN accepted")
	}
	if _, err := p.refreshAccount(t.Context(), "02"); err == nil {
		t.Fatal("noncanonical account accepted")
	}
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if _, err := p.pollPIN(ctx, pin); err == nil {
		t.Fatal("canceled request accepted")
	}
	f.mu.Lock()
	polls := f.polls
	f.mu.Unlock()
	if polls != 0 {
		t.Fatal("invalid local challenge contacted cloud")
	}
	f.mu.Lock()
	f.mode = "redirect"
	f.mu.Unlock()
	if _, err := p.beginPIN(t.Context()); err == nil || strings.Contains(err.Error(), "forbidden.invalid") {
		t.Fatal("redirect followed or leaked", err)
	}
}
func TestPlexDeviceAssertionURLNeverLeaksThroughTransportError(t *testing.T) {
	p, err := newPlexDeviceAuth(&http.Client{Transport: providerTransport(func(r *http.Request) (*http.Response, error) {
		return nil, fmt.Errorf("private transport URL: %s", r.URL.String())
	})})
	if err != nil {
		t.Fatal(err)
	}
	pin := plexPIN{42, plexFixtureCode, time.Now().Add(time.Minute), p.clientID, ""}
	_, err = p.pollPIN(t.Context(), pin)
	if err == nil || strings.Contains(err.Error(), "deviceJWT") || strings.Contains(err.Error(), "private") {
		t.Fatal("transport assertion URL leaked", err)
	}
}

func TestPlexAuthResponseBoundsAndDeviceLifetime(t *testing.T) {
	for _, mode := range []string{"malformed-json", "oversized-response"} {
		t.Run(mode, func(t *testing.T) {
			f := newPlexAuthFixture(t, mode)
			p, _ := newPlexDeviceAuth(f.client)
			if _, err := p.beginPIN(t.Context()); err == nil {
				t.Fatal("unbounded or invalid JSON accepted")
			}
		})
	}
	p, err := newPlexDeviceAuth(&http.Client{Timeout: time.Hour})
	if err != nil {
		t.Fatal(err)
	}
	if p.client.Timeout != 15*time.Second {
		t.Fatal("unbounded client timeout")
	}
	// Token syntax alone cannot supply a valid account proof; cloud verification
	// remains mandatory, and static opaque tokens have no fallback here.
	for _, token := range []string{"opaque-token", "a.b.c", "a..b", strings.Repeat("x", 16385)} {
		if plexJWTShape(token) {
			t.Fatal("invalid JWT envelope accepted")
		}
	}
}
