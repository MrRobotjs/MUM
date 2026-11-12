package main

import (
	"app/server/providers/plex"
	"context"
	"database/sql"
	"errors"
	"net/http"
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
	err = tx.QueryRowContext(ctx, `SELECT s.service_type,s.url,coalesce(s.api_key,''),`+externalColumn+`,`+tagColumn+`,s.id,s.config_revision,a.mapping_revision
	FROM media_activity_current c JOIN media_activity_history h ON h.id=c.history_id
	JOIN media_servers s ON s.id=c.server_id JOIN provider_settings p ON p.provider_id=s.service_type JOIN media_activity_state a ON a.server_id=s.id
	WHERE h.id=? AND s.service_type='plex' AND s.is_active=1 AND p.enabled=1 AND a.last_result='fresh'
	AND a.observed_config_revision=s.config_revision AND a.observed_mapping_revision=a.mapping_revision
	AND julianday(a.observed_at)>julianday('now','-60 seconds')`, item).Scan(&source.Provider, &source.URL, &source.APIKey, &source.External, &source.Tag, &source.Server, &source.ConfigRevision, &source.ActivityMappingRevision)
	valid := validPlexCataloguePoster(source.External, source.Tag)
	if avatar {
		valid = source.Tag != "" && plex.ActivityAvatar(source.Tag) == source.Tag
	}
	if errors.Is(err, sql.ErrNoRows) || err == nil && !valid {
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
// administrator session, active Plex server and enabled provider are rechecked
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
	err = tx.QueryRowContext(ctx, `SELECT s.service_type,s.url,coalesce(s.api_key,''),coalesce(h.poster_item,''),coalesce(h.poster_path,''),s.id,s.config_revision
	FROM media_activity_history h JOIN media_servers s ON s.id=h.server_id JOIN provider_settings p ON p.provider_id=s.service_type
	WHERE h.id=? AND s.service_type='plex' AND s.is_active=1 AND p.enabled=1`, item).Scan(&source.Provider, &source.URL, &source.APIKey, &source.External, &source.Tag, &source.Server, &source.ConfigRevision)
	if errors.Is(err, sql.ErrNoRows) || err == nil && !validPlexCataloguePoster(source.External, source.Tag) {
		return source, ErrNotFound
	}
	return source, err
}

func (a *App) activityHistoryImageProxy(w http.ResponseWriter, r *http.Request) {
	a.serveSignedImage(w, r, "item", activityHistoryPosterPurpose, a.readActivityHistoryImageSource, func(ctx context.Context, p *serverConnection, s catalogueImageSource) (string, []byte, error) {
		return p.catalogueImage(ctx, s.External, s.Tag)
	})
}
