package main

import (
	"context"
	"database/sql"
	"net/http"
	"net/url"
	"slices"
	"strconv"
	"strings"
	"time"
)

// A person's play timeline for the user page's History tab (user decision
// 2026-11-16): MUM's recorded plays and the plays imported from Plex's own
// history in one list, newest first, each marked with where it came from. The
// Streams page, dashboard and statistics keep using MUM's plays only.
//
// It pages by time, not by row number, because the two sources number their
// rows separately. A cursor is "<time>_<source>_<id>"; at the same time a Plex
// play sorts before a MUM play. Timestamps are stored in one fixed-width UTC
// format, so comparing them as text compares them in time.

// timelinePageSize is the number of plays per page (tests lower it).
var timelinePageSize = 100

type timelineItem struct {
	Source      string  `json:"source"` // "mum" or "plex"
	ID          string  `json:"id"`
	Server      string  `json:"server_id"`
	Service     string  `json:"service_uuid"`
	Kind        string  `json:"media_type"`
	Title       string  `json:"title"`
	ParentTitle *string `json:"parent_title"`
	LibraryName *string `json:"library_name"`
	// When MUM first saw the play, or when Plex recorded it as watched.
	PlayedAt string `json:"played_at"`
	// Recorded by MUM only; null for plays from Plex's history.
	Client     *string `json:"client"`
	PlayMethod *string `json:"play_method"`
	Position   *string `json:"position_ticks"`
	Duration   *string `json:"duration_ticks"`
	PosterURL  string  `json:"poster_url,omitempty"`
	hasPoster  bool
	sortKey    string
	rowID      int64
}

type timelineCursor struct {
	At     string
	Source string // "m" or "p"
	ID     int64
}

func parseTimelineCursor(value string) (timelineCursor, bool) {
	parts := strings.Split(value, "_")
	if len(parts) != 3 || parts[1] != "m" && parts[1] != "p" {
		return timelineCursor{}, false
	}
	at, err := time.Parse(time.RFC3339Nano, parts[0])
	id, idErr := strconv.ParseInt(parts[2], 10, 64)
	if err != nil || utcTimestamp(at) != parts[0] || idErr != nil || id < 1 || strconv.FormatInt(id, 10) != parts[2] {
		return timelineCursor{}, false
	}
	return timelineCursor{parts[0], parts[1], id}, true
}

func (a *App) identityTimeline(w http.ResponseWriter, r *http.Request) {
	actor, ok := a.principal(w, r, false)
	if !ok {
		return
	}
	q := activityReadQuery{History: true, Target: r.PathValue("identity")}
	source := "all"
	cursor := timelineCursor{At: "9999", Source: "p", ID: 1 << 62}
	values, err := url.ParseQuery(r.URL.RawQuery)
	valid := err == nil && validAdminMemberCursor(q.Target)
	for key, list := range values {
		if !valid || len(list) != 1 {
			valid = false
			break
		}
		switch key {
		case "scope":
			valid = list[0] == "own" || list[0] == "all"
			q.All = list[0] == "all"
		case "source":
			valid = list[0] == "all" || list[0] == "mum" || list[0] == "plex"
			source = list[0]
		case "before":
			cursor, valid = parseTimelineCursor(list[0])
		default:
			valid = false
		}
	}
	if !valid {
		fail(w, 400, "INVALID_TIMELINE_QUERY", "Use scope own/all, source all/mum/plex and a cursor from the previous page")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	tx, err := a.store.beginActivityView(ctx, actor.UUID, bearer(r), q.All)
	if err != nil {
		domainError(w, err)
		return
	}
	defer tx.Rollback()
	if err := checkActivityTarget(ctx, tx, actor.UUID, q); err != nil {
		domainError(w, err)
		return
	}
	var items []timelineItem
	if source != "plex" {
		mum, err := readTimelineMUM(ctx, tx, actor.UUID, q, cursor)
		if err != nil {
			domainError(w, err)
			return
		}
		items = append(items, mum...)
	}
	if source != "mum" {
		plex, err := readTimelinePlex(ctx, tx, actor.UUID, q, cursor)
		if err != nil {
			domainError(w, err)
			return
		}
		items = append(items, plex...)
	}
	slices.SortFunc(items, func(x, y timelineItem) int { return strings.Compare(y.sortKey, x.sortKey) })
	var next *string
	if len(items) > timelinePageSize {
		items = items[:timelinePageSize]
		last := items[len(items)-1]
		value := last.PlayedAt + "_" + last.Source[:1] + "_" + strconv.FormatInt(last.rowID, 10)
		next = &value
	}
	// Retained MUM posters: signed, administrator-only links, as on the
	// history list. Plays from Plex's history have none.
	if q.All {
		now := time.Now().UTC()
		var session string
		for i := range items {
			if !items[i].hasPoster {
				continue
			}
			if session == "" {
				if session, err = readCatalogueAuthority(ctx, tx, actor.UUID, bearer(r)); err != nil {
					domainError(w, err)
					return
				}
			}
			items[i].PosterURL = a.signedImageURL(activityHistoryPosterPurpose, "/api/activity/history-images", session, items[i].rowID, now)
		}
	}
	if err := tx.Commit(); err != nil {
		domainError(w, err)
		return
	}
	// Authority is checked again right before delivery, as for the history list.
	check, err := a.store.beginActivityView(ctx, actor.UUID, bearer(r), q.All)
	if err == nil {
		err = checkActivityTarget(ctx, check, actor.UUID, q)
		check.Rollback()
	}
	if err != nil {
		domainError(w, err)
		return
	}
	if items == nil {
		items = []timelineItem{}
	}
	respond(w, 200, map[string]any{"actor_uuid": actor.UUID, "scope": map[bool]string{true: "all", false: "own"}[q.All], "target_uuid": q.Target, "source": source, "items": items, "next_before": next})
}

// sortKey orders by time, then source ("p" before "m" when descending), then id.
func timelineSortKey(at, source string, id int64) string {
	return at + "_" + source + "_" + strconv.FormatInt(1<<62+id, 10)
}

func readTimelineMUM(ctx context.Context, tx *sql.Tx, actor string, q activityReadQuery, c timelineCursor) ([]timelineItem, error) {
	query := `SELECT h.id,h.server_id,h.service_uuid,h.media_type,h.title,h.parent_title,h.library_name,h.first_seen_at,h.client,h.play_method,h.position_ticks,h.duration_ticks,h.poster_path IS NOT NULL
	 FROM media_activity_history h WHERE (h.first_seen_at<? OR h.first_seen_at=? AND ('m'<? OR ?='m' AND h.id<?))`
	args := []any{c.At, c.At, c.Source, c.Source, c.ID}
	predicate, targetArgs := activityTargetPredicate(q)
	query += predicate
	args = append(args, targetArgs...)
	if !q.All {
		query += ` AND ` + activityOwnHistory
		args = append(args, actor, actor)
	}
	rows, err := tx.QueryContext(ctx, query+` ORDER BY h.first_seen_at DESC,h.id DESC LIMIT ?`, append(args, timelinePageSize+1)...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []timelineItem
	for rows.Next() {
		item := timelineItem{Source: "mum"}
		var server int64
		var position, duration sql.NullInt64
		if err := rows.Scan(&item.rowID, &server, &item.Service, &item.Kind, &item.Title, &item.ParentTitle, &item.LibraryName, &item.PlayedAt, &item.Client, &item.PlayMethod, &position, &duration, &item.hasPoster); err != nil {
			return nil, err
		}
		item.ID = "mum-" + strconv.FormatInt(item.rowID, 10)
		item.Server = strconv.FormatInt(server, 10)
		if position.Valid {
			v := strconv.FormatInt(position.Int64, 10)
			item.Position = &v
		}
		if duration.Valid {
			v := strconv.FormatInt(duration.Int64, 10)
			item.Duration = &v
		}
		item.sortKey = timelineSortKey(item.PlayedAt, "m", item.rowID)
		out = append(out, item)
	}
	return out, rows.Err()
}

// readTimelinePlex reads imported plays matched to the person's server
// accounts through the Plex account ID, as the purge does. In the own scope
// the account must be linked to the reader.
func readTimelinePlex(ctx context.Context, tx *sql.Tx, actor string, q activityReadQuery, c timelineCursor) ([]timelineItem, error) {
	query := `SELECT i.rowid,i.server_id,s.uuid,coalesce(i.media_type,''),coalesce(i.title,''),coalesce(i.grandparent_title,i.parent_title),
	 (SELECT l.name FROM media_libraries l WHERE l.server_id=i.server_id AND l.external_id=i.library_section_id),i.viewed_at
	 FROM plex_history_imports i JOIN service_accounts s ON s.server_id=i.server_id AND s.external_user_id=i.account_id
	 WHERE (i.viewed_at<? OR i.viewed_at=? AND ?='p' AND i.rowid<?)`
	args := []any{c.At, c.At, c.Source, c.ID}
	if q.Target != "" {
		query += ` AND (s.uuid=? OR EXISTS(SELECT 1 FROM service_links l WHERE l.service_uuid=s.uuid AND l.user_uuid=? AND l.link_kind='owner'))`
		args = append(args, q.Target, q.Target)
	}
	if !q.All {
		query += ` AND EXISTS(SELECT 1 FROM service_links l WHERE l.service_uuid=s.uuid AND l.user_uuid=? AND l.link_kind='owner')`
		args = append(args, actor)
	}
	rows, err := tx.QueryContext(ctx, query+` ORDER BY i.viewed_at DESC,i.rowid DESC LIMIT ?`, append(args, timelinePageSize+1)...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []timelineItem
	for rows.Next() {
		item := timelineItem{Source: "plex"}
		var server int64
		if err := rows.Scan(&item.rowID, &server, &item.Service, &item.Kind, &item.Title, &item.ParentTitle, &item.LibraryName, &item.PlayedAt); err != nil {
			return nil, err
		}
		item.ID = "plex-" + strconv.FormatInt(item.rowID, 10)
		item.Server = strconv.FormatInt(server, 10)
		item.sortKey = timelineSortKey(item.PlayedAt, "p", item.rowID)
		out = append(out, item)
	}
	return out, rows.Err()
}
