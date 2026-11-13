package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"net/http"
	"strconv"
	"time"
)

// Library statistics and recent activity are derived from retained activity
// observations attributed to the library's stored item catalogue: a movie by its
// own item ID, an episode by its series and a track by its album. Durations are
// observed spans (first to last observation), not exact playback time, and
// observations recorded before parent items were captured are not attributed.

// libraryActivityMatch selects attributed observations for one library since a
// cutoff. Its parameters are library ID, server ID and cutoff.
const libraryActivityMatch = `SELECT h.id AS id,h.title AS title,h.media_type AS media_type,coalesce(h.parent_title,'') AS parent_title,h.first_seen_at AS first_seen_at,
 max(0,CAST(round((julianday(h.last_seen_at)-julianday(h.first_seen_at))*86400) AS INTEGER)) AS observed,
 coalesce(h.owner_uuid,h.service_uuid) AS viewer,i.id AS item,i.title AS item_title,coalesce(i.thumb_path,'') AS tag,
 coalesce((SELECT local_username FROM user_accounts WHERE uuid=h.owner_uuid),(SELECT external_username FROM service_accounts WHERE uuid=h.service_uuid),'') AS viewer_name
 FROM media_activity_history h JOIN media_items i ON i.library_id=? AND i.parent_id IS NULL AND i.external_id=coalesce(h.parent_item_id,h.item_id)
 WHERE h.server_id=? AND h.first_seen_at>=?`

type libraryActivityRequest struct {
	tx      *sql.Tx
	library catalogueLibrary
	days    int
	cutoff  time.Time
	session string
}

func (a *App) beginLibraryActivity(w http.ResponseWriter, r *http.Request) (libraryActivityRequest, bool) {
	var q libraryActivityRequest
	p, ok := a.principal(w, r, true)
	if !ok {
		return q, false
	}
	id, ok := pathID(w, r, "library")
	if !ok {
		return q, false
	}
	q.days = 30
	if raw := r.URL.Query().Get("days"); raw != "" {
		n, err := strconv.Atoi(raw)
		if err != nil || n < 1 || n > 365 {
			fail(w, 400, "INVALID_DAYS", "Use a window of 1 to 365 days")
			return q, false
		}
		q.days = n
	}
	// Truncate to a UTC day so the chart has exactly `days` buckets.
	today := time.Now().UTC().Truncate(24 * time.Hour)
	q.cutoff = today.AddDate(0, 0, -(q.days - 1))
	tx, err := a.store.beginActivityView(r.Context(), p.UUID, bearer(r), true)
	if err != nil {
		domainError(w, err)
		return q, false
	}
	q.tx = tx
	if q.library, err = loadCatalogueLibrary(r.Context(), tx, id); err == nil {
		err = tx.QueryRowContext(r.Context(), "SELECT session_id FROM session_access_tokens WHERE token_hash=?", tokenHash(bearer(r))).Scan(&q.session)
	}
	if err != nil {
		tx.Rollback()
		domainError(w, err)
		return q, false
	}
	return q, true
}

func (q libraryActivityRequest) args() []any {
	return []any{q.library.ID, q.library.Server, utcTimestamp(q.cutoff)}
}

func (a *App) libraryStats(w http.ResponseWriter, r *http.Request) {
	q, ok := a.beginLibraryActivity(w, r)
	if !ok {
		return
	}
	defer q.tx.Rollback()
	ctx := r.Context()
	var streams, viewers, total int64
	if err := q.tx.QueryRowContext(ctx, "SELECT count(*),count(DISTINCT viewer),coalesce(sum(observed),0) FROM ("+libraryActivityMatch+")", q.args()...).Scan(&streams, &viewers, &total); err != nil {
		domainError(w, err)
		return
	}
	trending, err := libraryTrending(ctx, q)
	if err != nil {
		domainError(w, err)
		return
	}
	chart, err := libraryChart(ctx, q)
	if err != nil {
		domainError(w, err)
		return
	}
	var synced bool
	if err := q.tx.QueryRowContext(ctx, "SELECT catalogue_synced_at IS NOT NULL FROM media_libraries WHERE id=?", q.library.ID).Scan(&synced); err != nil {
		domainError(w, err)
		return
	}
	var average int64
	if streams > 0 {
		average = total / streams
	}
	respond(w, 200, map[string]any{
		"library_id": q.library.ID, "days": q.days, "since": utcTimestamp(q.cutoff), "catalogue_synced": synced,
		"basis":      "Retained activity observations attributed through the stored item catalogue; durations are observed spans, not exact playback time.",
		"stats":      map[string]any{"total_streams": streams, "unique_users": viewers, "total_duration": total, "average_session_length": average, "trending_content": trending},
		"chart_data": chart,
	})
}

func libraryTrending(ctx context.Context, q libraryActivityRequest) ([]map[string]any, error) {
	rows, err := q.tx.QueryContext(ctx, "SELECT item_title,count(*) AS n FROM ("+libraryActivityMatch+") GROUP BY item ORDER BY n DESC,item_title COLLATE NOCASE,item LIMIT 10", q.args()...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var title string
		var n int64
		if err := rows.Scan(&title, &n); err != nil {
			return nil, err
		}
		out = append(out, map[string]any{"title": title, "streams": n})
	}
	return out, rows.Err()
}

// libraryChart returns one bucket per UTC day in the window, including empty days.
func libraryChart(ctx context.Context, q libraryActivityRequest) ([]map[string]any, error) {
	rows, err := q.tx.QueryContext(ctx, "SELECT substr(first_seen_at,1,10) AS day,count(*),coalesce(sum(observed),0) FROM ("+libraryActivityMatch+") GROUP BY day", q.args()...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	type bucket struct{ plays, seconds int64 }
	byDay := map[string]bucket{}
	for rows.Next() {
		var day string
		var b bucket
		if err := rows.Scan(&day, &b.plays, &b.seconds); err != nil {
			return nil, err
		}
		byDay[day] = b
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	out := make([]map[string]any, 0, q.days)
	for i := 0; i < q.days; i++ {
		day := q.cutoff.AddDate(0, 0, i).Format("2006-01-02")
		b := byDay[day]
		out = append(out, map[string]any{"label": day, "plays": b.plays, "time": b.seconds / 60})
	}
	return out, nil
}

// itemActivityMatch selects one top-level catalogue item's observations since
// a cutoff with libraryActivityMatch's columns: a movie's own plays, a series'
// episode plays or an album's track plays. Its parameters are item ID, server
// ID and cutoff.
const itemActivityMatch = `SELECT h.id AS id,h.title AS title,h.media_type AS media_type,coalesce(h.parent_title,'') AS parent_title,h.first_seen_at AS first_seen_at,
 max(0,CAST(round((julianday(h.last_seen_at)-julianday(h.first_seen_at))*86400) AS INTEGER)) AS observed,
 coalesce(h.owner_uuid,h.service_uuid) AS viewer,i.id AS item,i.title AS item_title,coalesce(i.thumb_path,'') AS tag,
 coalesce((SELECT local_username FROM user_accounts WHERE uuid=h.owner_uuid),(SELECT external_username FROM service_accounts WHERE uuid=h.service_uuid),'') AS viewer_name
 FROM media_items i JOIN media_activity_history h ON h.server_id=? AND h.first_seen_at>=? AND (h.parent_item_id=i.external_id OR (h.parent_item_id IS NULL AND h.item_id=i.external_id))
 WHERE i.id=?`

// episodeActivityMatch selects one episode's observations since a cutoff with
// libraryActivityMatch's columns. Its parameters are server ID, cutoff and
// episode ID.
const episodeActivityMatch = `SELECT h.id AS id,h.title AS title,h.media_type AS media_type,coalesce(h.parent_title,'') AS parent_title,h.first_seen_at AS first_seen_at,
 max(0,CAST(round((julianday(h.last_seen_at)-julianday(h.first_seen_at))*86400) AS INTEGER)) AS observed,
 coalesce(h.owner_uuid,h.service_uuid) AS viewer,i.id AS item,i.title AS item_title,coalesce(i.thumb_path,'') AS tag,
 coalesce((SELECT local_username FROM user_accounts WHERE uuid=h.owner_uuid),(SELECT external_username FROM service_accounts WHERE uuid=h.service_uuid),'') AS viewer_name
 FROM media_items i JOIN media_activity_history h ON h.server_id=? AND h.first_seen_at>=? AND h.item_id=i.external_id
 WHERE i.id=?`

func activityPage(w http.ResponseWriter, r *http.Request) (int, int, bool) {
	query := r.URL.Query()
	page, size := 1, 20
	for key, target := range map[string]*int{"page": &page, "page_size": &size} {
		if raw := query.Get(key); raw != "" {
			n, err := strconv.Atoi(raw)
			if err != nil || n < 1 || key == "page" && n > 100000 || key == "page_size" && n > 100 {
				fail(w, 400, "INVALID_PAGE", "Use a positive page and a page size from 1 to 100")
				return 0, 0, false
			}
			*target = n
		}
	}
	return page, size, true
}

func (a *App) libraryActivity(w http.ResponseWriter, r *http.Request) {
	page, size, ok := activityPage(w, r)
	if !ok {
		return
	}
	q, ok := a.beginLibraryActivity(w, r)
	if !ok {
		return
	}
	defer q.tx.Rollback()
	a.writeActivityPage(w, r, q, libraryActivityMatch, q.args(), page, size)
}

// itemActivity lists one catalogue item's recent plays, as libraryActivity
// does for the whole library.
func (a *App) itemActivity(w http.ResponseWriter, r *http.Request) {
	page, size, ok := activityPage(w, r)
	if !ok {
		return
	}
	itemID, ok := pathID(w, r, "item")
	if !ok {
		return
	}
	q, ok := a.beginLibraryActivity(w, r)
	if !ok {
		return
	}
	defer q.tx.Rollback()
	var found bool
	if err := q.tx.QueryRowContext(r.Context(), "SELECT EXISTS(SELECT 1 FROM media_items WHERE id=? AND library_id=? AND parent_id IS NULL)", itemID, q.library.ID).Scan(&found); err != nil {
		domainError(w, err)
		return
	}
	if !found {
		domainError(w, ErrNotFound)
		return
	}
	a.writeActivityPage(w, r, q, itemActivityMatch, []any{q.library.Server, utcTimestamp(q.cutoff), itemID}, page, size)
}

// episodeActivity lists one episode's recent plays.
func (a *App) episodeActivity(w http.ResponseWriter, r *http.Request) {
	page, size, ok := activityPage(w, r)
	if !ok {
		return
	}
	itemID, ok := pathID(w, r, "item")
	if !ok {
		return
	}
	episodeID, ok := pathID(w, r, "episode")
	if !ok {
		return
	}
	q, ok := a.beginLibraryActivity(w, r)
	if !ok {
		return
	}
	defer q.tx.Rollback()
	var found bool
	if err := q.tx.QueryRowContext(r.Context(), `SELECT EXISTS(SELECT 1 FROM media_items e JOIN media_items s ON s.id=? AND s.library_id=e.library_id AND s.parent_id IS NULL AND s.item_type='show'
	 WHERE e.id=? AND e.library_id=? AND e.parent_id=s.external_id)`, itemID, episodeID, q.library.ID).Scan(&found); err != nil {
		domainError(w, err)
		return
	}
	if !found {
		domainError(w, ErrNotFound)
		return
	}
	a.writeActivityPage(w, r, q, episodeActivityMatch, []any{q.library.Server, utcTimestamp(q.cutoff), episodeID}, page, size)
}

// writeActivityPage writes one page of the observations match selects.
func (a *App) writeActivityPage(w http.ResponseWriter, r *http.Request, q libraryActivityRequest, match string, args []any, page, size int) {
	ctx := r.Context()
	var total int
	if err := q.tx.QueryRowContext(ctx, "SELECT count(*) FROM ("+match+")", args...).Scan(&total); err != nil {
		domainError(w, err)
		return
	}
	rows, err := q.tx.QueryContext(ctx, "SELECT id,title,media_type,parent_title,first_seen_at,observed,viewer_name,item,tag FROM ("+match+") ORDER BY first_seen_at DESC,id DESC LIMIT ? OFFSET ?", append(args, size, (page-1)*size)...)
	if err != nil {
		domainError(w, err)
		return
	}
	defer rows.Close()
	now := time.Now()
	items := []map[string]any{}
	for rows.Next() {
		var id, observed, item int64
		var title, kind, parent, started, viewer, tag string
		if err := rows.Scan(&id, &title, &kind, &parent, &started, &observed, &viewer, &item, &tag); err != nil {
			domainError(w, err)
			return
		}
		row := map[string]any{"id": id, "media_title": title, "media_type": kind, "grandparent_title": nullableText(parent), "parent_title": nil,
			"user_display_name": viewer, "user_avatar_url": nil, "started_at": started, "duration_seconds": observed, "platform": nil, "player": nil, "thumb_path": nil}
		if tag != "" && q.library.Active {
			row["thumb_path"] = a.catalogueImageURL(q.session, item, now)
		}
		items = append(items, row)
	}
	if rows.Err() != nil {
		domainError(w, rows.Err())
		return
	}
	pages := (total + size - 1) / size
	if pages == 0 {
		pages = 1
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"data": items, "meta": map[string]any{
		"days": q.days, "since": utcTimestamp(q.cutoff),
		"pagination": map[string]int{"page": page, "page_size": size, "total_items": total, "total_pages": pages}}})
}
