package main

import (
	"context"
	"database/sql"
	"net/http"
	"time"
)

const maxImageCacheLimitMB = 1048576

type imageCacheServerSetting struct {
	ID         int64  `json:"id"`
	Name       string `json:"name"`
	Provider   string `json:"provider"`
	LimitMB    int64  `json:"limit_mb"`
	UsageBytes int64  `json:"usage_bytes"`
}
type imageCacheSettings struct {
	Mode          string                    `json:"mode"`
	SharedLimitMB int64                     `json:"shared_limit_mb"`
	Revision      int64                     `json:"revision"`
	UsageBytes    int64                     `json:"usage_bytes"`
	Available     bool                      `json:"available"`
	Servers       []imageCacheServerSetting `json:"servers"`
}

func readImageCacheSettings(ctx context.Context, db *sql.Tx) (imageCacheSettings, diskCachePolicy, error) {
	var settings imageCacheSettings
	if err := db.QueryRowContext(ctx, `SELECT mode,shared_limit_mb,revision FROM image_cache_settings WHERE singleton=1`).Scan(&settings.Mode, &settings.SharedLimitMB, &settings.Revision); err != nil {
		return settings, diskCachePolicy{}, err
	}
	settings.Servers = []imageCacheServerSetting{}
	policy := diskCachePolicy{mode: settings.Mode, sharedBytes: settings.SharedLimitMB << 20, serverBytes: map[int64]int64{}, revision: settings.Revision}
	rows, err := db.QueryContext(ctx, `SELECT s.id,s.server_nickname,s.service_type,coalesce(l.limit_mb,1024) FROM media_servers s LEFT JOIN image_cache_server_limits l ON l.server_id=s.id ORDER BY s.id`)
	if err != nil {
		return settings, policy, err
	}
	defer rows.Close()
	for rows.Next() {
		var item imageCacheServerSetting
		if err := rows.Scan(&item.ID, &item.Name, &item.Provider, &item.LimitMB); err != nil {
			return settings, policy, err
		}
		settings.Servers = append(settings.Servers, item)
		policy.serverBytes[item.ID] = item.LimitMB << 20
	}
	return settings, policy, rows.Err()
}
func (a *App) imageCachePolicy(ctx context.Context) (diskCachePolicy, error) {
	tx, err := a.store.reader.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return diskCachePolicy{}, err
	}
	defer tx.Rollback()
	_, policy, err := readImageCacheSettings(ctx, tx)
	return policy, err
}
func (a *App) reconcileImageCacheFolders(ctx context.Context) error {
	if a.diskImages == nil {
		return nil
	}
	tx, err := a.store.reader.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return err
	}
	settings, _, err := readImageCacheSettings(ctx, tx)
	_ = tx.Rollback()
	if err != nil {
		return err
	}
	for _, server := range settings.Servers {
		if err := a.diskImages.renameServer(server.ID, server.Provider, server.Name); err != nil {
			return err
		}
	}
	return nil
}
func (a *App) getImageCacheSettings(w http.ResponseWriter, r *http.Request) {
	p, ok := a.principal(w, r, true)
	if !ok {
		return
	}
	tx, err := a.beginAdminRoleRead(r.Context(), p.UUID, bearer(r))
	if err != nil {
		domainError(w, err)
		return
	}
	settings, _, err := readImageCacheSettings(r.Context(), tx)
	_ = tx.Rollback()
	if err != nil {
		domainError(w, err)
		return
	}
	if a.diskImages != nil {
		settings.Available = true
		total, usage := a.diskImages.usage()
		settings.UsageBytes = total
		for i := range settings.Servers {
			settings.Servers[i].UsageBytes = usage[settings.Servers[i].ID]
		}
	}
	check, err := a.beginAdminRoleRead(r.Context(), p.UUID, bearer(r))
	if err != nil {
		domainError(w, err)
		return
	}
	_ = check.Rollback()
	respond(w, 200, settings)
}
func (a *App) saveImageCacheSettings(w http.ResponseWriter, r *http.Request) {
	p, ok := a.principal(w, r, true)
	if !ok {
		return
	}
	var input struct {
		Revision      int64  `json:"revision"`
		Mode          string `json:"mode"`
		SharedLimitMB int64  `json:"shared_limit_mb"`
	}
	if !decodeStrictBody(w, r, &input) {
		return
	}
	if input.Revision < 1 || (input.Mode != "shared" && input.Mode != "per_server") || input.SharedLimitMB < 1 || input.SharedLimitMB > maxImageCacheLimitMB {
		fail(w, 400, "INVALID_CACHE_SETTINGS", "Choose a valid cache mode and size")
		return
	}
	err := a.store.write(r.Context(), func(tx *sql.Tx) error {
		if err := notificationAuthority(r.Context(), tx, p.UUID, bearer(r)); err != nil {
			return err
		}
		if err := requirePermission(r.Context(), tx, p.UUID, "administrator"); err != nil {
			return err
		}
		result, err := tx.ExecContext(r.Context(), `UPDATE image_cache_settings SET mode=?,shared_limit_mb=?,revision=revision+1 WHERE singleton=1 AND revision=?`, input.Mode, input.SharedLimitMB, input.Revision)
		if err != nil {
			return err
		}
		n, err := result.RowsAffected()
		if err != nil {
			return err
		}
		if n != 1 {
			return ErrConflict
		}
		return auditAction(r.Context(), tx, p.UUID, "image_cache.settings")
	})
	if err != nil {
		domainError(w, err)
		return
	}
	if err := a.applyImageCachePolicy(); err != nil {
		a.logger.Warn("Could not enforce image cache limit", "error", err)
		fail(w, 500, "IMAGE_CACHE_ENFORCEMENT_FAILED", "Settings were saved, but the cache limit could not be enforced")
		return
	}
	respond(w, 200, map[string]any{"revision": input.Revision + 1})
}
func (a *App) saveServerImageCacheLimit(w http.ResponseWriter, r *http.Request) {
	p, ok := a.principal(w, r, true)
	if !ok {
		return
	}
	id, ok := pathID(w, r, "server")
	if !ok {
		return
	}
	var input struct {
		Revision int64 `json:"revision"`
		LimitMB  int64 `json:"limit_mb"`
	}
	if !decodeStrictBody(w, r, &input) {
		return
	}
	if input.Revision < 1 || input.LimitMB < 1 || input.LimitMB > maxImageCacheLimitMB {
		fail(w, 400, "INVALID_CACHE_SETTINGS", "Choose a valid cache size")
		return
	}
	err := a.store.write(r.Context(), func(tx *sql.Tx) error {
		if err := notificationAuthority(r.Context(), tx, p.UUID, bearer(r)); err != nil {
			return err
		}
		if err := requirePermission(r.Context(), tx, p.UUID, "administrator"); err != nil {
			return err
		}
		var exists bool
		if err := tx.QueryRowContext(r.Context(), `SELECT EXISTS(SELECT 1 FROM media_servers WHERE id=?)`, id).Scan(&exists); err != nil {
			return err
		}
		if !exists {
			return ErrNotFound
		}
		result, err := tx.ExecContext(r.Context(), `UPDATE image_cache_settings SET revision=revision+1 WHERE singleton=1 AND revision=?`, input.Revision)
		if err != nil {
			return err
		}
		n, err := result.RowsAffected()
		if err != nil {
			return err
		}
		if n != 1 {
			return ErrConflict
		}
		if _, err = tx.ExecContext(r.Context(), `INSERT INTO image_cache_server_limits(server_id,limit_mb) VALUES(?,?) ON CONFLICT(server_id) DO UPDATE SET limit_mb=excluded.limit_mb`, id, input.LimitMB); err != nil {
			return err
		}
		return auditAction(r.Context(), tx, p.UUID, "image_cache.server_limit")
	})
	if err != nil {
		domainError(w, err)
		return
	}
	if err := a.applyImageCachePolicy(); err != nil {
		a.logger.Warn("Could not enforce image cache limit", "error", err)
		fail(w, 500, "IMAGE_CACHE_ENFORCEMENT_FAILED", "Settings were saved, but the cache limit could not be enforced")
		return
	}
	respond(w, 200, map[string]any{"revision": input.Revision + 1})
}
func (a *App) applyImageCachePolicy() error {
	if a.diskImages == nil {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	policy, err := a.imageCachePolicy(ctx)
	if err != nil {
		return err
	}
	return a.diskImages.applyPolicy(policy)
}
func (a *App) clearAllImageCache(w http.ResponseWriter, r *http.Request) {
	p, ok := a.principal(w, r, true)
	if !ok {
		return
	}
	err := a.store.write(r.Context(), func(tx *sql.Tx) error {
		if err := notificationAuthority(r.Context(), tx, p.UUID, bearer(r)); err != nil {
			return err
		}
		if err := requirePermission(r.Context(), tx, p.UUID, "administrator"); err != nil {
			return err
		}
		return auditAction(r.Context(), tx, p.UUID, "image_cache.clear_all")
	})
	if err != nil {
		domainError(w, err)
		return
	}
	if a.diskImages == nil {
		fail(w, 503, "IMAGE_CACHE_UNAVAILABLE", "The disk image cache is unavailable")
		return
	}
	a.imageCache.clear(0)
	if err := a.diskImages.clear(0); err != nil {
		domainError(w, err)
		return
	}
	respond(w, 200, map[string]bool{"cleared": true})
}
