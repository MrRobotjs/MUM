package mediabrowser

import (
	"net/http"
	"regexp"
	"testing"

	"app/server/providers/provider"
)

var tokenField = regexp.MustCompile(`^MediaBrowser .*Token="([^"]*)"$`)

// requestKey is the API key a request carried: Emby's X-Emby-Token or
// Jellyfin's Authorization token.
func requestKey(r *http.Request) string {
	if key := r.Header.Get("X-Emby-Token"); key != "" {
		return key
	}
	if m := tokenField.FindStringSubmatch(r.Header.Get("Authorization")); m != nil {
		return m[1]
	}
	return ""
}

// Jellyfin gets the key in the standard Authorization header (Jellyfin 12
// ignores X-Emby-Token); Emby keeps X-Emby-Token. A key that would break the
// header is not sent.
func TestKeyHeaders(t *testing.T) {
	jellyfin, emby := http.Header{}, http.Header{}
	New(provider.Config{URL: "http://jf", APIKey: "jf-key"}, false).authorize(jellyfin)
	New(provider.Config{URL: "http://emby", APIKey: "emby-key"}, true).authorize(emby)
	if jellyfin.Get("X-Emby-Token") != "" || jellyfin.Get("Authorization") != `MediaBrowser Client="MUM", Device="MUM", DeviceId="mum-server", Version="1", Token="jf-key"` {
		t.Fatal("jellyfin", jellyfin)
	}
	if emby.Get("X-Emby-Token") != "emby-key" || emby.Get("Authorization") != "" {
		t.Fatal("emby", emby)
	}
	if New(provider.Config{URL: "http://jf", APIKey: `bad"key`}, false).keyAuthorization() != "" {
		t.Fatal("quote in key sent")
	}
}
