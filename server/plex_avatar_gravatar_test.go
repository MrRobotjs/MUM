package main

import (
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"
)

// Plex serves pictures of accounts without an uploaded photo through Gravatar.
func TestPlexAvatarFollowsGravatarRedirectWithoutCredentials(t *testing.T) {
	for _, avatar := range []string{"https://plex.tv/users/fixture-user/avatar?c=1", "/accounts/42/thumb"} {
		t.Run(avatar, func(t *testing.T) {
			calls := 0
			p, err := newServerConnection(ProviderConfig{"plex", "http://fixture.test", "fixture-secret"}, &http.Client{Transport: providerTransport(func(r *http.Request) (*http.Response, error) {
				calls++
				if calls == 1 {
					return &http.Response{StatusCode: 302, Header: http.Header{"Location": {"https://secure.gravatar.com/avatar/0123456789abcdef?d=https%3A%2F%2Fplex.tv%2Favatars%2Fdefault.png"}}, Body: io.NopCloser(strings.NewReader("")), Request: r}, nil
				}
				if r.URL.Scheme != "https" || r.URL.Host != "secure.gravatar.com" || len(r.Header) != 1 || r.Header.Get("Accept") != "image/*" {
					t.Fatal("credentials or unrelated headers reached Gravatar", r.URL.Host, r.Header)
				}
				return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": {"image/jpeg"}}, Body: io.NopCloser(strings.NewReader("jpeg")), Request: r}, nil
			})})
			if err != nil {
				t.Fatal(err)
			}
			kind, body, err := p.activityAvatar(t.Context(), avatar)
			if err != nil || kind != "image/jpeg" || string(body) != "jpeg" || calls != 2 {
				t.Fatalf("Gravatar avatar not served: %v %q %d", err, kind, calls)
			}
		})
	}
}

func TestPlexAvatarRejectsGravatarLookalikesAndRecordsOnlyTheDomain(t *testing.T) {
	for _, tc := range []struct{ target, code, domain string }{
		{"http://secure.gravatar.com/avatar/x", "AVATAR_REDIRECT_INSECURE_SCHEME", "gravatar.com"},
		{"https://secure.gravatar.com.untrusted.example/avatar/x?token=secret", "AVATAR_REDIRECT_UNAPPROVED_HOST", "untrusted.example"},
		{"https://secure.gravatar.com:444/avatar/x", "AVATAR_REDIRECT_UNAPPROVED_HOST", "gravatar.com"},
		{"https://192-168-1-5.0123abcd.plex.direct:32400/photo?X-Plex-Token=secret", "AVATAR_REDIRECT_UNAPPROVED_HOST", "plex.direct"},
		{"https://10.0.0.5/photo", "AVATAR_REDIRECT_UNAPPROVED_HOST", "ip-address"},
	} {
		t.Run(tc.target, func(t *testing.T) {
			p, err := newServerConnection(ProviderConfig{"plex", "http://fixture.test", "fixture-secret"}, &http.Client{Transport: providerTransport(func(r *http.Request) (*http.Response, error) {
				if r.URL.Host != "plex.tv" {
					t.Fatal("rejected redirect reached transport")
				}
				return &http.Response{StatusCode: 302, Header: http.Header{"Location": {tc.target}}, Body: io.NopCloser(strings.NewReader("")), Request: r}, nil
			})})
			if err != nil {
				t.Fatal(err)
			}
			_, _, err = p.activityAvatar(t.Context(), "https://plex.tv/users/fixture-user/avatar")
			var classified *plexAvatarError
			if !errors.As(err, &classified) || classified.Code != tc.code || classified.Domain != tc.domain {
				t.Fatalf("got %+v", classified)
			}
			// The error text stays a static code; the domain is a separate log field.
			if classified.Error() != tc.code {
				t.Fatal("diagnostic text contains upstream details")
			}
		})
	}
}

func TestPlexAvatarRecordsRejectedContentType(t *testing.T) {
	p, err := newServerConnection(ProviderConfig{"plex", "http://fixture.test", "fixture-secret"}, &http.Client{Transport: providerTransport(func(r *http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": {"text/html; charset=utf-8"}}, Body: io.NopCloser(strings.NewReader("<html>")), Request: r}, nil
	})})
	if err != nil {
		t.Fatal(err)
	}
	_, _, err = p.activityAvatar(t.Context(), "https://plex.tv/users/fixture-user/avatar")
	var classified *plexAvatarError
	if !errors.As(err, &classified) || classified.Code != "AVATAR_RESPONSE_INVALID" || classified.ContentType != "text/html" {
		t.Fatalf("got %+v", classified)
	}
}

// Gravatar serves a missing photo's fallback (Plex's default letter avatar)
// through the WordPress image CDN: plex.tv -> Gravatar -> i0.wp.com.
func TestPlexAvatarFollowsGravatarFallbackThroughWordPressCDN(t *testing.T) {
	hops := []string{"https://secure.gravatar.com/avatar/0123456789abcdef?d=https%3A%2F%2Fplex.tv%2Favatars%2Fdefault.png", "https://i0.wp.com/plex.tv/avatars/default.png"}
	calls := 0
	p, err := newServerConnection(ProviderConfig{"plex", "http://fixture.test", "fixture-secret"}, &http.Client{Transport: providerTransport(func(r *http.Request) (*http.Response, error) {
		calls++
		if calls > 1 && (len(r.Header) != 1 || r.Header.Get("Accept") != "image/*") {
			t.Fatal("credentials or unrelated headers reached a CDN hop", r.URL.Host)
		}
		if calls <= len(hops) {
			return &http.Response{StatusCode: 302, Header: http.Header{"Location": {hops[calls-1]}}, Body: io.NopCloser(strings.NewReader("")), Request: r}, nil
		}
		if r.URL.Host != "i0.wp.com" {
			t.Fatal("unexpected final host", r.URL.Host)
		}
		return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": {"image/png"}}, Body: io.NopCloser(strings.NewReader("png")), Request: r}, nil
	})})
	if err != nil {
		t.Fatal(err)
	}
	kind, _, err := p.activityAvatar(t.Context(), "https://plex.tv/users/fixture-user/avatar?c=1")
	if err != nil || kind != "image/png" || calls != 3 {
		t.Fatalf("fallback avatar not served: %v %q %d", err, kind, calls)
	}
}

func TestPlexAvatarRejectsWordPressCDNLookalikes(t *testing.T) {
	for _, target := range []string{"https://i0.wp.com.untrusted.example/x", "https://evil.wp.com/x", "http://i0.wp.com/x", "https://i0.wp.com:444/x"} {
		p, err := newServerConnection(ProviderConfig{"plex", "http://fixture.test", "fixture-secret"}, &http.Client{Transport: providerTransport(func(r *http.Request) (*http.Response, error) {
			if r.URL.Host != "plex.tv" {
				t.Fatal("rejected redirect reached transport", target)
			}
			return &http.Response{StatusCode: 302, Header: http.Header{"Location": {target}}, Body: io.NopCloser(strings.NewReader("")), Request: r}, nil
		})})
		if err != nil {
			t.Fatal(err)
		}
		if _, _, err := p.activityAvatar(t.Context(), "https://plex.tv/users/fixture-user/avatar"); err == nil {
			t.Fatal("lookalike accepted", target)
		}
	}
}

// Some image responses omit Content-Type; the bytes decide, and only real
// image formats are accepted.
func TestPlexAvatarSniffsMissingContentType(t *testing.T) {
	png := "\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR"
	for _, tc := range []struct {
		body, kind string
		ok         bool
	}{{png, "image/png", true}, {"<html><body>not an image</body></html>", "", false}} {
		p, err := newServerConnection(ProviderConfig{"plex", "http://fixture.test", "fixture-secret"}, &http.Client{Transport: providerTransport(func(r *http.Request) (*http.Response, error) {
			return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(tc.body)), Request: r}, nil
		})})
		if err != nil {
			t.Fatal(err)
		}
		kind, body, err := p.activityAvatar(t.Context(), "https://plex.tv/users/fixture-user/avatar")
		if tc.ok && (err != nil || kind != tc.kind || string(body) != tc.body) || !tc.ok && err == nil {
			t.Fatalf("body %q: kind=%q err=%v", tc.body[:4], kind, err)
		}
	}
}

// Uploaded profile photos can exceed 1 MB; the cap is 5 MB, and empty or
// oversized responses report distinct codes.
func TestPlexAvatarSizeLimitsAndCodes(t *testing.T) {
	big := strings.Repeat("x", 2<<20)
	for _, tc := range []struct {
		name, body, code string
	}{{"two-megabytes", big, ""}, {"empty", "", "AVATAR_RESPONSE_EMPTY"}, {"over-cap", strings.Repeat("x", (5<<20)+1), "AVATAR_RESPONSE_TOO_LARGE"}} {
		t.Run(tc.name, func(t *testing.T) {
			p, err := newServerConnection(ProviderConfig{"plex", "http://fixture.test", "fixture-secret"}, &http.Client{Transport: providerTransport(func(r *http.Request) (*http.Response, error) {
				return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": {"image/jpeg"}}, Body: io.NopCloser(strings.NewReader(tc.body)), Request: r}, nil
			})})
			if err != nil {
				t.Fatal(err)
			}
			_, body, err := p.activityAvatar(t.Context(), "https://plex.tv/users/fixture-user/avatar")
			var classified *plexAvatarError
			if tc.code == "" {
				if err != nil || len(body) != len(tc.body) {
					t.Fatalf("large photo rejected: %v", err)
				}
				return
			}
			if !errors.As(err, &classified) || classified.Code != tc.code {
				t.Fatalf("got %v", err)
			}
		})
	}
}
