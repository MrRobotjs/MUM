package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// The browser receives only configuration status, never the account's tile key.
type streamingMapConfig struct {
	Revision int64  `json:"revision"`
	Key      string `json:"api_key"`
}

func readStreamingMap(ctx context.Context, tx *sql.Tx) (streamingMapConfig, error) {
	c := streamingMapConfig{Revision: 1}
	var raw string
	err := tx.QueryRowContext(ctx, "SELECT value FROM settings WHERE key='CARTO_BASEMAP'").Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return c, nil
	}
	if err != nil {
		return c, err
	}
	err = json.Unmarshal([]byte(raw), &c)
	return c, err
}
func mapSettingsDTO(c streamingMapConfig) map[string]any {
	return map[string]any{"revision": c.Revision, "configured": c.Key != ""}
}
func (a *App) streamingMapSettings(w http.ResponseWriter, r *http.Request) {
	p, ok := a.principal(w, r, true)
	if !ok {
		return
	}
	if r.Method == http.MethodGet {
		tx, err := a.beginAdminRoleRead(r.Context(), p.UUID, bearer(r))
		if err != nil {
			domainError(w, err)
			return
		}
		defer tx.Rollback()
		c, err := readStreamingMap(r.Context(), tx)
		if err != nil {
			domainError(w, err)
			return
		}
		respond(w, 200, mapSettingsDTO(c))
		return
	}
	var input struct {
		Revision int64   `json:"revision"`
		Key      *string `json:"api_key"`
	}
	if !decodeStrictBody(w, r, &input) {
		return
	}
	if input.Key == nil || input.Revision < 1 || len(*input.Key) > 512 || strings.IndexFunc(*input.Key, func(c rune) bool {
		return !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || strings.ContainsRune("-_.~+/=", c))
	}) >= 0 {
		fail(w, 400, "INVALID_MAP_KEY", "Enter only the CARTO API key, without a URL or whitespace")
		return
	}
	var result streamingMapConfig
	err := a.store.write(r.Context(), func(tx *sql.Tx) error {
		if err := notificationAuthority(r.Context(), tx, p.UUID, bearer(r)); err != nil {
			return err
		}
		c, err := readStreamingMap(r.Context(), tx)
		if err != nil {
			return err
		}
		if c.Revision != input.Revision {
			return ErrConflict
		}
		result = streamingMapConfig{Revision: c.Revision + 1, Key: *input.Key}
		raw, _ := json.Marshal(result)
		if err = putSetting(r.Context(), tx, "CARTO_BASEMAP", string(raw)); err != nil {
			return err
		}
		_, err = tx.ExecContext(r.Context(), "INSERT INTO audit_events(actor_uuid,action,details,occurred_at) VALUES(?,'settings.streaming-map.save','{}',?)", p.UUID, utcTimestamp(time.Now()))
		return err
	})
	if err != nil {
		domainError(w, err)
		return
	}
	respond(w, 200, mapSettingsDTO(result))
}

func (a *App) streamingMapTile(w http.ResponseWriter, r *http.Request) {
	p, ok := a.principal(w, r, true)
	if !ok {
		return
	}
	theme := r.PathValue("theme")
	if theme != "dark" && theme != "light" {
		fail(w, 400, "INVALID_TILE", "Invalid map tile")
		return
	}
	values := make([]int, 3)
	for i, name := range []string{"z", "x", "y"} {
		v, err := strconv.Atoi(r.PathValue(name))
		if err != nil || v < 0 || strconv.Itoa(v) != r.PathValue(name) {
			fail(w, 400, "INVALID_TILE", "Invalid map tile")
			return
		}
		values[i] = v
	}
	if values[0] > 12 || values[1] >= 1<<values[0] || values[2] >= 1<<values[0] {
		fail(w, 400, "INVALID_TILE", "Invalid map tile")
		return
	}
	tx, err := a.beginAdminRoleRead(r.Context(), p.UUID, bearer(r))
	if err != nil {
		domainError(w, err)
		return
	}
	c, err := readStreamingMap(r.Context(), tx)
	tx.Rollback()
	if err != nil {
		domainError(w, err)
		return
	}
	if c.Key == "" {
		fail(w, 409, "MAP_KEY_MISSING", "Configure a CARTO basemap key")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 8*time.Second)
	defer cancel()
	target := "https://basemaps.cartocdn.com/" + theme + "_all/" + strconv.Itoa(values[0]) + "/" + strconv.Itoa(values[1]) + "/" + strconv.Itoa(values[2]) + ".png?key=" + url.QueryEscape(c.Key)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		fail(w, 502, "MAP_UNAVAILABLE", "Map tiles unavailable")
		return
	}
	client := http.Client{Timeout: 8 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	if a.ProviderHTTP != nil {
		client.Transport = a.ProviderHTTP.Transport
	}
	res, err := client.Do(req)
	if err != nil {
		fail(w, 502, "MAP_UNAVAILABLE", "Map tiles unavailable; check the CARTO key and quota")
		return
	}
	defer res.Body.Close()
	data, err := io.ReadAll(io.LimitReader(res.Body, (1<<20)+1))
	if err != nil || res.StatusCode != 200 || len(data) > 1<<20 || http.DetectContentType(data) != "image/png" {
		fail(w, 502, "MAP_UNAVAILABLE", "Map tiles unavailable; check the CARTO key and quota")
		return
	}
	// Recheck session/administrator authority and configuration after network I/O.
	tx, err = a.beginAdminRoleRead(r.Context(), p.UUID, bearer(r))
	if err != nil {
		domainError(w, err)
		return
	}
	defer tx.Rollback()
	current, err := readStreamingMap(r.Context(), tx)
	if err != nil {
		domainError(w, err)
		return
	}
	if current.Revision != c.Revision {
		fail(w, 409, "MAP_CHANGED", "Map configuration changed")
		return
	}
	w.Header().Set("Content-Type", "image/png")
	w.Header().Set("Cache-Control", "private, no-store")
	w.WriteHeader(200)
	_, _ = w.Write(data)
}
