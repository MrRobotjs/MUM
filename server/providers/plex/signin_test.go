package plex

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"
)

// A device never keeps a longer client timeout than 15 seconds, and never
// follows redirects with its device credentials.
func TestDeviceBoundsClientTimeoutAndRedirects(t *testing.T) {
	d, err := NewDevice(&http.Client{Timeout: time.Hour})
	if err != nil {
		t.Fatal(err)
	}
	if d.client.Timeout != 15*time.Second {
		t.Fatal("unbounded client timeout", d.client.Timeout)
	}
	if d.client.CheckRedirect == nil || d.client.CheckRedirect(nil, nil) != http.ErrUseLastResponse {
		t.Fatal("device client follows redirects")
	}
	if !d.Valid() {
		t.Fatal("new device identity is invalid")
	}
}

// Device identities, PINs and verified tokens are secrets: none of them is
// ever JSON-encoded.
func TestSignInSecretsAreNeverEncoded(t *testing.T) {
	d, err := NewDevice(nil)
	if err != nil {
		t.Fatal(err)
	}
	pin := PIN{ID: 42, Code: "pin-code-secret", Expires: time.Now(), ClientID: d.ClientID, AuthorizationURL: "https://app.plex.tv/auth#?code=pin-code-secret"}
	result := AuthenticationResult{Account: &AuthenticatedAccount{ID: "2", Username: "reader"}, AuthToken: "token-secret"}
	for _, value := range []any{d, pin, result} {
		data, err := json.Marshal(value)
		if err != nil {
			t.Fatal(err)
		}
		for _, secret := range []string{d.ClientID, d.KeyID, string(d.PrivateKey), "pin-code-secret", "token-secret"} {
			if strings.Contains(string(data), secret) {
				t.Fatalf("secret encoded in %T: %s", value, data)
			}
		}
	}
}
