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

// A person's play timeline for the user page's History tab: one server at a
// time (HISTORY_TOOLBAR_DESIGN.md), with MUM's recorded plays and the plays
// imported from that server's own history (HISTORY_IMPORT_DESIGN.md), newest
// first, each marked with where it came from: "mum" or the server's type. The
// records choice picks both, MUM's only or the server's only; the type and
// stream filters narrow it further. The reply lists every server the person
// has an account on and the categories they have on the one shown.
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
	Client     *string `json:"client"` // the app (Plex's product)
	PlayMethod *string `json:"play_method"`
	Position   *string `json:"position_ticks"`
	Duration   *string `json:"duration_ticks"`
	// MUM's plays only, like Tautulli's columns: the platform, when MUM last
	// saw the play, its paused time (null for plays recorded before MUM kept
	// it) and its watched time, counted as on the Profile tab. The player (a
	// device name) and IP address are for administrators only.
	Platform  *string `json:"platform"`
	Player    *string `json:"player"`
	IP        *string `json:"ip_address"`
	StoppedAt *string `json:"stopped_at"`
	Paused    *string `json:"paused_seconds"`
	Watched   *string `json:"watched_seconds"`
	// A MUM play still being watched; it can't be deleted until it ends.
	InProgress bool `json:"in_progress"`
	// How long an Audiobookshelf session was listened to.
	Listened  *string `json:"listened_seconds"`
	PosterURL string  `json:"poster_url,omitempty"`
	hasPoster bool
	sortKey   string
	rowID     int64
}

// timelineServer is one server the person has an account on. Live servers are
// those MUM records itself; History is false where there is nothing to show
// (Kavita, Komga, RomM).
type timelineServer struct {
	ID      string `json:"server_id"`
	Name    string `json:"name"`
	Type    string `json:"service_type"`
	Live    bool   `json:"live"`
	History bool   `json:"history"`
	id      int64
	newest  string
}

// timelineFilter is what the History tab shows: one server, which records,
// and optional categories and stream methods (any of each matches).
type timelineFilter struct {
	Server         int64
	Records        string // "all", "mum" or "server"
	Types, Methods []string
}

// timelineCategories are the type filters, in toolbar order.
var timelineCategories = []string{"movies", "tv", "music", "videos", "books", "podcasts"}

// historyCategory maps a stored media type, from MUM or any server, to its
// type filter.
func historyCategory(column string) string {
	return `(CASE lower(coalesce(` + column + `,'')) WHEN 'movie' THEN 'movies' WHEN 'episode' THEN 'tv' WHEN 'track' THEN 'music' WHEN 'audio' THEN 'music' WHEN 'musicvideo' THEN 'music'
	 WHEN 'book' THEN 'books' WHEN 'audiobook' THEN 'books' WHEN 'podcast' THEN 'podcasts' WHEN 'podcastepisode' THEN 'podcasts' ELSE 'videos' END)`
}

// parseTimelineList reads a comma list of allowed values, each at most once.
func parseTimelineList(value string, allowed []string) ([]string, bool) {
	parts := strings.Split(value, ",")
	for i, part := range parts {
		if !slices.Contains(allowed, part) || slices.Contains(parts[:i], part) {
			return nil, false
		}
	}
	return parts, true
}

// inList is "column IN (?,?)" with its values.
func inList(column string, values []string) (string, []any) {
	args := make([]any, len(values))
	for i, v := range values {
		args[i] = v
	}
	return ` AND ` + column + ` IN (` + strings.TrimSuffix(strings.Repeat("?,", len(values)), ",") + `)`, args
}

func (f timelineFilter) includesMUM(server timelineServer) bool {
	return f.Records != "server" && server.Live
}

func (f timelineFilter) includesImported(server timelineServer) bool {
	return f.Records != "mum" && server.History && len(f.Methods) == 0
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
	filter := timelineFilter{Records: "all"}
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
		case "server":
			id, err := strconv.ParseInt(list[0], 10, 64)
			valid = err == nil && id > 0 && strconv.FormatInt(id, 10) == list[0]
			filter.Server = id
		case "records":
			valid = list[0] == "all" || list[0] == "mum" || list[0] == "server"
			filter.Records = list[0]
		case "types":
			filter.Types, valid = parseTimelineList(list[0], timelineCategories)
		case "methods":
			filter.Methods, valid = parseTimelineList(list[0], []string{"direct_play", "direct_stream", "transcode"})
		case "before":
			cursor, valid = parseTimelineCursor(list[0])
		default:
			valid = false
		}
	}
	if !valid {
		fail(w, 400, "INVALID_TIMELINE_QUERY", "Use scope own/all, a server ID, records all/mum/server, known types and stream methods, and a cursor from the previous page")
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
	servers, err := readTimelineServers(ctx, tx, actor.UUID, q)
	if err != nil {
		domainError(w, err)
		return
	}
	// The server shown: the one asked for, else the one with the newest play,
	// else the first by name.
	var shown *timelineServer
	for i := range servers {
		if filter.Server != 0 && servers[i].id == filter.Server || filter.Server == 0 && (shown == nil || servers[i].newest > shown.newest) {
			shown = &servers[i]
		}
	}
	if filter.Server != 0 && shown == nil {
		domainError(w, ErrNotFound)
		return
	}
	var items []timelineItem
	categories := []string{}
	var serverID *string
	if shown != nil {
		filter.Server, serverID = shown.id, &shown.ID
		if filter.includesMUM(*shown) {
			mum, err := readTimelineMUM(ctx, tx, actor.UUID, q, cursor, filter)
			if err != nil {
				domainError(w, err)
				return
			}
			items = append(items, mum...)
		}
		if filter.includesImported(*shown) {
			imported, err := readTimelineImported(ctx, tx, actor.UUID, q, cursor, filter)
			if err != nil {
				domainError(w, err)
				return
			}
			items = append(items, imported...)
		}
		if categories, err = readTimelineCategories(ctx, tx, actor.UUID, q, filter, *shown); err != nil {
			domainError(w, err)
			return
		}
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
	respond(w, 200, map[string]any{"actor_uuid": actor.UUID, "scope": map[bool]string{true: "all", false: "own"}[q.All], "target_uuid": q.Target, "server_id": serverID, "records": filter.Records, "servers": servers, "categories": categories, "items": items, "next_before": next})
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

func readTimelineMUM(ctx context.Context, tx *sql.Tx, actor string, q activityReadQuery, c timelineCursor, f timelineFilter) ([]timelineItem, error) {
	query := `SELECT h.id,h.server_id,h.service_uuid,h.media_type,h.title,h.parent_title,h.library_name,h.first_seen_at,h.client,h.play_method,h.position_ticks,h.duration_ticks,h.poster_path IS NOT NULL,
	 h.platform,CASE WHEN ? THEN h.device_name END,CASE WHEN ? THEN h.ip_address END,h.last_seen_at,h.paused_seconds,` + mumWatchedSeconds + `,EXISTS(SELECT 1 FROM media_activity_current c WHERE c.history_id=h.id)
	 FROM media_activity_history h WHERE (h.first_seen_at<? OR h.first_seen_at=? AND ('m'<? OR ?='m' AND h.id<?))`
	args := []any{q.All, q.All, c.At, c.At, c.Source, c.Source, c.ID}
	filter, filterArgs := mumPlayFilter(actor, q)
	query += filter + ` AND h.server_id=?`
	args = append(append(args, filterArgs...), f.Server)
	if len(f.Types) > 0 {
		in, inArgs := inList(historyCategory("h.media_type"), f.Types)
		query, args = query+in, append(args, inArgs...)
	}
	if len(f.Methods) > 0 {
		in, inArgs := inList("h.play_method", f.Methods)
		query, args = query+in, append(args, inArgs...)
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
		var position, duration, paused sql.NullInt64
		var stopped string
		var watched int64
		if err := rows.Scan(&item.rowID, &server, &item.Service, &item.Kind, &item.Title, &item.ParentTitle, &item.LibraryName, &item.PlayedAt, &item.Client, &item.PlayMethod, &position, &duration, &item.hasPoster,
			&item.Platform, &item.Player, &item.IP, &stopped, &paused, &watched, &item.InProgress); err != nil {
			return nil, err
		}
		item.StoppedAt = &stopped
		watchedText := strconv.FormatInt(watched, 10)
		item.Watched = &watchedText
		if paused.Valid {
			v := strconv.FormatInt(paused.Int64, 10)
			item.Paused = &v
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
func readTimelineImported(ctx context.Context, tx *sql.Tx, actor string, q activityReadQuery, c timelineCursor, f timelineFilter) ([]timelineItem, error) {
	query := `SELECT i.rowid,i.server_id,s.uuid,ms.service_type,coalesce(i.media_type,''),coalesce(i.title,''),coalesce(i.grandparent_title,i.parent_title),
	 (SELECT l.name FROM media_libraries l WHERE l.server_id=i.server_id AND l.external_id=i.library_id),i.viewed_at,i.poster_path IS NOT NULL,i.position_seconds,i.duration_seconds,i.listened_seconds
	 FROM history_imports i JOIN media_servers ms ON ms.id=i.server_id JOIN service_accounts s ON s.server_id=i.server_id AND s.external_user_id=i.account_id
	 WHERE (i.viewed_at<? OR i.viewed_at=? AND ?='p' AND i.rowid<?)`
	args := []any{c.At, c.At, c.Source, c.ID, f.Server}
	query += ` AND i.server_id=?`
	if len(f.Types) > 0 {
		in, inArgs := inList(historyCategory("i.media_type"), f.Types)
		query, args = query+in, append(args, inArgs...)
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
		var position, duration, listened sql.NullInt64
		if err := rows.Scan(&item.rowID, &server, &item.Service, &item.Source, &item.Kind, &item.Title, &item.ParentTitle, &item.LibraryName, &item.PlayedAt, &item.hasPoster, &position, &duration, &listened); err != nil {
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
		if listened.Valid {
			v := strconv.FormatInt(listened.Int64, 10)
			item.Listened = &v
		}
		item.ID = item.Source + "-" + strconv.FormatInt(item.rowID, 10)
		item.Server = strconv.FormatInt(server, 10)
		item.sortKey = timelineSortKey(item.PlayedAt, "p", item.rowID)
		out = append(out, item)
	}
	return out, rows.Err()
}

// readTimelineServers lists the servers the target has an account on (its
// own, or those of the accounts it owns, removed ones included because their
// history is kept), by name, with the time of the newest play the reader may
// see on each.
func readTimelineServers(ctx context.Context, tx *sql.Tx, actor string, q activityReadQuery) ([]timelineServer, error) {
	rows, err := tx.QueryContext(ctx, `SELECT ms.id,ms.server_nickname,ms.service_type FROM media_servers ms WHERE EXISTS(SELECT 1 FROM service_accounts sa
	 WHERE sa.server_id=ms.id AND (sa.uuid=? OR EXISTS(SELECT 1 FROM service_links l WHERE l.service_uuid=sa.uuid AND l.user_uuid=? AND l.link_kind='owner')))
	 ORDER BY ms.server_nickname COLLATE NOCASE,ms.id LIMIT 1000`, q.Target, q.Target)
	if err != nil {
		return nil, err
	}
	servers := []timelineServer{}
	index := map[int64]int{}
	for rows.Next() {
		var server timelineServer
		if err := rows.Scan(&server.id, &server.Name, &server.Type); err != nil {
			rows.Close()
			return nil, err
		}
		server.ID = strconv.FormatInt(server.id, 10)
		server.Live = server.Type == "plex" || server.Type == "jellyfin" || server.Type == "emby"
		server.History = server.Live || slices.Contains(importableHistory, server.Type)
		index[server.id] = len(servers)
		servers = append(servers, server)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	mumFilter, mumArgs := mumPlayFilter(actor, q)
	importedFilter, importedArgs := importedPlayFilter(actor, q)
	for _, read := range []struct {
		query string
		args  []any
	}{
		{`SELECT h.server_id,max(h.first_seen_at) FROM media_activity_history h WHERE 1=1` + mumFilter + ` GROUP BY h.server_id`, mumArgs},
		{`SELECT i.server_id,max(i.viewed_at) FROM history_imports i JOIN service_accounts s ON s.server_id=i.server_id AND s.external_user_id=i.account_id WHERE 1=1` + importedFilter + ` GROUP BY i.server_id`, importedArgs},
	} {
		rows, err := tx.QueryContext(ctx, read.query, read.args...)
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			var server int64
			var newest string
			if err := rows.Scan(&server, &newest); err != nil {
				rows.Close()
				return nil, err
			}
			if i, ok := index[server]; ok && newest > servers[i].newest {
				servers[i].newest = newest
			}
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return nil, err
		}
	}
	return servers, nil
}

// readTimelineCategories are the type filters with at least one play on the
// shown server for the chosen records, whatever filters are on.
func readTimelineCategories(ctx context.Context, tx *sql.Tx, actor string, q activityReadQuery, f timelineFilter, server timelineServer) ([]string, error) {
	have := map[string]bool{}
	var reads []string
	var args [][]any
	if f.includesMUM(server) {
		filter, filterArgs := mumPlayFilter(actor, q)
		reads = append(reads, `SELECT DISTINCT `+historyCategory("h.media_type")+` FROM media_activity_history h WHERE h.server_id=?`+filter)
		args = append(args, append([]any{f.Server}, filterArgs...))
	}
	if f.Records != "mum" && server.History {
		filter, filterArgs := importedPlayFilter(actor, q)
		reads = append(reads, `SELECT DISTINCT `+historyCategory("i.media_type")+` FROM history_imports i JOIN service_accounts s ON s.server_id=i.server_id AND s.external_user_id=i.account_id WHERE i.server_id=?`+filter)
		args = append(args, append([]any{f.Server}, filterArgs...))
	}
	for i, query := range reads {
		rows, err := tx.QueryContext(ctx, query, args[i]...)
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			var category string
			if err := rows.Scan(&category); err != nil {
				rows.Close()
				return nil, err
			}
			have[category] = true
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return nil, err
		}
	}
	out := []string{}
	for _, category := range timelineCategories {
		if have[category] {
			out = append(out, category)
		}
	}
	return out, nil
}
