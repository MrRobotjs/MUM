package mediabrowser

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"app/server/providers/provider"
)

// A user's profile picture is read from /Users/{id}/Images/Primary with the
// server's key; an ID that isn't a plain token is refused before any request,
// and a user without a picture is reported as having none.
func TestUserAvatarImage(t *testing.T) {
	var requests []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests = append(requests, r.URL.Path+"?"+r.URL.RawQuery+" "+r.Header.Get("X-Emby-Token"))
		if r.URL.Path != "/Users/abc123/Images/Primary" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "image/png")
		_, _ = w.Write([]byte("\x89PNG\r\n\x1a\nfixture"))
	}))
	t.Cleanup(server.Close)
	s := New(provider.Config{URL: server.URL, APIKey: "jf-key", Transport: provider.Transport{Client: server.Client()}}, false)
	kind, body, err := s.UserAvatarImage(t.Context(), "abc123")
	if err != nil || kind != "image/png" || len(body) == 0 {
		t.Fatal(kind, len(body), err)
	}
	if len(requests) != 1 || requests[0] != "/Users/abc123/Images/Primary?maxWidth=256&quality=90 jf-key" {
		t.Fatal(requests)
	}
	if _, _, err := s.UserAvatarImage(t.Context(), "../x"); err == nil || len(requests) != 1 {
		t.Fatal("bad ID requested", err, requests)
	}
	if _, _, err := s.UserAvatarImage(t.Context(), "nopicture"); !errors.Is(err, ErrNoAvatar) {
		t.Fatal("missing picture", err)
	}
}
