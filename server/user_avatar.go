package main

import (
	"app/server/providers/plex"
	"context"
	"database/sql"
	"errors"
	"net/http"
	"time"
)

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
	if errors.Is(err, sql.ErrNoRows) || err == nil && (source.Tag == "" || plex.UserAvatar(source.Tag) != source.Tag) {
		return source, ErrNotFound
	}
	return source, err
}

func (a *App) userAvatarProxy(w http.ResponseWriter, r *http.Request) {
	a.serveSignedImage(w, r, "item", "user-avatar", a.readUserAvatarSource, func(ctx context.Context, p *serverConnection, s catalogueImageSource) (string, []byte, error) {
		return p.userAvatar(ctx, s.Tag)
	})
}
