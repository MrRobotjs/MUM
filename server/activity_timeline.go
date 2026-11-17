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

// A person's play timeline for the user page's History tab (user decisions
// 2026-11-16): MUM's recorded plays and the plays imported from the servers'
// own histories (HISTORY_IMPORT_DESIGN.md) in one list, newest first, each
// marked with where it came from: "mum" or the server's type. The source
// picker offers MUM and each importable service the person has an account on.
// The Streams page, dashboard and statistics keep using MUM's plays only.
//
// It pages by time, not by row number, because the two sources number their
// rows separately. A cursor is "<time>_<source>_<id>", the source "m" for MUM
// or "p" for an imported play; at the same time an imported play sorts before
// a MUM play. Timestamps are stored in one fixed-width UTC
// format, so comparing them as text compares them in time.

// timelinePageSize is the number of plays per page (tests lower it).
var timelinePageSize = 100

type timelineItem struct {
	Source      string  `json:"source"` // "mum" or the server's type
	ID          string  `json:"id"`
	Server      string  `json:"server_id"`
	Service     string  `json:"service_uuid"`
	Kind        string  `json:"media_type"`
	Title       string  `json:"title"`
	ParentTitle *string `json:"parent_title"`
	LibraryName *string `json:"library_name"`
	// When MUM first saw the play, or the time the server recorded for it.
	PlayedAt string `json:"played_at"`
	// Recorded by MUM only; null for imported plays. Position and duration
	// are also known for plays imported from Audiobookshelf.
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
			valid = list[0] == "all" || list[0] == "mum" || slices.Contains(importableHistory, list[0])
			source = list[0]
		case "before":
			cursor, valid = parseTimelineCursor(list[0])
		default:
			valid = false
		}
	}
	if !valid {
		fail(w, 400, "INVALID_TIMELINE_QUERY", "Use scope own/all, source all, mum or a service with imported history, and a cursor from the previous page")
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
	if source == "all" || source == "mum" {
		mum, err := readTimelineMUM(ctx, tx, actor.UUID, q, cursor)
		if err != nil {
			domainError(w, err)
			return
		}
		items = append(items, mum...)
	}
	if source != "mum" {
		imported, err := readTimelineImported(ctx, tx, actor.UUID, q, cursor, strings.TrimPrefix(source, "all"))
		if err != nil {
			domainError(w, err)
			return
		}
		items = append(items, imported...)
	}
	sources, err := readTimelineSources(ctx, tx, q.Target)
	if err != nil {
		domainError(w, err)
		return
	}
	slices.SortFunc(items, func(x, y timelineItem) int { return strings.Compare(y.sortKey, x.sortKey) })
	var next *string
	if len(items) > timelinePageSize {
		items = items[:timelinePageSize]
		last := items[len(items)-1]
		value := last.PlayedAt + "_" + timelineSourceCode(last.Source) + "_" + strconv.FormatInt(last.rowID, 10)
		next = &value
	}
	// Posters: signed, administrator-only links, as on the history list. An
	// imported play uses its own link.
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
			if items[i].Source != "mum" {
				items[i].PosterURL = a.signedImageURL(importedHistoryPosterPurpose, "/api/activity/imported-history-images", session, items[i].rowID, now)
			} else {
				items[i].PosterURL = a.signedImageURL(activityHistoryPosterPurpose, "/api/activity/history-images", session, items[i].rowID, now)
			}
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
	respond(w, 200, map[string]any{"actor_uuid": actor.UUID, "scope": map[bool]string{true: "all", false: "own"}[q.All], "target_uuid": q.Target, "source": source, "sources": sources, "items": items, "next_before": next})
}

// mumPlayFilter limits MUM's plays (h) to the target and, in the own scope,
// to the reader's own. The profile's play totals use it too, so both count
// the same plays.
func mumPlayFilter(actor string, q activityReadQuery) (string, []any) {
	filter, args := activityTargetPredicate(q)
	if !q.All {
		filter += ` AND ` + activityOwnHistory
		args = append(args, actor, actor)
	}
	return filter, args
}

// importedPlayFilter limits imported plays, matched to server accounts (s), to
// the target's accounts and, in the own scope, to accounts the reader owns.
func importedPlayFilter(actor string, q activityReadQuery) (string, []any) {
	var filter string
	var args []any
	if q.Target != "" {
		filter += ` AND (s.uuid=? OR EXISTS(SELECT 1 FROM service_links l WHERE l.service_uuid=s.uuid AND l.user_uuid=? AND l.link_kind='owner'))`
		args = append(args, q.Target, q.Target)
	}
	if !q.All {
		filter += ` AND EXISTS(SELECT 1 FROM service_links l WHERE l.service_uuid=s.uuid AND l.user_uuid=? AND l.link_kind='owner')`
		args = append(args, actor)
	}
	return filter, args
}

// sortKey orders by time, then source ("p" before "m" when descending), then id.
func timelineSortKey(at, source string, id int64) string {
	return at + "_" + source + "_" + strconv.FormatInt(1<<62+id, 10)
}

func readTimelineMUM(ctx context.Context, tx *sql.Tx, actor string, q activityReadQuery, c timelineCursor) ([]timelineItem, error) {
	query := `SELECT h.id,h.server_id,h.service_uuid,h.media_type,h.title,h.parent_title,h.library_name,h.first_seen_at,h.client,h.play_method,h.position_ticks,h.duration_ticks,h.poster_path IS NOT NULL
	 FROM media_activity_history h WHERE (h.first_seen_at<? OR h.first_seen_at=? AND ('m'<? OR ?='m' AND h.id<?))`
	args := []any{c.At, c.At, c.Source, c.Source, c.ID}
	filter, filterArgs := mumPlayFilter(actor, q)
	query += filter
	args = append(args, filterArgs...)
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
// timelineSourceCode is a play's source letter in cursors and sort keys.
func timelineSourceCode(source string) string {
	if source == "mum" {
		return "m"
	}
	return "p"
}

// readTimelineSources are the importable services, in picker order, the
// target has an account on: its own, or those of the accounts it owns. A
// removed account counts too, because its history is kept and shown.
func readTimelineSources(ctx context.Context, tx *sql.Tx, target string) ([]string, error) {
	rows, err := tx.QueryContext(ctx, `SELECT DISTINCT ms.service_type FROM service_accounts sa JOIN media_servers ms ON ms.id=sa.server_id
	 WHERE (sa.uuid=? OR EXISTS(SELECT 1 FROM service_links l WHERE l.service_uuid=sa.uuid AND l.user_uuid=? AND l.link_kind='owner'))`, target, target)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	have := map[string]bool{}
	for rows.Next() {
		var kind string
		if err := rows.Scan(&kind); err != nil {
			return nil, err
		}
		have[kind] = true
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	out := []string{}
	for _, kind := range importableHistory {
		if have[kind] {
			out = append(out, kind)
		}
	}
	return out, nil
}

// readTimelineImported reads plays imported from the servers' own histories,
// of one service type or, when kind is "", of all of them.
func readTimelineImported(ctx context.Context, tx *sql.Tx, actor string, q activityReadQuery, c timelineCursor, kind string) ([]timelineItem, error) {
	query := `SELECT i.rowid,i.server_id,s.uuid,ms.service_type,coalesce(i.media_type,''),coalesce(i.title,''),coalesce(i.grandparent_title,i.parent_title),
	 (SELECT l.name FROM media_libraries l WHERE l.server_id=i.server_id AND l.external_id=i.library_id),i.viewed_at,i.poster_path IS NOT NULL,i.position_seconds,i.duration_seconds
	 FROM history_imports i JOIN media_servers ms ON ms.id=i.server_id JOIN service_accounts s ON s.server_id=i.server_id AND s.external_user_id=i.account_id
	 WHERE (i.viewed_at<? OR i.viewed_at=? AND ?='p' AND i.rowid<?)`
	args := []any{c.At, c.At, c.Source, c.ID}
	if kind != "" {
		query += ` AND ms.service_type=?`
		args = append(args, kind)
	}
	filter, filterArgs := importedPlayFilter(actor, q)
	query += filter
	args = append(args, filterArgs...)
	rows, err := tx.QueryContext(ctx, query+` ORDER BY i.viewed_at DESC,i.rowid DESC LIMIT ?`, append(args, timelinePageSize+1)...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []timelineItem
	for rows.Next() {
		var item timelineItem
		var server int64
		var position, duration sql.NullInt64
		if err := rows.Scan(&item.rowID, &server, &item.Service, &item.Source, &item.Kind, &item.Title, &item.ParentTitle, &item.LibraryName, &item.PlayedAt, &item.hasPoster, &position, &duration); err != nil {
			return nil, err
		}
		ticks := func(v sql.NullInt64) *string {
			if !v.Valid {
				return nil
			}
			text := strconv.FormatInt(v.Int64*10_000_000, 10)
			return &text
		}
		item.Position, item.Duration = ticks(position), ticks(duration)
		item.ID = item.Source + "-" + strconv.FormatInt(item.rowID, 10)
		item.Server = strconv.FormatInt(server, 10)
		item.sortKey = timelineSortKey(item.PlayedAt, "p", item.rowID)
		out = append(out, item)
	}
	return out, rows.Err()
}
