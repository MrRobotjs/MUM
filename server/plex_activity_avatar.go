package main

import (
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
)

// Avatar URLs are untrusted provider data. Store only a canonical allowlisted
// public Plex avatar or a constrained local account thumbnail, never tokens.
func safePlexActivityAvatar(value string) string {
	if !activityText(value, 1024) {
		return ""
	}
	u, err := url.Parse(value)
	if err != nil || u.User != nil || u.Fragment != "" || u.Opaque != "" || u.EscapedPath() != u.Path {
		return ""
	}
	parts := strings.Split(u.Path, "/")
	cloud := false
	if u.Host != "" {
		if strings.ToLower(u.Host) != "plex.tv" || (u.Scheme != "https" && u.Scheme != "http") {
			return ""
		}
		if len(parts) != 4 || parts[0] != "" || parts[1] != "users" || parts[3] != "avatar" || !plexAvatarIdentifier(parts[2]) {
			return ""
		}
		cloud = true
	} else {
		if u.Scheme != "" || strings.HasPrefix(value, "//") || len(parts) != 4 || parts[0] != "" || parts[1] != "accounts" || !validPlexCatalogueID(parts[2]) || parts[3] != "thumb" {
			return ""
		}
	}
	query := url.Values{}
	if c := u.Query().Get("c"); c != "" && len(c) <= 32 {
		valid := true
		for _, r := range c {
			if r < '0' || r > '9' {
				valid = false
				break
			}
		}
		if valid {
			query.Set("c", c)
		}
	}
	result := u.Path
	if cloud {
		result = "https://plex.tv" + result
	}
	if encoded := query.Encode(); encoded != "" {
		result += "?" + encoded
	}
	return result
}
func plexAvatarIdentifier(value string) bool {
	if len(value) == 0 || len(value) > 128 {
		return false
	}
	for _, r := range value {
		if !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '-' || r == '_') {
			return false
		}
	}
	return true
}

func (p *jsonProvider) plexActivityAvatar(ctx context.Context, path string) (string, []byte, error) {
	if p.config.Type != "plex" || safePlexActivityAvatar(path) != path {
		return "", nil, errors.New("invalid Plex avatar identity")
	}
	return p.fetchPlexAvatar(ctx, path)
}

// Both callers validate their image identity before entering this bounded
// transport. All redirect and credential rules remain shared.
func (p *jsonProvider) fetchPlexAvatar(ctx context.Context, path string) (string, []byte, error) {
	local := strings.HasPrefix(path, "/")
	target := path
	origin, _ := url.Parse(p.config.URL)
	if local {
		target = strings.TrimRight(p.config.URL, "/") + path
	}
	// Local credentials stay on the configured origin. Public cloud image hops
	// never receive a provider key, Authorization, Referer or cookies.
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		return "", nil, errors.New("invalid Plex avatar request")
	}
	req.Header.Set("Accept", "image/*")
	if local {
		req.Header.Set("X-Plex-Token", p.config.APIKey)
		req.Header.Set("X-Plex-Client-Identifier", "mum-go")
	}
	client := *p.client
	client.Jar = nil
	client.CheckRedirect = func(next *http.Request, via []*http.Request) error {
		sameSource := local && len(via) > 0 && samePlexAvatarOrigin(next.URL, origin) && samePlexAvatarOrigin(via[len(via)-1].URL, origin)
		if len(via) > 3 {
			return &plexAvatarError{Code: "AVATAR_REDIRECT_TOO_MANY_REDIRECTS"}
		}
		if !sameSource && !approvedPlexAvatarRedirect(next.URL) {
			// Report only a static reason. Redirect URLs can contain viewer
			// identifiers, source credentials or other upstream secrets.
			code := "AVATAR_REDIRECT_UNAPPROVED_HOST"
			if next.URL == nil || next.URL.User != nil || next.URL.Fragment != "" || next.URL.Opaque != "" {
				code = "AVATAR_REDIRECT_INVALID_TARGET"
			} else if next.URL.Scheme != "https" {
				code = "AVATAR_REDIRECT_INSECURE_SCHEME"
			}
			return &plexAvatarError{Code: code, Domain: avatarDiagnosticDomain(next.URL)}
		}
		next.Header = make(http.Header)
		next.Header.Set("Accept", "image/*")
		if sameSource {
			next.Header.Set("X-Plex-Token", p.config.APIKey)
			next.Header.Set("X-Plex-Client-Identifier", "mum-go")
		}
		return nil
	}
	response, err := client.Do(req)
	if err != nil {
		var classified *plexAvatarError
		if errors.As(err, &classified) {
			return "", nil, classified
		}
		return "", nil, &plexAvatarError{Code: "AVATAR_REQUEST_FAILED"}
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return "", nil, &plexAvatarError{Code: "AVATAR_UPSTREAM_HTTP_ERROR", Status: response.StatusCode}
	}
	kind := strings.ToLower(strings.TrimSpace(strings.Split(response.Header.Get("Content-Type"), ";")[0]))
	if kind != "" && !allowedAvatarType(kind) {
		return "", nil, &plexAvatarError{Code: "AVATAR_RESPONSE_INVALID", ContentType: avatarDiagnosticToken(kind, 64)}
	}
	// Uploaded profile photos can be several megabytes; the cap stays bounded.
	body, err := io.ReadAll(io.LimitReader(response.Body, maxAvatarBytes+1))
	switch {
	case err != nil:
		return "", nil, &plexAvatarError{Code: "AVATAR_RESPONSE_INVALID"}
	case len(body) == 0:
		return "", nil, &plexAvatarError{Code: "AVATAR_RESPONSE_EMPTY"}
	case len(body) > maxAvatarBytes:
		return "", nil, &plexAvatarError{Code: "AVATAR_RESPONSE_TOO_LARGE"}
	}
	// Some image hosts omit Content-Type; then the bytes decide, and only the
	// same image formats are accepted.
	if kind == "" {
		kind = strings.ToLower(strings.TrimSpace(strings.Split(http.DetectContentType(body), ";")[0]))
		if !allowedAvatarType(kind) {
			return "", nil, &plexAvatarError{Code: "AVATAR_RESPONSE_INVALID", ContentType: "unlabelled-" + avatarDiagnosticToken(kind, 64)}
		}
	}
	return kind, body, nil
}

const maxAvatarBytes = 5 << 20

func allowedAvatarType(kind string) bool {
	return kind == "image/jpeg" || kind == "image/png" || kind == "image/webp" || kind == "image/gif"
}

type plexAvatarError struct {
	Code   string
	Status int
	// Diagnostic log fields. Domain is only the registrable domain of a
	// rejected redirect (never its path, query or full host, which can carry
	// identifiers); ContentType is the refused media type.
	Domain      string
	ContentType string
}

// avatarDiagnosticDomain reduces a redirect target to its last two DNS labels
// (for example "gravatar.com" or "plex.direct"), or "ip-address".
func avatarDiagnosticDomain(u *url.URL) string {
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
	return avatarDiagnosticToken(strings.Join(labels, "."), 253)
}

// avatarDiagnosticToken keeps a short value made of DNS/media-type characters.
func avatarDiagnosticToken(value string, limit int) string {
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

func (e *plexAvatarError) Error() string { return e.Code }
func approvedPlexAvatarRedirect(u *url.URL) bool {
	if u == nil || u.Scheme != "https" || u.User != nil || u.Fragment != "" || u.Opaque != "" {
		return false
	}
	switch strings.ToLower(u.Host) {
	case "plex.tv", "images.plex.tv", "static.plex.tv", "assets.plex.tv":
		return true
	// Plex serves pictures of accounts without an uploaded photo through
	// Gravatar. Like every cloud hop, these requests carry no credentials.
	case "secure.gravatar.com", "gravatar.com", "www.gravatar.com":
		return true
	// Gravatar delivers a missing photo's fallback (Plex's default letter
	// avatar) through the WordPress image CDN.
	case "i0.wp.com", "i1.wp.com", "i2.wp.com", "i3.wp.com":
		return true
	}
	return false
}

func samePlexAvatarOrigin(target, origin *url.URL) bool {
	return target != nil && origin != nil && target.User == nil && target.Fragment == "" && target.Opaque == "" && target.Scheme == origin.Scheme && strings.EqualFold(target.Host, origin.Host)
}
