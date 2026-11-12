package plex

import (
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
)

// ActivityAvatarImage downloads a playback avatar already canonicalised by
// ActivityAvatar.
func (s *Server) ActivityAvatarImage(ctx context.Context, path string) (string, []byte, error) {
	if ActivityAvatar(path) != path {
		return "", nil, errors.New("invalid Plex avatar identity")
	}
	return s.fetchAvatar(ctx, path)
}

// UserAvatarImage downloads a user profile avatar already canonicalised by
// UserAvatar.
func (s *Server) UserAvatarImage(ctx context.Context, path string) (string, []byte, error) {
	if path == "" || UserAvatar(path) != path {
		return "", nil, errors.New("invalid Plex avatar identity")
	}
	return s.fetchAvatar(ctx, path)
}

// MaxAvatarBytes bounds an avatar download. Uploaded profile photos can be
// several megabytes.
const MaxAvatarBytes = 5 << 20

// AvatarError is a classified avatar failure. Code is a stable reason; the
// diagnostic fields never hold a URL path, query or full host, which can
// carry identifiers or credentials.
type AvatarError struct {
	Code   string
	Status int
	// Domain is only the registrable domain of a rejected redirect;
	// ContentType is the refused media type.
	Domain      string
	ContentType string
}

func (e *AvatarError) Error() string { return e.Code }

// fetchAvatar downloads a validated avatar. A local thumbnail is fetched from
// the configured server with its token, and only same-origin redirects keep
// the token. Public cloud hops must be approved image hosts and never receive
// the token, Authorization, Referer or cookies.
func (s *Server) fetchAvatar(ctx context.Context, path string) (string, []byte, error) {
	local := strings.HasPrefix(path, "/")
	target := path
	origin, _ := url.Parse(s.url)
	if local {
		target = s.url + path
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		return "", nil, errors.New("invalid Plex avatar request")
	}
	req.Header.Set("Accept", "image/*")
	if local {
		req.Header.Set("X-Plex-Token", s.token)
		req.Header.Set("X-Plex-Client-Identifier", DefaultClientID)
	}
	client := *s.transport.Client
	client.Jar = nil
	client.CheckRedirect = func(next *http.Request, via []*http.Request) error {
		sameSource := local && len(via) > 0 && sameOrigin(next.URL, origin) && sameOrigin(via[len(via)-1].URL, origin)
		if len(via) > 3 {
			return &AvatarError{Code: "AVATAR_REDIRECT_TOO_MANY_REDIRECTS"}
		}
		if !sameSource && !ApprovedAvatarRedirect(next.URL) {
			// Report only a static reason: redirect URLs can contain viewer
			// identifiers, source credentials or other upstream secrets.
			code := "AVATAR_REDIRECT_UNAPPROVED_HOST"
			if next.URL == nil || next.URL.User != nil || next.URL.Fragment != "" || next.URL.Opaque != "" {
				code = "AVATAR_REDIRECT_INVALID_TARGET"
			} else if next.URL.Scheme != "https" {
				code = "AVATAR_REDIRECT_INSECURE_SCHEME"
			}
			return &AvatarError{Code: code, Domain: diagnosticDomain(next.URL)}
		}
		next.Header = make(http.Header)
		next.Header.Set("Accept", "image/*")
		if sameSource {
			next.Header.Set("X-Plex-Token", s.token)
			next.Header.Set("X-Plex-Client-Identifier", DefaultClientID)
		}
		return nil
	}
	response, err := client.Do(req)
	if err != nil {
		var classified *AvatarError
		if errors.As(err, &classified) {
			return "", nil, classified
		}
		return "", nil, &AvatarError{Code: "AVATAR_REQUEST_FAILED"}
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return "", nil, &AvatarError{Code: "AVATAR_UPSTREAM_HTTP_ERROR", Status: response.StatusCode}
	}
	kind := strings.ToLower(strings.TrimSpace(strings.Split(response.Header.Get("Content-Type"), ";")[0]))
	if kind != "" && !avatarType(kind) {
		return "", nil, &AvatarError{Code: "AVATAR_RESPONSE_INVALID", ContentType: diagnosticToken(kind, 64)}
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, MaxAvatarBytes+1))
	switch {
	case err != nil:
		return "", nil, &AvatarError{Code: "AVATAR_RESPONSE_INVALID"}
	case len(body) == 0:
		return "", nil, &AvatarError{Code: "AVATAR_RESPONSE_EMPTY"}
	case len(body) > MaxAvatarBytes:
		return "", nil, &AvatarError{Code: "AVATAR_RESPONSE_TOO_LARGE"}
	}
	// Some image hosts omit Content-Type; then the bytes decide, and only the
	// same image formats are accepted.
	if kind == "" {
		kind = strings.ToLower(strings.TrimSpace(strings.Split(http.DetectContentType(body), ";")[0]))
		if !avatarType(kind) {
			return "", nil, &AvatarError{Code: "AVATAR_RESPONSE_INVALID", ContentType: "unlabelled-" + diagnosticToken(kind, 64)}
		}
	}
	return kind, body, nil
}

func avatarType(kind string) bool {
	return kind == "image/jpeg" || kind == "image/png" || kind == "image/webp" || kind == "image/gif"
}

// diagnosticDomain reduces a redirect target to its last two DNS labels (for
// example "gravatar.com" or "plex.direct"), or "ip-address".
func diagnosticDomain(u *url.URL) string {
	if u == nil {
		return ""
	}
	host := strings.ToLower(u.Hostname())
	if net.ParseIP(host) != nil {
		return "ip-address"
	}
	labels := strings.Split(strings.Trim(host, "."), ".")
	if len(labels) > 2 {
		labels = labels[len(labels)-2:]
	}
	return diagnosticToken(strings.Join(labels, "."), 253)
}

// diagnosticToken keeps a short value made of DNS and media-type characters.
func diagnosticToken(value string, limit int) string {
	if value == "" || len(value) > limit {
		return "invalid"
	}
	for _, r := range value {
		if !(r >= 'a' && r <= 'z' || r >= '0' && r <= '9' || r == '.' || r == '-' || r == '/' || r == '+') {
			return "invalid"
		}
	}
	return value
}

func sameOrigin(target, origin *url.URL) bool {
	return target != nil && origin != nil && target.User == nil && target.Fragment == "" && target.Opaque == "" && target.Scheme == origin.Scheme && strings.EqualFold(target.Host, origin.Host)
}
