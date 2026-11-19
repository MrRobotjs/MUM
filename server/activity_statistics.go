package main

import (
	"context"
	"database/sql"
	"errors"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"time"
)

// The dashboard's Activity card (user decision 2026-11-18): what people used
// across every server type, or on one chosen server. Each server has one
// source, so nothing is counted twice: MUM's recordings for the servers it
// monitors (Plex, Jellyfin, Emby), the imported history for servers it can
// only import from (Audiobookshelf), and nothing for servers that report no
// activity (Kavita, Komga, RomM), which are named so the card can say so.
// Every title names its server, and the reply lists the servers that report,
// for the card's server picker.

// monitoredActivity are the server types MUM records itself.
var monitoredActivity = []string{"plex", "jellyfin", "emby"}

// importedActivity are the server types whose activity comes from imported history.
func importedActivity() []string {
	var kinds []string
	for _, kind := range importableHistory {
		if !slices.Contains(monitoredActivity, kind) {
			kinds = append(kinds, kind)
		}
	}
	return kinds
}

// sqlList quotes fixed server type names for an IN list.
func sqlList(kinds []string) string {
	if len(kinds) == 0 {
		return "''"
	}
	quoted := make([]string, len(kinds))
	for i, kind := range kinds {
		quoted[i] = "'" + strings.ReplaceAll(kind, "'", "''") + "'"
	}
	return strings.Join(quoted, ",")
}

type activityTitle struct {
	Server    int64   `json:"server_id"`
	Title     string  `json:"title"`
	Subtitle  *string `json:"subtitle"`
	Plays     int64   `json:"plays"`
	Seconds   int64   `json:"seconds"`
	PosterURL *string `json:"poster_url"`
	poster    sql.NullInt64
	imported  bool
}

type activitySection struct {
	Kind  string          `json:"kind"` // movies, shows, music or audiobooks
	Items []activityTitle `json:"items"`
}

func (a *App) activityStatistics(w http.ResponseWriter, r *http.Request) {
	p, ok := a.principal(w, r, true)
	if !ok {
		return
	}
	days, server := 7, int64(0)
	for key, values := range r.URL.Query() {
		value, err := strconv.ParseInt(values[0], 10, 64)
		valid := len(values) == 1 && err == nil
		switch key {
		case "days":
			valid = valid && value >= 1 && value <= 90
			days = int(value)
		case "server":
			valid = valid && value >= 1
			server = value
		default:
			valid = false
		}
		if !valid {
			fail(w, 400, "INVALID_STATISTICS_QUERY", "Use days=1–90 and optionally server=<a server that reports activity>")
			return
		}
	}
	ctx := r.Context()
	tx, err := a.store.beginActivityView(ctx, p.UUID, bearer(r), true)
	if err != nil {
		domainError(w, err)
		return
	}
	defer tx.Rollback()
	imported := sqlList(importedActivity())
	monitored := sqlList(monitoredActivity)
	if server != 0 {
		var kind string
		err := tx.QueryRowContext(ctx, "SELECT service_type FROM media_servers WHERE id=?", server).Scan(&kind)
		if errors.Is(err, sql.ErrNoRows) {
			domainError(w, ErrNotFound)
			return
		} else if err != nil {
			domainError(w, err)
			return
		}
		if !slices.Contains(monitoredActivity, kind) && !slices.Contains(importedActivity(), kind) {
			fail(w, 400, "INVALID_STATISTICS_QUERY", "This server doesn't report activity")
			return
		}
	}
	since := utcTimestamp(time.Now().AddDate(0, 0, -days))
	// Each filter takes the window start and the server (0 for every server) twice.
	recordedWhere := ` h.first_seen_at>=? AND (?=0 OR h.server_id=?)`
	importedFrom := ` FROM history_imports im JOIN media_servers s ON s.id=im.server_id WHERE im.viewed_at>=? AND (?=0 OR im.server_id=?) AND s.service_type IN (` + imported + `)`
	window := []any{since, server, server}
	args := func(sets int) []any {
		out := []any{}
		for range sets {
			out = append(out, window...)
		}
		return out
	}

	var totals struct{ plays, seconds, people, titles int64 }
	err = tx.QueryRowContext(ctx, `SELECT
	 (SELECT count(*) FROM media_activity_history h WHERE`+recordedWhere+`)+(SELECT count(*)`+importedFrom+`),
	 (SELECT coalesce(sum(`+mumWatchedSeconds+`),0) FROM media_activity_history h WHERE`+recordedWhere+`)+(SELECT coalesce(sum(im.listened_seconds),0)`+importedFrom+`),
	 (SELECT count(DISTINCT h.server_id||':'||h.item_id) FROM media_activity_history h WHERE`+recordedWhere+`)+(SELECT count(DISTINCT im.server_id||':'||coalesce(im.item_id,im.title))`+importedFrom+`),
	 (SELECT count(DISTINCT person) FROM (
	  SELECT coalesce(h.owner_uuid,h.service_uuid) AS person FROM media_activity_history h WHERE`+recordedWhere+`
	  UNION SELECT coalesce((SELECT l.user_uuid FROM service_links l WHERE l.service_uuid=sa.uuid AND l.link_kind='owner'),sa.uuid,'import:'||im.server_id||':'||im.account_id)
	   FROM history_imports im JOIN media_servers s ON s.id=im.server_id LEFT JOIN service_accounts sa ON sa.server_id=im.server_id AND sa.external_user_id=im.account_id
	   WHERE im.viewed_at>=? AND (?=0 OR im.server_id=?) AND s.service_type IN (`+imported+`)))`,
		args(8)...).Scan(&totals.plays, &totals.seconds, &totals.titles, &totals.people)
	if err != nil {
		domainError(w, err)
		return
	}

	// Top titles per kind; recorded plays group by item, episodes by series
	// and tracks by album, imported listening by item.
	recorded := func(where, key, title string) string {
		return `SELECT h.server_id,` + title + `,NULL,count(*),coalesce(sum(` + mumWatchedSeconds + `),0),max(CASE WHEN h.poster_path IS NOT NULL THEN h.id END)
		 FROM media_activity_history h WHERE` + recordedWhere + ` AND ` + where + ` GROUP BY h.server_id,` + key + `
		 ORDER BY count(*) DESC,sum(` + mumWatchedSeconds + `) DESC,2 LIMIT 5`
	}
	queries := []struct {
		kind, query string
		imported    bool
	}{
		{"movies", recorded(`lower(h.media_type)='movie'`, `h.item_id`, `min(h.title)`), false},
		{"shows", recorded(`lower(h.media_type)='episode'`, `coalesce(h.parent_item_id,h.item_id)`, `coalesce(max(h.parent_title),min(h.title))`), false},
		{"music", recorded(`lower(h.media_type) IN ('track','audio')`, `coalesce(h.parent_item_id,h.item_id)`, `coalesce(max(h.parent_title),min(h.title))`), false},
		{"audiobooks", `SELECT im.server_id,min(coalesce(im.title,'')),max(coalesce(im.grandparent_title,im.parent_title)),count(*),coalesce(sum(im.listened_seconds),0),max(CASE WHEN im.poster_path IS NOT NULL THEN im.rowid END)` +
			importedFrom + ` GROUP BY im.server_id,coalesce(im.item_id,im.title) ORDER BY count(*) DESC,sum(im.listened_seconds) DESC,2 LIMIT 5`, true},
	}
	sections := []activitySection{}
	for _, q := range queries {
		items, err := readActivityTitles(ctx, tx, q.query, window, q.imported)
		if err != nil {
			domainError(w, err)
			return
		}
		if len(items) > 0 {
			sections = append(sections, activitySection{Kind: q.kind, Items: items})
		}
	}

	platforms := []map[string]any{}
	rows, err := tx.QueryContext(ctx, `SELECT h.platform,count(*) FROM media_activity_history h WHERE`+recordedWhere+` AND h.platform IS NOT NULL AND h.platform<>'' GROUP BY h.platform ORDER BY count(*) DESC,h.platform LIMIT 5`, window...)
	if err != nil {
		domainError(w, err)
		return
	}
	for rows.Next() {
		var name string
		var plays int64
		if err := rows.Scan(&name, &plays); err != nil {
			rows.Close()
			domainError(w, err)
			return
		}
		platforms = append(platforms, map[string]any{"name": name, "plays": plays})
	}
	rows.Close()

	// Servers that report activity (the picker), those that don't (the note)
	// and those whose figures come from imported history (with the last import).
	servers, err := readActivityServers(ctx, tx, `SELECT s.id,s.server_nickname,s.service_type,NULL FROM media_servers s WHERE s.service_type IN (`+monitored+`,`+imported+`) ORDER BY lower(s.server_nickname),s.id`)
	if err != nil {
		domainError(w, err)
		return
	}
	unreported, err := readActivityServers(ctx, tx, `SELECT s.id,s.server_nickname,s.service_type,NULL FROM media_servers s WHERE s.service_type NOT IN (`+monitored+`) AND s.service_type NOT IN (`+imported+`) ORDER BY lower(s.server_nickname),s.id`)
	if err != nil {
		domainError(w, err)
		return
	}
	importedServers, err := readActivityServers(ctx, tx, `SELECT s.id,s.server_nickname,s.service_type,(SELECT r.finished_at FROM history_import_runs r WHERE r.server_id=s.id AND r.state='completed')
	 FROM media_servers s WHERE s.service_type IN (`+imported+`) AND (?=0 OR s.id=?) ORDER BY lower(s.server_nickname),s.id`, server, server)
	if err != nil {
		domainError(w, err)
		return
	}
	if err := tx.Commit(); err != nil {
		domainError(w, err)
		return
	}

	// Posters use the History tab's signed links.
	if session, err := a.requestSession(ctx, r); err == nil {
		now := time.Now()
		for i := range sections {
			for j := range sections[i].Items {
				item := &sections[i].Items[j]
				if !item.poster.Valid {
					continue
				}
				var url string
				if item.imported {
					url = a.signedImageURL(importedHistoryPosterPurpose, "/api/activity/imported-history-images", session, item.poster.Int64, now)
				} else {
					url = a.signedImageURL(activityHistoryPosterPurpose, "/api/activity/history-images", session, item.poster.Int64, now)
				}
				item.PosterURL = &url
			}
		}
	}
	var chosen any
	if server != 0 {
		chosen = server
	}
	respond(w, 200, map[string]any{
		"days": days, "server_id": chosen,
		"totals":   map[string]any{"plays": totals.plays, "seconds": totals.seconds, "people": totals.people, "titles": totals.titles},
		"sections": sections, "platforms": platforms, "servers": servers, "unreported": unreported, "imported": importedServers,
	})
}

func readActivityTitles(ctx context.Context, tx *sql.Tx, query string, args []any, imported bool) ([]activityTitle, error) {
	rows, err := tx.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []activityTitle{}
	for rows.Next() {
		var item activityTitle
		var subtitle sql.NullString
		if err := rows.Scan(&item.Server, &item.Title, &subtitle, &item.Plays, &item.Seconds, &item.poster); err != nil {
			return nil, err
		}
		if subtitle.Valid && subtitle.String != "" {
			item.Subtitle = &subtitle.String
		}
		item.imported = imported
		items = append(items, item)
	}
	return items, rows.Err()
}

// readActivityServers lists servers as id, name, type and an optional time
// (the last completed import).
func readActivityServers(ctx context.Context, tx *sql.Tx, query string, args ...any) ([]map[string]any, error) {
	rows, err := tx.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var id int64
		var name, kind string
		var at sql.NullString
		if err := rows.Scan(&id, &name, &kind, &at); err != nil {
			return nil, err
		}
		out = append(out, map[string]any{"server_id": id, "name": name, "service_type": kind, "imported_at": nullableString(at)})
	}
	return out, rows.Err()
}
