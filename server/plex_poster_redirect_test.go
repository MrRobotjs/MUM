package main

import (
	"io"
	"net/http"
	"strings"
	"testing"
)

func TestPlexPosterRedirectOnlyToApprovedHostWithoutCredentials(t *testing.T) {
	for _, tc := range []struct {
		target  string
		allowed bool
	}{
		{"https://images.plex.tv/fixture?image=123", true},
		{"http://images.plex.tv/fixture", false},
		{"https://images.plex.tv.evil.example/fixture", false},
		{"https://images.plex.tv:444/fixture", false},
		{"https://images.plex.tv/fixture?token=fixture-secret", false},
		{"https://images.plex.tv/fixture?token=fixture%252Dsecret", false},
		{"http://127.0.0.1/private", false},
	} {
		t.Run(tc.target, func(t *testing.T) {
			calls := 0
			p, err := newServerConnection(ProviderConfig{"plex", "http://plex.fixture", "fixture-secret"}, &http.Client{Transport: providerTransport(func(r *http.Request) (*http.Response, error) {
				calls++
				if calls == 1 {
					if r.Header.Get("X-Plex-Token") != "fixture-secret" {
						t.Error("missing Plex token")
					}
					return &http.Response{StatusCode: 302, Header: http.Header{"Location": {tc.target}}, Body: io.NopCloser(strings.NewReader("")), Request: r}, nil
				}
				if r.URL.Host != "images.plex.tv" || r.Header.Get("X-Plex-Token") != "" || r.Header.Get("Authorization") != "" || r.Header.Get("Cookie") != "" || r.Header.Get("Referer") != "" {
					t.Error("unsafe redirected request")
				}
				return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": {"image/png"}}, Body: io.NopCloser(strings.NewReader("fixture-image")), Request: r}, nil
			})})
			if err != nil {
				t.Fatal(err)
			}
			kind, body, err := p.catalogueImage(t.Context(), "123", "/library/metadata/123/thumb/7")
			if tc.allowed {
				if err != nil || kind != "image/png" || string(body) != "fixture-image" || calls != 2 {
					t.Fatal(kind, err, calls)
				}
			} else if err == nil || calls != 1 {
				t.Fatal("unapproved redirect followed", err, calls)
			}
		})
	}
}

func TestPlexPosterRedirectCannotReturnToPrivateOrigin(t *testing.T) {
	calls := 0
	p, err := newServerConnection(ProviderConfig{"plex", "http://plex.fixture", "fixture-secret"}, &http.Client{Transport: providerTransport(func(r *http.Request) (*http.Response, error) {
		calls++
		target := "https://images.plex.tv/fixture"
		if calls == 2 {
			target = "http://plex.fixture/private"
		}
		return &http.Response{StatusCode: 302, Header: http.Header{"Location": {target}}, Body: io.NopCloser(strings.NewReader("")), Request: r}, nil
	})})
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := p.catalogueImage(t.Context(), "123", "/library/metadata/123/thumb/7"); err == nil || calls != 2 {
		t.Fatal("redirect returned to private origin", err, calls)
	}
}
