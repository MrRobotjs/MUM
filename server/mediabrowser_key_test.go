package main

import (
	"net/http"
	"regexp"
)

var mediaBrowserTokenField = regexp.MustCompile(`^MediaBrowser .*Token="([^"]*)"$`)

// mediaBrowserKey is the API key a Jellyfin or Emby test server received:
// Emby's X-Emby-Token or Jellyfin's Authorization token.
func mediaBrowserKey(r *http.Request) string {
	if key := r.Header.Get("X-Emby-Token"); key != "" {
		return key
	}
	if m := mediaBrowserTokenField.FindStringSubmatch(r.Header.Get("Authorization")); m != nil {
		return m[1]
	}
	return ""
}
