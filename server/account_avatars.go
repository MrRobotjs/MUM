package main

import (
	"context"
	"database/sql"
	"errors"
	"io"
	"net/http"
	"regexp"
	"strings"
	"time"

	"app/server/providers/mediabrowser"
	"app/server/providers/plex"
)

// Profile pictures beside linked accounts on the account page and the admin
// user page. Every picture goes through MUM on a
// short-lived signed link, like posters: the browser never contacts Plex,
// Discord or a media server, and no key reaches it. Each fetch rechecks that
// the signing session may see the account: an administrator, the account
// itself, the MUM profile that owns it, or (for Plex) the member whose Plex
// sign-in link has the same plex.tv ID. Services without pictures
// (Audiobookshelf, Kavita, Komga) and RomM, whose picture isn't read yet, get
// no link, and the page shows the name's first letter.

const (
	serviceAvatarPurpose = "service-avatar"
	discordAvatarPurpose = "discord-avatar"
	discordCDNBase       = "https://cdn.discordapp.com"
	maxDiscordAvatar     = 2 << 20
)

var (
	discordUserIDPattern = regexp.MustCompile(`^[0-9]{5,20}$`)
	discordHashPattern   = regexp.MustCompile(`^(a_)?[0-9a-f]{32}$`)
)

// serviceHasAvatar says whether a service account can have a picture MUM
// reads: Plex from its stored plex.tv or server picture, Jellyfin and Emby
// from the server.
func serviceHasAvatar(kind, external, avatar string) bool {
	switch kind {
	case "plex":
		return avatar != "" && plex.UserAvatar(avatar) == avatar
	case "jellyfin", "emby":
		return mediabrowser.ValidToken(external)
	}
	return false
}

func discordAvatarValid(id, hash string) bool {
	return discordUserIDPattern.MatchString(id) && discordHashPattern.MatchString(hash)
}

// requestSession is the session behind the request's access token, used to
// sign image links for that session only.
func (a *App) requestSession(ctx context.Context, r *http.Request) (string, error) {
	var session string
	err := a.store.reader.QueryRowContext(ctx, "SELECT session_id FROM session_access_tokens WHERE token_hash=? AND expires_at>?", tokenHash(bearer(r)), utcTimestamp(time.Now())).Scan(&session)
	return session, err
}

func (a *App) serviceAvatarURL(session string, identity int64, now time.Time) string {
	return a.signedImageURL(serviceAvatarPurpose, "/api/service-avatars", session, identity, now)
}

// imageActor is the live session's user and whether they are an administrator.
func imageActor(ctx context.Context, tx *sql.Tx, session string) (string, bool, error) {
	var actor string
	if err := tx.QueryRowContext(ctx, `SELECT user_uuid FROM app_sessions WHERE id=? AND refresh_expires_at>?`, session, utcTimestamp(time.Now())).Scan(&actor); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return "", false, ErrForbidden
		}
		return "", false, err
	}
	if _, err := loadPrincipal(ctx, tx, actor); err != nil {
		return "", false, ErrForbidden
	}
	err := requirePermission(ctx, tx, actor, "administrator")
	if errors.Is(err, ErrForbidden) {
		return actor, false, nil
	}
	return actor, err == nil, err
}

func (a *App) readServiceAvatarSource(ctx context.Context, session string, item int64) (catalogueImageSource, error) {
	var source catalogueImageSource
	tx, err := a.store.reader.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return source, err
	}
	defer tx.Rollback()
	actor, admin, err := imageActor(ctx, tx, session)
	if err != nil {
		return source, err
	}
	source.Actor = actor
	err = tx.QueryRowContext(ctx, `SELECT s.service_type,s.url,coalesce(s.api_key,''),coalesce(a.external_user_id,''),coalesce(a.external_avatar_url,''),s.id,s.config_revision
	 FROM identities i JOIN service_accounts a ON a.uuid=i.uuid JOIN media_servers s ON s.id=a.server_id JOIN provider_settings p ON p.provider_id=s.service_type
	 WHERE i.id=? AND i.kind='service' AND s.is_active=1 AND p.enabled=1 AND s.service_type IN ('plex','jellyfin','emby')
	 AND (? OR a.uuid=? OR EXISTS(SELECT 1 FROM service_links l WHERE l.service_uuid=a.uuid AND l.user_uuid=? AND l.link_kind='owner')
	  OR s.service_type='plex' AND EXISTS(SELECT 1 FROM plex_connections c WHERE c.owner_uuid=? AND c.status='active' AND c.account_id IN (a.external_user_id,coalesce(a.external_account_id,''))))`,
		item, admin, actor, actor, actor).Scan(&source.Provider, &source.URL, &source.APIKey, &source.External, &source.Tag, &source.Server, &source.ConfigRevision)
	if errors.Is(err, sql.ErrNoRows) || err == nil && !serviceHasAvatar(source.Provider, source.External, source.Tag) {
		return source, ErrNotFound
	}
	return source, err
}

func (a *App) serviceAvatarProxy(w http.ResponseWriter, r *http.Request) {
	a.serveSignedImage(w, r, "item", serviceAvatarPurpose, a.readServiceAvatarSource, func(ctx context.Context, p *serverConnection, s catalogueImageSource) (string, []byte, error) {
		if s.Provider == "plex" {
			return p.userAvatar(ctx, s.Tag)
		}
		return p.userAvatar(ctx, s.External)
	})
}

func (a *App) readDiscordAvatarSource(ctx context.Context, session string, item int64) (catalogueImageSource, error) {
	var source catalogueImageSource
	tx, err := a.store.reader.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return source, err
	}
	defer tx.Rollback()
	actor, admin, err := imageActor(ctx, tx, session)
	if err != nil {
		return source, err
	}
	source.Actor = actor
	err = tx.QueryRowContext(ctx, `SELECT coalesce(u.discord_user_id,''),coalesce(u.discord_avatar_hash,'') FROM identities i JOIN user_accounts u ON u.uuid=i.uuid
	 WHERE i.id=? AND u.deleted_at IS NULL AND (? OR u.uuid=?)`, item, admin, actor).Scan(&source.External, &source.Tag)
	if errors.Is(err, sql.ErrNoRows) || err == nil && !discordAvatarValid(source.External, source.Tag) {
		return source, ErrNotFound
	}
	return source, err
}

func (a *App) discordAvatarProxy(w http.ResponseWriter, r *http.Request) {
	a.serveSignedImage(w, r, "item", discordAvatarPurpose, a.readDiscordAvatarSource, func(ctx context.Context, _ *serverConnection, s catalogueImageSource) (string, []byte, error) {
		return a.fetchDiscordAvatar(ctx, s.External, s.Tag)
	})
}

// fetchDiscordAvatar reads a validated avatar from Discord's image server,
// without redirects, cookies or credentials.
func (a *App) fetchDiscordAvatar(ctx context.Context, id, hash string) (string, []byte, error) {
	if !discordAvatarValid(id, hash) {
		return "", nil, ErrNotFound
	}
	base := discordCDNBase
	if a.DiscordCDN != "" {
		base = a.DiscordCDN
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, base+"/avatars/"+id+"/"+hash+".png?size=128", nil)
	if err != nil {
		return "", nil, err
	}
	req.Header.Set("Accept", "image/*")
	response, err := a.discordHTTP().Do(req)
	if err != nil {
		return "", nil, errors.New("Discord is unreachable")
	}
	defer response.Body.Close()
	kind := strings.ToLower(strings.TrimSpace(strings.Split(response.Header.Get("Content-Type"), ";")[0]))
	if response.StatusCode != http.StatusOK || kind != "image/png" && kind != "image/webp" && kind != "image/gif" && kind != "image/jpeg" {
		return "", nil, errors.New("Discord returned no picture")
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, maxDiscordAvatar+1))
	if err != nil || len(body) == 0 || len(body) > maxDiscordAvatar {
		return "", nil, errors.New("Discord picture could not be read")
	}
	return kind, body, nil
}
