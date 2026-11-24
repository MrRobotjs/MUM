package main

import (
	"app/server/providers/audiobookshelf"
	"app/server/providers/mediabrowser"
	"app/server/providers/plex"
	"app/server/providers/tofa"
	"context"
	"database/sql"
	"errors"
	"net/http"
	"strings"
	"time"
)

func (a *App) readActivityImageSource(ctx context.Context, session string, item int64) (catalogueImageSource, error) {
	return a.readActivityPictureSource(ctx, session, item, false)
}
func (a *App) readActivityAvatarSource(ctx context.Context, session string, item int64) (catalogueImageSource, error) {
	return a.readActivityPictureSource(ctx, session, item, true)
}
func (a *App) readActivityPictureSource(ctx context.Context, session string, item int64, avatar bool) (catalogueImageSource, error) {
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
	externalColumn, tagColumn := `coalesce(json_extract(c.display_json,'$.poster_item'),'')`, `coalesce(json_extract(c.display_json,'$.poster_path'),'')`
	if avatar {
		externalColumn = `''`
		tagColumn = `coalesce(json_extract(c.display_json,'$.avatar_path'),'')`
	}
	var observed string
	var pending sql.NullString
	err = tx.QueryRowContext(ctx, `SELECT s.service_type,s.url,coalesce(s.api_key,''),`+externalColumn+`,`+tagColumn+`,s.id,s.config_revision,a.mapping_revision,a.observed_at,a.pending_until
	FROM media_activity_current c JOIN media_activity_history h ON h.id=c.history_id
	JOIN media_servers s ON s.id=c.server_id JOIN provider_settings p ON p.provider_id=s.service_type JOIN media_activity_state a ON a.server_id=s.id
	WHERE h.id=? AND s.service_type IN ('plex','jellyfin','emby','tofa') AND s.is_active=1 AND p.enabled=1 AND a.last_result='fresh'
	AND a.observed_config_revision=s.config_revision AND a.observed_mapping_revision=a.mapping_revision`, item).Scan(&source.Provider, &source.URL, &source.APIKey, &source.External, &source.Tag, &source.Server, &source.ConfigRevision, &source.ActivityMappingRevision, &observed, &pending)
	if errors.Is(err, sql.ErrNoRows) {
		return source, ErrNotFound
	}
	if err != nil {
		return source, err
	}
	now := time.Now().UTC()
	at, parseErr := time.Parse(time.RFC3339Nano, observed)
	if parseErr != nil || at.After(now.Add(time.Second)) || now.Sub(at) >= time.Minute && !a.activitySocketConnected(source.Server, at) {
		return source, ErrNotFound
	}
	if pending.Valid {
		until, err := time.Parse(time.RFC3339Nano, pending.String)
		if err != nil || !until.After(now) {
			return source, ErrNotFound
		}
	}
	valid := validPlexCataloguePoster(source.External, source.Tag)
	if source.Provider == "jellyfin" || source.Provider == "emby" {
		valid = mediabrowser.ValidToken(source.External) && mediabrowser.ValidToken(source.Tag)
	}
	if source.Provider == "tofa" {
		valid = tofa.ValidMediaID(source.External) && source.Tag == "poster"
	}
	if avatar {
		valid = source.Provider == "plex" && source.Tag != "" && plex.ActivityAvatar(source.Tag) == source.Tag
		if source.Provider == "tofa" {
			valid = tofa.ValidActivityAvatar(source.Tag)
		}
		if source.Provider == "jellyfin" || source.Provider == "emby" {
			parts := strings.Split(source.Tag, ":")
			valid = len(parts) == 2 && mediabrowser.ValidToken(parts[0]) && mediabrowser.ValidToken(parts[1])
		}
	}
	if !valid {
		return source, ErrNotFound
	}
	return source, err
}
func (a *App) activityImageProxy(w http.ResponseWriter, r *http.Request) {
	a.serveSignedImage(w, r, "item", "activity-poster", a.readActivityImageSource, func(ctx context.Context, p *serverConnection, s catalogueImageSource) (string, []byte, error) {
		return p.catalogueImage(ctx, s.External, s.Tag)
	})
}

func (a *App) activityAvatarProxy(w http.ResponseWriter, r *http.Request) {
	a.serveSignedImage(w, r, "item", "activity-avatar", a.readActivityAvatarSource, func(ctx context.Context, p *serverConnection, s catalogueImageSource) (string, []byte, error) {
		return p.activityAvatar(ctx, s.Tag)
	})
}

const activityHistoryPosterPurpose = "activity-history-poster"

// readActivityHistoryImageSource resolves the poster stored with a retained
// play. Unlike live posters it does not require current playback, but the
// administrator session, active server and enabled provider are rechecked
// on every fetch, and only a validated catalogue reference is ever used.
func (a *App) readActivityHistoryImageSource(ctx context.Context, session string, item int64) (catalogueImageSource, error) {
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
	err = tx.QueryRowContext(ctx, `SELECT s.service_type,s.url,coalesce(s.api_key,''),coalesce(nullif(h.poster_item,''),nullif(h.parent_item_id,''),h.item_id,''),coalesce(h.poster_path,''),s.id,s.config_revision,coalesce(h.parent_item_id,'')
	FROM media_activity_history h JOIN media_servers s ON s.id=h.server_id JOIN provider_settings p ON p.provider_id=s.service_type
	WHERE h.id=? AND s.is_active=1 AND p.enabled=1`, item).Scan(&source.Provider, &source.URL, &source.APIKey, &source.External, &source.Tag, &source.Server, &source.ConfigRevision, &source.CacheAlternative)
	if errors.Is(err, sql.ErrNoRows) || err == nil && !validRetainedImageReference(source) {
		return source, ErrNotFound
	}
	return source, err
}

func (a *App) activityHistoryImageProxy(w http.ResponseWriter, r *http.Request) {
	a.serveSignedImage(w, r, "item", activityHistoryPosterPurpose, a.readActivityHistoryImageSource, func(ctx context.Context, p *serverConnection, s catalogueImageSource) (string, []byte, error) {
		return p.catalogueImage(ctx, s.External, s.Tag)
	})
}

const importedHistoryPosterPurpose = "imported-history-poster"

// readImportedHistoryImageSource resolves the poster stored with a play
// imported from a server's own history, with the same rechecks as a retained
// MUM play: an administrator session, an active server, an enabled provider
// and a reference valid for that kind of server.
func (a *App) readImportedHistoryImageSource(ctx context.Context, session string, item int64) (catalogueImageSource, error) {
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
	err = tx.QueryRowContext(ctx, `SELECT s.service_type,s.url,coalesce(s.api_key,''),coalesce(nullif(i.poster_item,''),i.item_id,''),coalesce(i.poster_path,''),s.id,s.config_revision
	FROM history_imports i JOIN media_servers s ON s.id=i.server_id JOIN provider_settings p ON p.provider_id=s.service_type
	WHERE i.rowid=? AND s.is_active=1 AND p.enabled=1`, item).Scan(&source.Provider, &source.URL, &source.APIKey, &source.External, &source.Tag, &source.Server, &source.ConfigRevision)
	if errors.Is(err, sql.ErrNoRows) || err == nil && !validRetainedImageReference(source) {
		return source, ErrNotFound
	}
	return source, err
}

func (a *App) importedHistoryImageProxy(w http.ResponseWriter, r *http.Request) {
	a.serveSignedImage(w, r, "item", importedHistoryPosterPurpose, a.readImportedHistoryImageSource, func(ctx context.Context, p *serverConnection, s catalogueImageSource) (string, []byte, error) {
		return p.catalogueImage(ctx, s.External, s.Tag)
	})
}

// Without an image path, a recorded item can only look up an already-cached
// poster; it cannot trigger a provider request with an unvalidated path.
func validRetainedImageReference(source catalogueImageSource) bool {
	if source.Tag != "" {
		return validHistoryPoster(source.Provider, source.External, source.Tag)
	}
	switch source.Provider {
	case "plex":
		return plex.NumericID(source.External)
	case "jellyfin", "emby":
		return mediabrowser.ValidToken(source.External)
	case "audiobookshelf":
		return audiobookshelf.ValidItemID(source.External)
	}
	return false
}
