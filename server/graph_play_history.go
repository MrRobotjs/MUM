package main

import (
	"cmp"
	"context"
	"database/sql"
	"net/http"
	"net/url"
	"regexp"
	"slices"
	"strings"
	"time"
)

// Play history on the Graphs pages: watched time per period, stacked by media
// type, from MUM's recordings on the servers in scope (imported history has no
// length). Periods are days for up to two weeks, weeks counted back from today
// for up to 120 days, and calendar months beyond that, in the viewer's zone
// like the other graphs. The media and person filters narrow the bars and totals; the
// people list covers everyone who played something in the window, for the
// picker.

var playHistoryMedia = []string{"movies", "tv", "music", "photos", "other"}

var uuidPattern = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

type playHistoryQuery struct {
	graph    graphQuery
	media    string // "" for every type
	person   string // "" for everyone
	interval string
}

type playHistoryBucket struct {
	Start   string           `json:"start"` // first day, YYYY-MM-DD
	End     string           `json:"end"`   // last day, inclusive
	Seconds map[string]int64 `json:"seconds"`
	Plays   map[string]int64 `json:"plays"`
}

type playHistoryPerson struct {
	UUID string `json:"uuid"`
	Name string `json:"name"`
}

func parsePlayHistoryQuery(r *http.Request) (playHistoryQuery, error) {
	values, err := url.ParseQuery(r.URL.RawQuery)
	if err != nil {
		return playHistoryQuery{}, ErrConflict
	}
	q := playHistoryQuery{}
	graph := url.Values{}
	for key, list := range values {
		if len(list) != 1 {
			return q, ErrConflict
		}
		switch key {
		case "interval":
			if list[0] != "day" && list[0] != "month" {
				return q, ErrConflict
			}
			q.interval = list[0]
		case "media":
			if list[0] != "all" && !slices.Contains(playHistoryMedia, list[0]) {
				return q, ErrConflict
			}
			if list[0] != "all" {
				q.media = list[0]
			}
		case "user":
			if list[0] != "all" && !uuidPattern.MatchString(list[0]) {
				return q, ErrConflict
			}
			if list[0] != "all" {
				q.person = list[0]
			}
		case "days", "server_id", "tz":
			graph.Set(key, list[0])
		default:
			return q, ErrConflict
		}
	}
	shadow := &http.Request{URL: &url.URL{RawQuery: graph.Encode()}}
	q.graph, err = parseGraphQuery(shadow)
	return q, err
}

// playHistoryBuckets splits the window ending today into periods.
func playHistoryBuckets(today time.Time, days int) (string, []playHistoryBucket) {
	return playHistoryBucketsInterval(today, days, "")
}

func playHistoryBucketsInterval(today time.Time, days int, interval string) (string, []playHistoryBucket) {
	first := today.AddDate(0, 0, 1-days)
	day := func(t time.Time) string { return t.Format("2006-01-02") }
	buckets := []playHistoryBucket{}
	switch {
	case interval == "day" || interval == "" && days <= 14:
		for d := first; !d.After(today); d = d.AddDate(0, 0, 1) {
			buckets = append(buckets, playHistoryBucket{Start: day(d), End: day(d)})
		}
		return "day", buckets
	case interval == "" && days <= 120:
		// Weeks end today and go back seven days at a time; the oldest may be shorter.
		for end := today; !end.Before(first); end = end.AddDate(0, 0, -7) {
			start := end.AddDate(0, 0, -6)
			if start.Before(first) {
				start = first
			}
			buckets = append([]playHistoryBucket{{Start: day(start), End: day(end)}}, buckets...)
		}
		return "week", buckets
	default:
		for month := time.Date(first.Year(), first.Month(), 1, 0, 0, 0, 0, time.UTC); !month.After(today); month = month.AddDate(0, 1, 0) {
			start, end := month, month.AddDate(0, 1, -1)
			if start.Before(first) {
				start = first
			}
			if end.After(today) {
				end = today
			}
			buckets = append(buckets, playHistoryBucket{Start: day(start), End: day(end)})
		}
		return "month", buckets
	}
}

func (a *App) graphPlayHistory(w http.ResponseWriter, r *http.Request) {
	actor, ok := a.principal(w, r, false)
	if !ok {
		return
	}
	query, err := parsePlayHistoryQuery(r)
	if err != nil {
		fail(w, 400, "INVALID_GRAPH_QUERY", "Use days 1-365, server_id all or a canonical positive ID, media all, movies, tv, music, photos or other, and user all or a person's ID")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	scope := activityReadQuery{All: true, Server: query.graph.Server}
	tx, err := a.store.beginActivityView(ctx, actor.UUID, bearer(r), true)
	if err != nil {
		domainError(w, err)
		return
	}
	defer tx.Rollback()
	now := time.Now().UTC()
	_, fences, err := readActivityStatuses(ctx, tx, actor.UUID, scope, now, a.store.activitySocketConnected)
	if err != nil {
		domainError(w, err)
		return
	}
	active := map[int64]bool{}
	for id, fence := range fences {
		active[id] = fence.Active
	}
	kind, buckets := playHistoryBucketsInterval(zoneToday(now, query.graph.Zone), query.graph.Days, query.interval)
	for i := range buckets {
		buckets[i].Seconds = map[string]int64{}
		buckets[i].Plays = map[string]int64{}
	}
	totals := map[string]int64{}
	for _, media := range playHistoryMedia {
		totals[media] = 0
	}
	first, _ := time.Parse("2006-01-02", buckets[0].Start)
	people, err := readPlayHistory(ctx, tx, query, utcTimestamp(zoneMidnight(first, query.graph.Zone)), buckets, totals, active)
	if err == nil {
		err = tx.Commit()
	}
	if err == nil {
		err = a.store.checkActivityDelivery(ctx, actor.UUID, bearer(r), scope, fences)
	}
	if err != nil {
		domainError(w, err)
		return
	}
	var server, person any = nil, nil
	if query.graph.Server != 0 {
		server = query.graph.Server
	}
	if query.person != "" {
		person = query.person
	}
	media := query.media
	if media == "" {
		media = "all"
	}
	respond(w, 200, map[string]any{"days": query.graph.Days, "server_id": server, "media": media, "user": person,
		"bucket": kind, "buckets": buckets, "totals": totals, "users": people})
}

// readPlayHistory adds the watched time of each play recorded since the
// window start to its period (by its day in the query's zone) and type, and
// lists the people who played something in the window.
func readPlayHistory(ctx context.Context, tx *sql.Tx, q playHistoryQuery, since string, buckets []playHistoryBucket, totals map[string]int64, active map[int64]bool) ([]playHistoryPerson, error) {
	rows, err := tx.QueryContext(ctx, `SELECT h.server_id,`+zoneQuarterColumns("h.first_seen_at")+`,
	 CASE lower(h.media_type) WHEN 'movie' THEN 'movies' WHEN 'episode' THEN 'tv' WHEN 'track' THEN 'music' WHEN 'audio' THEN 'music' WHEN 'photo' THEN 'photos' ELSE 'other' END,
	 `+mumWatchedSeconds+`,coalesce(h.owner_uuid,h.service_uuid),
	 coalesce((SELECT u.local_username FROM user_accounts u WHERE u.uuid=coalesce(h.owner_uuid,h.service_uuid)),
	  (SELECT a.external_username FROM service_accounts a WHERE a.uuid=coalesce(h.owner_uuid,h.service_uuid)),'Unknown')
	 FROM media_activity_history h WHERE h.first_seen_at>=? AND (?=0 OR h.server_id=?)`, since, q.graph.Server, q.graph.Server)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	names := map[string]string{}
	for rows.Next() {
		var server, quarter, seconds int64
		var hour, media, person, name string
		if err := rows.Scan(&server, &hour, &quarter, &media, &seconds, &person, &name); err != nil {
			return nil, err
		}
		at, err := zoneQuarter(hour, quarter, q.graph.Zone)
		if err != nil {
			return nil, ErrConflict
		}
		day := at.Format("2006-01-02")
		if !active[server] {
			continue
		}
		names[person] = name
		if q.media != "" && media != q.media || q.person != "" && person != q.person {
			continue
		}
		// The period holding the play's day; periods are in order and don't overlap.
		i, found := slices.BinarySearchFunc(buckets, day, func(b playHistoryBucket, d string) int {
			switch {
			case b.End < d:
				return -1
			case b.Start > d:
				return 1
			}
			return 0
		})
		if !found {
			continue
		}
		buckets[i].Seconds[media] += seconds
		buckets[i].Plays[media]++
		totals[media] += seconds
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	people := make([]playHistoryPerson, 0, len(names))
	for uuid, name := range names {
		people = append(people, playHistoryPerson{UUID: uuid, Name: name})
	}
	slices.SortFunc(people, func(a, b playHistoryPerson) int {
		return cmp.Or(cmp.Compare(strings.ToLower(a.Name), strings.ToLower(b.Name)), cmp.Compare(a.UUID, b.UUID))
	})
	return people, nil
}
