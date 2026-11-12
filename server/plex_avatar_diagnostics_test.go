package main

import (
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"
)

func TestPlexAvatarRedirectDiagnosticsExcludeUntrustedDetails(t *testing.T) {
	for _, tc := range []struct {
		name, target, code string
		wantCalls          int
	}{
		{"insecure_scheme", "http://plex.tv/private-detail?token=secret", "AVATAR_REDIRECT_INSECURE_SCHEME", 1},
		{"unapproved_host", "https://untrusted.invalid/private-detail?token=secret", "AVATAR_REDIRECT_UNAPPROVED_HOST", 1},
		{"alternate_port", "https://plex.tv:444/private-detail", "AVATAR_REDIRECT_UNAPPROVED_HOST", 1},
		{"invalid_target", "https://user:secret@plex.tv/private-detail", "AVATAR_REDIRECT_INVALID_TARGET", 1},
		{"fragment", "https://plex.tv/private-detail#secret", "AVATAR_REDIRECT_INVALID_TARGET", 1},
		{"assets_insecure_scheme", "http://assets.plex.tv/private-detail", "AVATAR_REDIRECT_INSECURE_SCHEME", 1},
		{"assets_alternate_port", "https://assets.plex.tv:444/private-detail", "AVATAR_REDIRECT_UNAPPROVED_HOST", 1},
		{"assets_foreign_suffix", "https://assets.plex.tv.untrusted.invalid/private-detail", "AVATAR_REDIRECT_UNAPPROVED_HOST", 1},
		{"too_many_redirects", "https://plex.tv/avatars/loop?token=secret", "AVATAR_REDIRECT_TOO_MANY_REDIRECTS", 4},
	} {
		t.Run(tc.name, func(t *testing.T) {
			calls := 0
			p, err := newMediaProvider(ProviderConfig{"plex", "http://fixture.test", "fixture-secret"}, &http.Client{Transport: providerTransport(func(r *http.Request) (*http.Response, error) {
				calls++
				if r.URL.Scheme != "https" || r.URL.Host != "plex.tv" || r.URL.User != nil || r.Header.Get("X-Plex-Token") != "" {
					t.Fatal("unsafe redirect reached transport")
				}
				return &http.Response{StatusCode: 302, Header: http.Header{"Location": {tc.target}}, Body: io.NopCloser(strings.NewReader("")), Request: r}, nil
			})})
			if err != nil {
				t.Fatal(err)
			}
			_, _, err = p.(*jsonProvider).plexActivityAvatar(t.Context(), "https://plex.tv/users/fixture-user/avatar")
			var classified *plexAvatarError
			if !errors.As(err, &classified) || classified.Code != tc.code || classified.Status != 0 || calls != tc.wantCalls {
				t.Fatalf("unexpected safe rejection: %v, calls=%d", err, calls)
			}
			if classified.Error() != tc.code {
				t.Fatal("diagnostic contains untrusted details")
			}
		})
	}
}

func TestPlexAvatarFollowsAssetsRedirectWithoutSourceCredentials(t *testing.T) {
	for _, avatar := range []string{"https://plex.tv/users/fixture-user/avatar", "/accounts/42/thumb"} {
		t.Run(avatar, func(t *testing.T) {
			calls := 0
			p, err := newMediaProvider(ProviderConfig{"plex", "http://fixture.test", "fixture-secret"}, &http.Client{Transport: providerTransport(func(r *http.Request) (*http.Response, error) {
				calls++
				if calls == 1 {
					return &http.Response{StatusCode: 302, Header: http.Header{"Location": {"https://assets.plex.tv/users/fixture-avatar.png"}}, Body: io.NopCloser(strings.NewReader("")), Request: r}, nil
				}
				if r.URL.Scheme != "https" || r.URL.Host != "assets.plex.tv" || len(r.Header) != 1 || r.Header.Get("Accept") != "image/*" {
					t.Fatal("source credentials or unrelated headers reached assets origin")
				}
				return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": {"image/png"}}, Body: io.NopCloser(strings.NewReader("fixture PNG")), Request: r}, nil
			})})
			if err != nil {
				t.Fatal(err)
			}
			kind, body, err := p.(*jsonProvider).plexActivityAvatar(t.Context(), avatar)
			if err != nil || kind != "image/png" || string(body) != "fixture PNG" || calls != 2 {
				t.Fatalf("Plex assets redirect failed: %v, calls=%d", err, calls)
			}
		})
	}
}
