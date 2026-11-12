package plex

import (
	"net/url"
	"strconv"
	"strings"

	"app/server/providers/provider"
)

// NumericID reports whether value is Plex's canonical positive integer ID.
func NumericID(value string) bool {
	id, err := strconv.ParseInt(value, 10, 64)
	return err == nil && id > 0 && strconv.FormatInt(id, 10) == value
}

// AvatarIdentifier accepts 1–128 ASCII letters, digits, '-' or '_'.
func AvatarIdentifier(value string) bool {
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

// ActivityAvatar canonicalises an avatar URL from playback data. Avatar URLs
// are untrusted provider data: only an allowlisted public plex.tv avatar or a
// constrained local account thumbnail is kept, never tokens. "" means
// rejected.
func ActivityAvatar(value string) string {
	if !provider.ValidText(value, 1024) {
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
		if len(parts) != 4 || parts[0] != "" || parts[1] != "users" || parts[3] != "avatar" || !AvatarIdentifier(parts[2]) {
			return ""
		}
		cloud = true
	} else {
		if u.Scheme != "" || strings.HasPrefix(value, "//") || len(parts) != 4 || parts[0] != "" || parts[1] != "accounts" || !NumericID(parts[2]) || parts[3] != "thumb" {
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

// UserAvatar canonicalises a user profile avatar: an activity avatar, or a
// direct public plex.tv or assets.plex.tv image without query parameters.
func UserAvatar(value string) string {
	if canonical := ActivityAvatar(value); canonical != "" {
		return canonical
	}
	if !provider.ValidText(value, 1024) {
		return ""
	}
	u, err := url.Parse(value)
	if err != nil || !ApprovedAvatarRedirect(u) || u.EscapedPath() != u.Path {
		return ""
	}
	parts := strings.Split(u.Path, "/")
	valid := false
	if strings.EqualFold(u.Host, "plex.tv") && len(parts) == 6 && parts[1] == "avatars" && len(parts[2]) == 6 {
		valid = strings.Trim(parts[2], "0123456789abcdefABCDEF") == ""
		for _, part := range parts[3:] {
			n, err := strconv.Atoi(part)
			if err != nil || n < 0 || n > 4096 || len(part) > 4 || strings.Trim(part, "0123456789") != "" {
				valid = false
			}
		}
	}
	if strings.EqualFold(u.Host, "assets.plex.tv") && len(parts) == 3 && parts[1] == "users" {
		name, ext, found := strings.Cut(parts[2], ".")
		valid = found && AvatarIdentifier(name) && (ext == "png" || ext == "jpg" || ext == "jpeg" || ext == "webp" || ext == "gif")
	}
	if !valid {
		return ""
	}
	// These direct public images need no query parameters, especially credentials.
	return "https://" + strings.ToLower(u.Host) + u.Path
}

// ApprovedAvatarRedirect reports whether an avatar request may go to u. Every
// such hop is HTTPS and carries no credentials.
func ApprovedAvatarRedirect(u *url.URL) bool {
	if u == nil || u.Scheme != "https" || u.User != nil || u.Fragment != "" || u.Opaque != "" {
		return false
	}
	switch strings.ToLower(u.Host) {
	case "plex.tv", "images.plex.tv", "static.plex.tv", "assets.plex.tv":
		return true
	// Plex serves pictures of accounts without an uploaded photo through
	// Gravatar.
	case "secure.gravatar.com", "gravatar.com", "www.gravatar.com":
		return true
	// Gravatar delivers a missing photo's fallback (Plex's default letter
	// avatar) through the WordPress image CDN.
	case "i0.wp.com", "i1.wp.com", "i2.wp.com", "i3.wp.com":
		return true
	}
	return false
}
