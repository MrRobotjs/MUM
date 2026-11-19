package main

import (
	"cmp"
	"context"
	"database/sql"
	"net/http"
	"net/url"
	"slices"
	"strconv"
	"time"
)

// A person's play totals for the user page's Profile tab: plays and watched
// time in the last
// 24 hours, 7 days, 30 days and all time, the recent plays, and the players MUM
// saw them use. The source picker is the History tab's: everything, MUM's
// plays, or one service's imported plays, counted with the same filters.
//
// Watched time comes only from MUM's plays: the time MUM saw the play, less
// the paused time it counted (unknown for plays recorded before it counted
// pauses), never more than the item's length. Imported plays say that
// something was played, not for how long (Audiobookshelf reports the book's
// length, not the time listened), so they count as plays without time, and
// each period says how many of its plays have time. Counts are decimal
// strings, as elsewhere.

// A player is an app; Platform is the platform most of its plays reported
// (Plex only), for the logo. Device names stay private.
type playerPlays struct {
	Client   string  `json:"client"`
	Platform *string `json:"platform"`
	Plays    string  `json:"plays"`
}

type playPeriod struct {
	Period  string `json:"period"` // "day", "week", "month" or "all"
	Plays   string `json:"plays"`
	Timed   string `json:"timed_plays"`
	Seconds string `json:"seconds"`
}

type recentPlay struct {
	Source      string  `json:"source"` // "mum" or the server's type
	Kind        string  `json:"media_type"`
	Title       string  `json:"title"`
	ParentTitle *string `json:"parent_title"`
	PlayedAt    string  `json:"played_at"`
	PosterURL   string  `json:"poster_url,omitempty"`
	rowID       int64
	hasPoster   bool
	// For its poster (playPosterURL).
	serverID          int64
	item, parent, art string
}

type identityPlayTotals struct {
	Actor    string        `json:"actor_uuid"`
	Scope    string        `json:"scope"`
	Target   string        `json:"target_uuid"`
	Source   string        `json:"source"`
	Sources  []string      `json:"sources"`
	Imported string        `json:"imported_plays"`
	Periods  []playPeriod  `json:"periods"`
	Recent   []recentPlay  `json:"recent_plays"`
	Players  []playerPlays `json:"players"`
}

// playTotalsPlayers is how many players the totals list, most used first,
// and playTotalsRecent how many recent plays, newest first.
const (
	playTotalsPlayers = 12
	playTotalsRecent  = 12
)

// mumWatchedSeconds is one MUM play's watched time.
const mumWatchedSeconds = `max(0,min(CAST(round((julianday(h.last_seen_at)-julianday(h.first_seen_at))*86400) AS INTEGER)-coalesce(h.paused_seconds,0),coalesce(h.duration_ticks/10000000,9223372036854775807)))`

func (a *App) identityPlayTotals(w http.ResponseWriter, r *http.Request) {
	actor, ok := a.principal(w, r, false)
	if !ok {
		return
	}
	q := activityReadQuery{History: true, Target: r.PathValue("identity")}
	values, err := url.ParseQuery(r.URL.RawQuery)
	scope, source := values["scope"], values["source"]
	if err != nil || !validAdminMemberCursor(q.Target) || len(values) != 2 || len(scope) != 1 || len(source) != 1 || scope[0] != "own" && scope[0] != "all" ||
		source[0] != "all" && source[0] != "mum" && !slices.Contains(importableHistory, source[0]) {
		fail(w, 400, "INVALID_PLAY_TOTALS_QUERY", "Use scope own or all, and source all, mum or a service with imported history")
		return
	}
	q.All = scope[0] == "all"
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
	out, err := queryPlayTotals(ctx, tx, actor.UUID, q, source[0], time.Now().UTC())
	if err == nil {
		out.Sources, err = readTimelineSources(ctx, tx, q.Target)
	}
	// Posters of the recent plays (playPosterURL), signed for administrators.
	if err == nil && q.All && len(out.Recent) > 0 {
		var session string
		if session, err = readCatalogueAuthority(ctx, tx, actor.UUID, bearer(r)); err == nil {
			now := time.Now().UTC()
			for i := range out.Recent {
				p := &out.Recent[i]
				if p.PosterURL, err = a.playPosterURL(ctx, tx, session, playPoster{server: p.serverID, item: p.item, parent: p.parent, art: p.art,
					row: p.rowID, imported: p.Source != "mum", stored: p.hasPoster}, now); err != nil {
					break
				}
			}
		}
	}
	if err == nil {
		err = tx.Commit()
	}
	if err != nil {
		domainError(w, err)
		return
	}
	// Authority is checked again right before delivery, as for the timeline.
	check, err := a.store.beginActivityView(ctx, actor.UUID, bearer(r), q.All)
	if err == nil {
		err = checkActivityTarget(ctx, check, actor.UUID, q)
		check.Rollback()
	}
	if err != nil {
		domainError(w, err)
		return
	}
	out.Actor, out.Scope, out.Target, out.Source = actor.UUID, scope[0], q.Target, source[0]
	respond(w, 200, out)
}

func queryPlayTotals(ctx context.Context, tx *sql.Tx, actor string, q activityReadQuery, source string, now time.Time) (identityPlayTotals, error) {
	mumFilter, mumArgs := mumPlayFilter(actor, q)
	importFilter, importArgs := importedPlayFilter(actor, q)
	importedFrom := ` FROM history_imports i JOIN media_servers ms ON ms.id=i.server_id JOIN service_accounts s ON s.server_id=i.server_id AND s.external_user_id=i.account_id WHERE 1=1` + importFilter
	if source != "all" && source != "mum" {
		importedFrom += ` AND ms.service_type=?`
		importArgs = append(importArgs, source)
	}
	withMUM, withImported := source == "all" || source == "mum", source != "mum"
	since := []string{utcTimestamp(now.Add(-24 * time.Hour)), utcTimestamp(now.Add(-7 * 24 * time.Hour)), utcTimestamp(now.Add(-30 * 24 * time.Hour))}
	// count reads plays and seconds for the last day, week and month and all time.
	type sums struct{ plays, seconds [4]int64 }
	count := func(at, seconds, from string, args []any) (sums, error) {
		var v sums
		period := `coalesce(sum(` + at + `>=?),0),coalesce(sum(CASE WHEN ` + at + `>=? THEN ` + seconds + ` ELSE 0 END),0),`
		err := tx.QueryRowContext(ctx, `SELECT `+period+period+period+`count(*),coalesce(sum(`+seconds+`),0)`+from,
			append([]any{since[0], since[0], since[1], since[1], since[2], since[2]}, args...)...).
			Scan(&v.plays[0], &v.seconds[0], &v.plays[1], &v.seconds[1], &v.plays[2], &v.seconds[2], &v.plays[3], &v.seconds[3])
		return v, err
	}
	var mum, imported sums
	var err error
	if withMUM {
		if mum, err = count("h.first_seen_at", mumWatchedSeconds, ` FROM media_activity_history h WHERE 1=1`+mumFilter, mumArgs); err != nil {
			return identityPlayTotals{}, err
		}
	}
	if withImported {
		if imported, err = count("i.viewed_at", "0", importedFrom, importArgs); err != nil {
			return identityPlayTotals{}, err
		}
	}
	// Every MUM play has time; no imported play does.
	out := identityPlayTotals{Imported: strconv.FormatInt(imported.plays[3], 10), Recent: []recentPlay{}, Players: []playerPlays{}}
	for i, name := range []string{"day", "week", "month", "all"} {
		out.Periods = append(out.Periods, playPeriod{name, strconv.FormatInt(mum.plays[i]+imported.plays[i], 10), strconv.FormatInt(mum.plays[i], 10), strconv.FormatInt(mum.seconds[i], 10)})
	}
	// The newest plays of the chosen sources; at the same time an imported
	// play comes first, as on the History tab.
	read := func(query string, args []any, source string) error {
		rows, err := tx.QueryContext(ctx, query, append(args, playTotalsRecent)...)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			p := recentPlay{Source: source}
			dest := []any{&p.rowID, &p.Kind, &p.Title, &p.ParentTitle, &p.PlayedAt, &p.hasPoster, &p.serverID, &p.item, &p.parent, &p.art}
			if source == "" {
				dest = []any{&p.rowID, &p.Source, &p.Kind, &p.Title, &p.ParentTitle, &p.PlayedAt, &p.hasPoster, &p.serverID, &p.item, &p.parent, &p.art}
			}
			if err := rows.Scan(dest...); err != nil {
				return err
			}
			out.Recent = append(out.Recent, p)
		}
		return rows.Err()
	}
	if withMUM {
		if err := read(`SELECT h.id,h.media_type,h.title,h.parent_title,h.first_seen_at,h.poster_path IS NOT NULL,h.server_id,h.item_id,coalesce(h.parent_item_id,''),coalesce(h.poster_item,'') FROM media_activity_history h WHERE 1=1`+mumFilter+
			` ORDER BY h.first_seen_at DESC,h.id DESC LIMIT ?`, mumArgs, "mum"); err != nil {
			return identityPlayTotals{}, err
		}
	}
	if withImported {
		if err := read(`SELECT i.rowid,ms.service_type,coalesce(i.media_type,''),coalesce(i.title,''),coalesce(i.grandparent_title,i.parent_title),i.viewed_at,i.poster_path IS NOT NULL,i.server_id,coalesce(i.item_id,''),'',coalesce(i.poster_item,'')`+importedFrom+
			` ORDER BY i.viewed_at DESC,i.rowid DESC LIMIT ?`, importArgs, ""); err != nil {
			return identityPlayTotals{}, err
		}
	}
	slices.SortStableFunc(out.Recent, func(x, y recentPlay) int {
		if c := cmp.Compare(y.PlayedAt, x.PlayedAt); c != 0 {
			return c
		}
		return cmp.Compare(boolRank(x.Source == "mum"), boolRank(y.Source == "mum"))
	})
	out.Recent = out.Recent[:min(len(out.Recent), playTotalsRecent)]
	if !withMUM {
		return out, nil
	}
	// Plays per app and platform; each app keeps its most used platform (a tie
	// goes to the first name) and the apps are ranked by all their plays.
	rows, err := tx.QueryContext(ctx, `SELECT h.client,h.platform,count(*) FROM media_activity_history h WHERE h.client IS NOT NULL`+mumFilter+
		` GROUP BY h.client,h.platform ORDER BY h.client,h.platform`, mumArgs...)
	if err != nil {
		return identityPlayTotals{}, err
	}
	defer rows.Close()
	type app struct {
		client, platform string
		plays, best      int64
	}
	var apps []app
	for rows.Next() {
		var client string
		var platform sql.NullString
		var plays int64
		if err := rows.Scan(&client, &platform, &plays); err != nil {
			return identityPlayTotals{}, err
		}
		if len(apps) == 0 || apps[len(apps)-1].client != client {
			apps = append(apps, app{client: client})
		}
		last := &apps[len(apps)-1]
		last.plays += plays
		if platform.Valid && plays > last.best {
			last.platform, last.best = platform.String, plays
		}
	}
	if err := rows.Err(); err != nil {
		return identityPlayTotals{}, err
	}
	slices.SortStableFunc(apps, func(x, y app) int { return cmp.Compare(y.plays, x.plays) })
	for _, a := range apps[:min(len(apps), playTotalsPlayers)] {
		player := playerPlays{Client: a.client, Plays: strconv.FormatInt(a.plays, 10)}
		if a.platform != "" {
			player.Platform = &a.platform
		}
		out.Players = append(out.Players, player)
	}
	return out, nil
}

// boolRank orders false before true.
func boolRank(v bool) int {
	if v {
		return 1
	}
	return 0
}
