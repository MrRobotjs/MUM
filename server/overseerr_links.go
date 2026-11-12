package main

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"time"
)

type overseerrConfig struct {
	Server   int64
	Name     string
	URL      string
	key      string
	Revision int64
}

func (c overseerrConfig) fingerprint() string {
	encoded, _ := json.Marshal([]string{c.URL, c.key})
	return fmt.Sprintf("%x", sha256.Sum256(encoded))
}

func readOverseerrConfig(ctx context.Context, q queryRower, server int64) (overseerrConfig, bool, error) {
	c := overseerrConfig{Server: server}
	var enabled bool
	err := q.QueryRowContext(ctx, `SELECT s.server_nickname,coalesce(s.overseerr_url,''),coalesce(s.overseerr_api_key,''),o.revision,(s.overseerr_enabled=1 AND s.service_type='plex' AND s.is_active=1 AND p.enabled=1)
 FROM media_servers s JOIN overseerr_state o ON o.server_id=s.id JOIN provider_settings p ON p.provider_id=s.service_type WHERE s.id=?`, server).Scan(&c.Name, &c.URL, &c.key, &c.Revision, &enabled)
	if errors.Is(err, sql.ErrNoRows) {
		return c, false, ErrNotFound
	}
	return c, enabled && c.URL != "" && c.key != "", err
}

// refreshOverseerrLinks reads every Overseerr user outside the writer and
// links recorded Plex service accounts whose plex.tv account ID exactly equals
// an Overseerr user's plexId. Usernames and emails are never compared. A failed
// read keeps the previous links; a configuration change during the read wins.
func (a *App) refreshOverseerrLinks(ctx context.Context, server int64) error {
	config, enabled, err := readOverseerrConfig(ctx, a.store.reader, server)
	if err != nil || !enabled {
		return err
	}
	client, err := newOverseerrClient(config.URL, config.key, a.ProviderHTTP)
	if err != nil {
		return err
	}
	users, readErr := client.users(ctx)
	err = a.store.write(ctx, func(tx *sql.Tx) error {
		current, enabled, err := readOverseerrConfig(ctx, tx, server)
		if err != nil {
			return err
		}
		if !enabled || current.Revision != config.Revision || current.fingerprint() != config.fingerprint() {
			return ErrConflict
		}
		now := utcTimestamp(time.Now())
		if readErr != nil {
			// Record the failure but keep the previous, still-valid links.
			_, err = tx.ExecContext(ctx, "UPDATE overseerr_state SET last_result='failed' WHERE server_id=?", server)
			return err
		}
		byPlex := map[string]overseerrUser{}
		for _, user := range users {
			if user.PlexID != nil {
				byPlex[strconv.FormatInt(*user.PlexID, 10)] = user
			}
		}
		if _, err = tx.ExecContext(ctx, "DELETE FROM overseerr_links WHERE server_id=?", server); err != nil {
			return err
		}
		rows, err := tx.QueryContext(ctx, "SELECT uuid,coalesce(external_user_id,'') FROM service_accounts WHERE server_id=? ORDER BY uuid", server)
		if err != nil {
			return err
		}
		type match struct {
			service string
			user    overseerrUser
		}
		matches := []match{}
		for rows.Next() {
			var service, external string
			if err = rows.Scan(&service, &external); err != nil {
				break
			}
			if user, ok := byPlex[external]; ok && external != "" {
				matches = append(matches, match{service, user})
			}
		}
		if err == nil {
			err = rows.Err()
		}
		rows.Close()
		if err != nil {
			return err
		}
		for _, m := range matches {
			if _, err = tx.ExecContext(ctx, "INSERT INTO overseerr_links(service_uuid,server_id,overseerr_user_id,overseerr_username,overseerr_email,synced_at) VALUES(?,?,?,nullif(?,''),nullif(?,''),?)", m.service, server, m.user.ID, m.user.name(), m.user.Email, now); err != nil {
				return err
			}
		}
		_, err = tx.ExecContext(ctx, "UPDATE overseerr_state SET synced_at=?,last_result='succeeded' WHERE server_id=?", now, server)
		return err
	})
	if err == nil {
		err = readErr
	}
	return err
}

type overseerrLinkDTO struct {
	ServerID   int64                 `json:"server_id"`
	ServerName string                `json:"server_name"`
	UserID     *int64                `json:"overseerr_user_id"`
	Username   *string               `json:"overseerr_username"`
	Email      *string               `json:"overseerr_email"`
	Linked     bool                  `json:"is_linked"`
	SyncedAt   *string               `json:"last_sync_at"`
	Requests   []overseerrRequestDTO `json:"requests"`
	Pagination map[string]any        `json:"requests_pagination"`
	Error      *string               `json:"request_error"`

	config overseerrConfig
}

const overseerrProfileLinkLimit = 10

// profileOverseerr returns Overseerr link status for a Plex service account,
// or for every Plex account a human primarily owns, on Overseerr-enabled
// servers. Recent requests are fetched after the read snapshot is released.
func (a *App) profileOverseerr(w http.ResponseWriter, r *http.Request) {
	p, ok := a.principal(w, r, true)
	if !ok {
		return
	}
	if r.URL.RawQuery != "" {
		domainError(w, ErrConflict)
		return
	}
	target := r.PathValue("user")
	if !validAdminMemberCursor(target) {
		domainError(w, ErrNotFound)
		return
	}
	tx, err := a.store.reader.BeginTx(r.Context(), &sql.TxOptions{ReadOnly: true})
	if err != nil {
		domainError(w, err)
		return
	}
	defer tx.Rollback()
	if err = notificationAuthority(r.Context(), tx, p.UUID, bearer(r)); err != nil {
		domainError(w, err)
		return
	}
	var exists bool
	if err = tx.QueryRowContext(r.Context(), "SELECT EXISTS(SELECT 1 FROM identities WHERE uuid=?)", target).Scan(&exists); err != nil || !exists {
		if err == nil {
			err = ErrNotFound
		}
		domainError(w, err)
		return
	}
	rows, err := tx.QueryContext(r.Context(), `SELECT a.server_id,l.overseerr_user_id,l.overseerr_username,l.overseerr_email,l.synced_at FROM service_accounts a
 JOIN media_servers s ON s.id=a.server_id AND s.service_type='plex' AND s.overseerr_enabled=1
 LEFT JOIN overseerr_links l ON l.service_uuid=a.uuid
 WHERE a.uuid=? OR a.uuid IN (SELECT service_uuid FROM service_links WHERE user_uuid=? AND link_kind='owner')
 ORDER BY a.server_id,a.uuid LIMIT ?`, target, target, overseerrProfileLinkLimit+1)
	if err != nil {
		domainError(w, err)
		return
	}
	items := []overseerrLinkDTO{}
	for rows.Next() {
		var item overseerrLinkDTO
		if err = rows.Scan(&item.ServerID, &item.UserID, &item.Username, &item.Email, &item.SyncedAt); err != nil {
			break
		}
		item.Linked = item.UserID != nil
		item.Requests = []overseerrRequestDTO{}
		items = append(items, item)
	}
	if err == nil {
		err = rows.Err()
	}
	rows.Close()
	if err == nil && len(items) > overseerrProfileLinkLimit {
		err = ErrConflict
	}
	for i := range items {
		if err != nil {
			break
		}
		var enabled bool
		items[i].config, enabled, err = readOverseerrConfig(r.Context(), tx, items[i].ServerID)
		items[i].ServerName = items[i].config.Name
		if err == nil && !enabled {
			message := "Overseerr is not active for this server"
			items[i].Error = &message
		}
	}
	if err == nil {
		err = tx.Commit()
	}
	if err != nil {
		domainError(w, err)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()
	for i := range items {
		item := &items[i]
		if !item.Linked || item.Error != nil {
			continue
		}
		client, err := newOverseerrClient(item.config.URL, item.config.key, a.ProviderHTTP)
		if err == nil {
			item.Requests, item.Pagination, err = client.recentRequests(ctx, *item.UserID)
		}
		if err != nil {
			message := overseerrMessage(err)
			item.Requests, item.Pagination, item.Error = []overseerrRequestDTO{}, nil, &message
		}
	}
	respond(w, 200, items)
}
