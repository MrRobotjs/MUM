package main

import (
	"context"
	"database/sql"
	"errors"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// User profile images use the same constrained Plex avatar identities and
// credential-stripping transport as current activity avatars.
func safePlexUserAvatar(value string) string {
	if canonical := safePlexActivityAvatar(value); canonical != "" {
		return canonical
	}
	if !activityText(value, 1024) {
		return ""
	}
	u, err := url.Parse(value)
	if err != nil || !approvedPlexAvatarRedirect(u) || u.EscapedPath() != u.Path {
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
		valid = found && plexAvatarIdentifier(name) && (ext == "png" || ext == "jpg" || ext == "jpeg" || ext == "webp" || ext == "gif")
	}
	if !valid {
		return ""
	}
	// These direct public images need no query parameters, especially credentials.
	return "https://" + strings.ToLower(u.Host) + u.Path
}

func (p *jsonProvider) plexUserAvatar(ctx context.Context, path string) (string, []byte, error) {
	if p.config.Type != "plex" || path == "" || safePlexUserAvatar(path) != path {
		return "", nil, errors.New("invalid Plex avatar identity")
	}
	return p.fetchPlexAvatar(ctx, path)
}

func (a *App) readUserAvatarSource(ctx context.Context, session string, item int64) (catalogueImageSource, error) {
	var source catalogueImageSource
	tx, err := a.store.reader.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return source, err
	}
	defer tx.Rollback()
	if err := tx.QueryRowContext(ctx, `SELECT user_uuid FROM app_sessions WHERE id=? AND refresh_expires_at>?`, session, utcTimestamp(time.Now())).Scan(&source.Actor); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return source, ErrForbidden
		}
		return source, err
	}
	if err := requirePermission(ctx, tx, source.Actor, "administrator"); err != nil {
		return source, err
	}
	// External identity and configuration are part of the post-I/O comparison.
	// A provider image never authorizes itself merely by having a signed URL.
	err = tx.QueryRowContext(ctx, `SELECT s.service_type,s.url,coalesce(s.api_key,''),coalesce(a.external_user_id,''),coalesce(a.external_avatar_url,''),s.id,s.config_revision
	 FROM identities i JOIN service_accounts a ON a.uuid=i.uuid
	 JOIN media_servers s ON s.id=a.server_id JOIN provider_settings p ON p.provider_id=s.service_type
	 WHERE i.id=? AND i.kind='service' AND a.is_active=1 AND s.service_type='plex' AND s.is_active=1 AND p.enabled=1`, item).Scan(
		&source.Provider, &source.URL, &source.APIKey, &source.External, &source.Tag, &source.Server, &source.ConfigRevision)
	if errors.Is(err, sql.ErrNoRows) || err == nil && (source.Tag == "" || safePlexUserAvatar(source.Tag) != source.Tag) {
		return source, ErrNotFound
	}
	return source, err
}

func (a *App) userAvatarProxy(w http.ResponseWriter, r *http.Request) {
	a.serveSignedImage(w, r, "item", "user-avatar", a.readUserAvatarSource, func(ctx context.Context, p *jsonProvider, s catalogueImageSource) (string, []byte, error) {
		return p.plexUserAvatar(ctx, s.Tag)
	})
}
