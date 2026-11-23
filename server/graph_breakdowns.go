package main

import (
	"cmp"
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"time"
)

// Graphs use recorded observations, not imported play entries, so the same
// playback cannot be counted twice. Missing attributes are reported as unknown.
type graphBreakdownRow struct {
	Label   string           `json:"label"`
	ID      string           `json:"id,omitempty"`
	Plays   map[string]int64 `json:"plays"`
	Seconds map[string]int64 `json:"seconds"`
}

func newBreakdownRow(label, id string) *graphBreakdownRow {
	return &graphBreakdownRow{Label: label, ID: id, Plays: map[string]int64{}, Seconds: map[string]int64{}}
}

func addBreakdown(row *graphBreakdownRow, key string, seconds int64) {
	row.Plays[key]++
	row.Seconds[key] += seconds
}

func topBreakdown(rows map[string]*graphBreakdownRow, rank string) []graphBreakdownRow {
	out := make([]graphBreakdownRow, 0, len(rows))
	for _, row := range rows {
		out = append(out, *row)
	}
	slices.SortFunc(out, func(a, b graphBreakdownRow) int {
		var at, bt int64
		av, bv := a.Plays, b.Plays
		if rank == "seconds" {
			av, bv = a.Seconds, b.Seconds
		}
		for _, n := range av {
			at += n
		}
		for _, n := range bv {
			bt += n
		}
		return cmp.Or(cmp.Compare(bt, at), cmp.Compare(a.Label, b.Label), cmp.Compare(a.ID, b.ID))
	})
	if len(out) > 10 {
		out = out[:10]
	}
	return out
}

type graphIntervalEdge struct {
	at    time.Time
	mode  string
	delta int64
}

// graphNextLocalDay finds the first instant after at on a different local
// calendar day, including days whose midnight is skipped by a clock change.
func graphNextLocalDay(at time.Time, zone *time.Location) time.Time {
	day := at.In(zone).Format("2006-01-02")
	low, high := at, at.Add(48*time.Hour)
	for high.Sub(low) > time.Nanosecond {
		mid := low.Add(high.Sub(low) / 2)
		if mid.In(zone).Format("2006-01-02") == day {
			low = mid
		} else {
			high = mid
		}
	}
	return high
}

// graphLocalDayStart returns the earliest instant on or after a calendar day.
// Midnight is not guaranteed to exist in every timezone.
func graphLocalDayStart(day time.Time, zone *time.Location) time.Time {
	target := day.Format("2006-01-02")
	anchor := time.Date(day.Year(), day.Month(), day.Day(), 0, 0, 0, 0, time.UTC)
	low, high := anchor.Add(-48*time.Hour), anchor.Add(48*time.Hour)
	for high.Sub(low) > time.Nanosecond {
		mid := low.Add(high.Sub(low) / 2)
		if mid.In(zone).Format("2006-01-02") < target {
			low = mid
		} else {
			high = mid
		}
	}
	return high
}

func (a *App) graphBreakdowns(w http.ResponseWriter, r *http.Request) {
	actor, ok := a.principal(w, r, false)
	if !ok {
		return
	}
	values, err := url.ParseQuery(r.URL.RawQuery)
	if err != nil {
		fail(w, 400, "INVALID_GRAPH_QUERY", "Invalid graph filters")
		return
	}
	person := ""
	rank := "plays"
	if ranks, ok := values["rank"]; ok {
		if len(ranks) != 1 || ranks[0] != "plays" && ranks[0] != "seconds" {
			fail(w, 400, "INVALID_GRAPH_QUERY", "Invalid ranking metric")
			return
		}
		rank = ranks[0]
		values.Del("rank")
	}
	if users, ok := values["user"]; ok {
		if len(users) != 1 || users[0] != "all" && !uuidPattern.MatchString(users[0]) {
			fail(w, 400, "INVALID_GRAPH_QUERY", "Invalid user filter")
			return
		}
		if users[0] != "all" {
			person = users[0]
		}
		values.Del("user")
	}
	shadow := &http.Request{URL: &url.URL{RawQuery: values.Encode()}}
	query, err := parseGraphQuery(shadow)
	if err != nil {
		fail(w, 400, "INVALID_GRAPH_QUERY", "Use days 1-365, a valid server and timezone")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	scope := activityReadQuery{All: true, Server: query.Server}
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
	available := false
	for id, fence := range fences {
		active[id] = fence.Active
		if fence.Active {
			available = true
		}
	}
	data, err := readGraphBreakdowns(ctx, tx, query, person, rank, now, active)
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
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"data": data, "meta": map[string]any{"unavailable": !available, "notes": []string{"Recorded activity only; imported plays are not included.", "Concurrent peaks use observed first-to-last intervals and the last recorded delivery mode; actual playback may differ. Mode peaks are independent."}}})
}

func readGraphBreakdowns(ctx context.Context, tx *sql.Tx, q graphQuery, personFilter, rank string, now time.Time, active map[int64]bool) (map[string]any, error) {
	today := zoneToday(now, q.Zone)
	start := graphLocalDayStart(today.AddDate(0, 0, 1-q.Days), q.Zone)
	end := graphLocalDayStart(today.AddDate(0, 0, 1), q.Zone)
	hourly := make([]*graphBreakdownRow, 24)
	for i := range hourly {
		hourly[i] = newBreakdownRow(fmt.Sprintf("%02d:00", i), "")
	}
	daily := make([]*graphBreakdownRow, 0, q.Days)
	concurrent := make([]*graphBreakdownRow, 0, q.Days)
	dailyByDay := map[string]*graphBreakdownRow{}
	edges := map[string][]graphIntervalEdge{}
	dayBoundaries := map[string]time.Time{}
	for d := 0; d < q.Days; d++ {
		label := today.AddDate(0, 0, d+1-q.Days).Format("2006-01-02")
		row := newBreakdownRow(label, "")
		daily = append(daily, row)
		dailyByDay[label] = row
		concurrent = append(concurrent, newBreakdownRow(label, ""))
	}
	usersMedia, usersModes := map[string]*graphBreakdownRow{}, map[string]*graphBreakdownRow{}
	platformsMedia, platformsModes := map[string]*graphBreakdownRow{}, map[string]*graphBreakdownRow{}
	sourceResolutions, streamResolutions := map[string]*graphBreakdownRow{}, map[string]*graphBreakdownRow{}
	var sourceMissing, streamMissing int64
	activeIDs := make([]int64, 0, len(active))
	for id, enabled := range active {
		if enabled {
			activeIDs = append(activeIDs, id)
		}
	}
	slices.Sort(activeIDs)
	activeJSON, err := json.Marshal(activeIDs)
	if err != nil {
		return nil, err
	}
	rows, err := tx.QueryContext(ctx, `SELECT h.server_id,h.first_seen_at,h.last_seen_at,
	 CASE lower(h.media_type) WHEN 'movie' THEN 'movies' WHEN 'episode' THEN 'tv' WHEN 'track' THEN 'music' WHEN 'audio' THEN 'music' WHEN 'photo' THEN 'photos' ELSE 'other' END,
	 coalesce(h.play_method,''),coalesce(h.platform,''),coalesce(h.client,''),coalesce(h.source_resolution,''),coalesce(h.stream_resolution,''),`+mumWatchedSeconds+`,coalesce(h.owner_uuid,h.service_uuid),
	 coalesce((SELECT u.local_username FROM user_accounts u WHERE u.uuid=coalesce(h.owner_uuid,h.service_uuid)),(SELECT sa.external_username FROM service_accounts sa WHERE sa.uuid=coalesce(h.owner_uuid,h.service_uuid)),'Unknown')
	 FROM media_activity_history h WHERE h.first_seen_at<? AND (h.last_seen_at>=? OR h.first_seen_at>=?) AND (?=0 OR h.server_id=?) AND (?='' OR coalesce(h.owner_uuid,h.service_uuid)=?) AND h.server_id IN (SELECT value FROM json_each(?)) LIMIT 100001`, utcTimestamp(end), utcTimestamp(start), utcTimestamp(start), q.Server, q.Server, personFilter, personFilter, string(activeJSON))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	count, edgeCount := 0, 0
	for rows.Next() {
		count++
		if count > 100000 {
			return nil, ErrConflict
		}
		var server, seconds int64
		var first, last, media, mode, platform, client, sourceResolution, streamResolution, person, name string
		if err := rows.Scan(&server, &first, &last, &media, &mode, &platform, &client, &sourceResolution, &streamResolution, &seconds, &person, &name); err != nil {
			return nil, err
		}
		if !active[server] {
			continue
		}
		begin, err := time.Parse(time.RFC3339Nano, first)
		if err != nil {
			return nil, ErrConflict
		}
		finish, err := time.Parse(time.RFC3339Nano, last)
		if err != nil {
			return nil, ErrConflict
		}
		if mode != "direct_play" && mode != "direct_stream" && mode != "transcode" {
			mode = "unknown"
		}
		// Reject implausible durations before summing bounded observations.
		if seconds < 0 || seconds > 3650*24*60*60 {
			return nil, ErrConflict
		}
		if !begin.Before(start) && begin.Before(end) {
			local := begin.In(q.Zone)
			day := local.Format("2006-01-02")
			addBreakdown(hourly[local.Hour()], media, seconds)
			addBreakdown(dailyByDay[day], mode, seconds)
			if strings.TrimSpace(platform) == "" {
				platform = client
			}
			platform = classifyActivityDevice(platform, "")
			if usersMedia[person] == nil {
				if len(usersMedia) >= 10000 {
					return nil, ErrConflict
				}
				usersMedia[person] = newBreakdownRow(name, person)
				usersModes[person] = newBreakdownRow(name, person)
			}
			if platformsMedia[platform] == nil {
				if len(platformsMedia) >= 1000 {
					return nil, ErrConflict
				}
				platformsMedia[platform] = newBreakdownRow(platform, "")
				platformsModes[platform] = newBreakdownRow(platform, "")
			}
			addBreakdown(usersMedia[person], media, seconds)
			addBreakdown(usersModes[person], mode, seconds)
			addBreakdown(platformsMedia[platform], media, seconds)
			addBreakdown(platformsModes[platform], mode, seconds)
			if sourceResolution == "" {
				sourceMissing++
			} else {
				if sourceResolutions[sourceResolution] == nil {
					sourceResolutions[sourceResolution] = newBreakdownRow(sourceResolution, "")
				}
				addBreakdown(sourceResolutions[sourceResolution], "total", seconds)
			}
			if streamResolution == "" {
				streamMissing++
			} else {
				if streamResolutions[streamResolution] == nil {
					streamResolutions[streamResolution] = newBreakdownRow(streamResolution, "")
				}
				addBreakdown(streamResolutions[streamResolution], "total", seconds)
			}
		}
		if begin.Before(start) {
			begin = start
		}
		if finish.After(now) {
			finish = now
		}
		if finish.After(end) {
			finish = end
		}
		for begin.Before(finish) {
			local := begin.In(q.Zone)
			day := local.Format("2006-01-02")
			next, found := dayBoundaries[day]
			if !found {
				next = graphNextLocalDay(begin, q.Zone)
				dayBoundaries[day] = next
			}
			if !next.After(begin) {
				return nil, ErrConflict
			}
			if next.After(finish) {
				next = finish
			}
			edges[day] = append(edges[day], graphIntervalEdge{begin, mode, 1}, graphIntervalEdge{next, mode, -1})
			edgeCount += 2
			if edgeCount > 500000 {
				return nil, ErrConflict
			}
			begin = next
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	for _, row := range concurrent {
		values := edges[row.Label]
		slices.SortFunc(values, func(a, b graphIntervalEdge) int { return cmp.Or(a.at.Compare(b.at), cmp.Compare(a.delta, b.delta)) })
		current := map[string]int64{}
		var total int64
		for _, edge := range values {
			current[edge.mode] += edge.delta
			total += edge.delta
			if current[edge.mode] > row.Plays[edge.mode] {
				row.Plays[edge.mode] = current[edge.mode]
			}
			if total > row.Plays["total"] {
				row.Plays["total"] = total
			}
		}
	}
	return map[string]any{"hourly_media": hourly, "daily_modes": daily, "users_media": topBreakdown(usersMedia, rank), "users_modes": topBreakdown(usersModes, rank), "platforms_media": topBreakdown(platformsMedia, rank), "platforms_modes": topBreakdown(platformsModes, rank), "concurrent_modes": concurrent, "source_resolution": topBreakdown(sourceResolutions, rank), "stream_resolution": topBreakdown(streamResolutions, rank), "source_resolution_missing": sourceMissing, "stream_resolution_missing": streamMissing}, nil
}
