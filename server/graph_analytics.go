package main

import (
	"cmp"
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"net/url"
	"slices"
	"strconv"
	"time"
)

// Graph analytics are aggregates over recorded activity observations from
// currently active activity sources. Datasets with no active source in scope
// are reported unavailable rather than as zero.

type graphQuery struct {
	Days      int
	Server    int64
	Separated bool
}

func parseGraphQuery(r *http.Request) (graphQuery, error) {
	q := graphQuery{Days: 30}
	values, err := url.ParseQuery(r.URL.RawQuery)
	if err != nil {
		return q, ErrConflict
	}
	for key, list := range values {
		if len(list) != 1 {
			return q, ErrConflict
		}
		value := list[0]
		switch key {
		case "days":
			days, err := strconv.Atoi(value)
			if err != nil || strconv.Itoa(days) != value || days < 1 || days > 365 {
				return q, ErrConflict
			}
			q.Days = days
		case "server_id":
			if value == "all" {
				continue
			}
			server, err := strconv.ParseInt(value, 10, 64)
			if err != nil || strconv.FormatInt(server, 10) != value || server < 1 {
				return q, ErrConflict
			}
			q.Server = server
		case "server_mode":
			if value != "combined" && value != "separated" {
				return q, ErrConflict
			}
			q.Separated = value == "separated"
		default:
			return q, ErrConflict
		}
	}
	return q, nil
}

type graphHourly struct {
	Hour  int   `json:"hour"`
	Plays int64 `json:"plays"`
}
type graphServer struct {
	ID          int64  `json:"id"`
	Key         string `json:"key"`
	Name        string `json:"name"`
	ServiceType string `json:"service_type"`
}
type graphSeparatedHourly struct {
	Hour   int              `json:"hour"`
	Label  string           `json:"label"`
	Values map[string]int64 `json:"values"`
}
type graphStack struct {
	Categories []any `json:"categories"`
	Rows       []any `json:"rows"`
}
type graphSeparated struct {
	Enabled   bool                   `json:"enabled"`
	Servers   []graphServer          `json:"servers"`
	Hourly    []graphSeparatedHourly `json:"hourly_activity"`
	WatchTime []any                  `json:"watch_time_activity"`
	Devices   graphStack             `json:"device_preferences"`
	Playback  graphStack             `json:"playback_health"`
}
type graphData struct {
	Hourly    []graphHourly   `json:"hourly_activity"`
	WatchTime []any           `json:"watch_time_activity"`
	Devices   []any           `json:"device_preferences"`
	Playback  []any           `json:"playback_health"`
	Separated *graphSeparated `json:"separated,omitempty"`
}
type graphMeta struct {
	GeneratedAt string            `json:"generated_at"`
	Filters     map[string]any    `json:"filters"`
	Sources     map[string]string `json:"sources"`
	Notes       []string          `json:"notes"`
	Unavailable []string          `json:"unavailable"`
	Playback    map[string]int64  `json:"playback_health"`
}

// graphDeviceCounts holds per-server device buckets and delivery modes for
// observations first seen in the window; rows without recorded values are
// counted only in Considered.
type graphDeviceCounts struct {
	Devices    map[int64]map[string]int64
	Methods    map[int64]map[string]int64
	Considered int64
}

var graphPlaybackModes = []struct{ key, name, color string }{
	{"direct_play", "Direct Play", "#10b981"}, {"direct_stream", "Direct Stream", "#3b82f6"}, {"transcode", "Transcode", "#ef4444"},
}
var graphDevicePalette = []string{"#06b6d4", "#3b82f6", "#8b5cf6", "#64748b", "#f59e0b", "#ec4899"}

func readGraphDevices(ctx context.Context, tx *sql.Tx, q graphQuery, since string, active map[int64]bool) (graphDeviceCounts, error) {
	out := graphDeviceCounts{Devices: map[int64]map[string]int64{}, Methods: map[int64]map[string]int64{}}
	rows, err := tx.QueryContext(ctx, `SELECT h.server_id,coalesce(h.client,''),coalesce(h.device_name,''),coalesce(h.play_method,''),count(*) FROM media_activity_history h
	 WHERE h.first_seen_at>=? AND (?=0 OR h.server_id=?) GROUP BY 1,2,3,4`, since, q.Server, q.Server)
	if err != nil {
		return out, err
	}
	defer rows.Close()
	for rows.Next() {
		var server, count int64
		var client, device, method string
		if err := rows.Scan(&server, &client, &device, &method, &count); err != nil {
			return out, err
		}
		if count < 0 {
			return out, ErrConflict
		}
		if !active[server] {
			continue
		}
		out.Considered += count
		if client != "" || device != "" {
			if out.Devices[server] == nil {
				out.Devices[server] = map[string]int64{}
			}
			out.Devices[server][classifyActivityDevice(client, device)] += count
		}
		if method != "" {
			if out.Methods[server] == nil {
				out.Methods[server] = map[string]int64{}
			}
			out.Methods[server][method] += count
		}
	}
	return out, rows.Err()
}

func graphPercent(part, total int64) int64 {
	if total <= 0 {
		return 0
	}
	return int64(math.Round(float64(part) * 100 / float64(total)))
}

// graphTopBuckets orders buckets by count (then name) and keeps the first
// limit, reporting whether any remain for an "Others" bucket.
func graphTopBuckets(counts map[string]int64, limit int) ([]string, bool) {
	names := make([]string, 0, len(counts))
	for name := range counts {
		names = append(names, name)
	}
	slices.SortFunc(names, func(a, b string) int {
		if counts[a] != counts[b] {
			return cmp.Compare(counts[b], counts[a])
		}
		return cmp.Compare(a, b)
	})
	if len(names) > limit {
		return names[:limit], true
	}
	return names, false
}

// readGraphHourly counts observations first seen inside the window per
// active source and UTC hour. Timestamps are fixed-width UTC, so the window
// is a string comparison and the hour is characters 12-13.
func readGraphHourly(ctx context.Context, tx *sql.Tx, q graphQuery, since string, active map[int64]bool) (map[int64]*[24]int64, error) {
	rows, err := tx.QueryContext(ctx, `SELECT h.server_id,substr(h.first_seen_at,12,2),count(*) FROM media_activity_history h
	 WHERE h.first_seen_at>=? AND (?=0 OR h.server_id=?) GROUP BY h.server_id,substr(h.first_seen_at,12,2)`, since, q.Server, q.Server)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	counts := map[int64]*[24]int64{}
	for rows.Next() {
		var server, count int64
		var hourText string
		if err := rows.Scan(&server, &hourText, &count); err != nil {
			return nil, err
		}
		hour, err := strconv.Atoi(hourText)
		if err != nil || len(hourText) != 2 || hour < 0 || hour > 23 || count < 0 {
			return nil, ErrConflict
		}
		if !active[server] {
			continue
		}
		if counts[server] == nil {
			counts[server] = &[24]int64{}
		}
		counts[server][hour] = count
	}
	return counts, rows.Err()
}

// readGraphWatchTime sums watch seconds per active source and UTC day for
// plays that started on or after startDay, matching the Flask chart: a play
// counts its observed span (last minus first observation), or its last
// recorded position when it was observed only once.
func readGraphWatchTime(ctx context.Context, tx *sql.Tx, q graphQuery, startDay string, active map[int64]bool) (map[int64]map[string]float64, error) {
	rows, err := tx.QueryContext(ctx, `SELECT h.server_id,substr(h.first_seen_at,1,10),
	 sum(CASE WHEN julianday(h.last_seen_at)>julianday(h.first_seen_at) THEN (julianday(h.last_seen_at)-julianday(h.first_seen_at))*86400.0
	  WHEN h.position_ticks>0 THEN h.position_ticks/10000000.0 ELSE 0 END)
	 FROM media_activity_history h WHERE h.first_seen_at>=? AND (?=0 OR h.server_id=?) GROUP BY 1,2`, startDay, q.Server, q.Server)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	seconds := map[int64]map[string]float64{}
	for rows.Next() {
		var server int64
		var day string
		var total float64
		if err := rows.Scan(&server, &day, &total); err != nil {
			return nil, err
		}
		if _, err := time.Parse("2006-01-02", day); err != nil || total < 0 || math.IsNaN(total) || math.IsInf(total, 0) {
			return nil, ErrConflict
		}
		if !active[server] {
			continue
		}
		if seconds[server] == nil {
			seconds[server] = map[string]float64{}
		}
		seconds[server][day] = total
	}
	return seconds, rows.Err()
}

func graphMinutes(seconds float64) float64 { return math.Round(seconds/60*10) / 10 }

func (a *App) graphAnalytics(w http.ResponseWriter, r *http.Request) {
	actor, ok := a.principal(w, r, false)
	if !ok {
		return
	}
	query, err := parseGraphQuery(r)
	if err != nil {
		fail(w, 400, "INVALID_GRAPH_QUERY", "Use days 1-365, server_id all or a canonical positive ID, and server_mode combined or separated")
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
	statuses, fences, err := readActivityStatuses(ctx, tx, actor.UUID, scope, now)
	if err != nil {
		domainError(w, err)
		return
	}
	active := map[int64]bool{}
	for id, fence := range fences {
		active[id] = fence.Active
	}
	servers := []graphServer{}
	if query.Separated && query.Server == 0 {
		rows, err := tx.QueryContext(ctx, `SELECT s.id,s.server_nickname,s.service_type FROM media_activity_state a JOIN media_servers s ON s.id=a.server_id ORDER BY s.id`)
		if err != nil {
			domainError(w, err)
			return
		}
		for rows.Next() {
			var s graphServer
			if err := rows.Scan(&s.ID, &s.Name, &s.ServiceType); err != nil {
				rows.Close()
				domainError(w, err)
				return
			}
			if active[s.ID] {
				s.Key = fmt.Sprintf("s%d", s.ID)
				servers = append(servers, s)
			}
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			domainError(w, err)
			return
		}
		rows.Close()
	}
	since := utcTimestamp(now.Add(-time.Duration(query.Days) * 24 * time.Hour))
	counts, err := readGraphHourly(ctx, tx, query, since, active)
	var devices graphDeviceCounts
	if err == nil {
		devices, err = readGraphDevices(ctx, tx, query, since, active)
	}
	// Watch time uses whole UTC days: today and the days-1 before it.
	days := make([]string, query.Days)
	for i := range days {
		days[i] = now.AddDate(0, 0, i-query.Days+1).Format("2006-01-02")
	}
	var watch map[int64]map[string]float64
	if err == nil {
		watch, err = readGraphWatchTime(ctx, tx, query, days[0], active)
	}
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

	data := graphData{Hourly: make([]graphHourly, 24), WatchTime: []any{}, Devices: []any{}, Playback: []any{}}
	for hour := range data.Hourly {
		data.Hourly[hour].Hour = hour
		for _, perHour := range counts {
			data.Hourly[hour].Plays += perHour[hour]
		}
	}
	combinedDevices, combinedMethods := map[string]int64{}, map[string]int64{}
	var deviceRows, methodRows int64
	for _, perServer := range devices.Devices {
		for name, n := range perServer {
			combinedDevices[name] += n
			deviceRows += n
		}
	}
	for _, perServer := range devices.Methods {
		for name, n := range perServer {
			combinedMethods[name] += n
			methodRows += n
		}
	}
	top, others := graphTopBuckets(combinedDevices, 4)
	var topTotal int64
	for _, name := range top {
		data.Devices = append(data.Devices, map[string]any{"name": name, "value": graphPercent(combinedDevices[name], deviceRows)})
		topTotal += combinedDevices[name]
	}
	if others {
		data.Devices = append(data.Devices, map[string]any{"name": "Others", "value": graphPercent(deviceRows-topTotal, deviceRows)})
	}
	scoped := 0
	for _, status := range statuses {
		if id, _ := strconv.ParseInt(status.Server, 10, 64); active[id] {
			scoped++
		}
	}
	notes := []string{
		"Hourly Activity counts recorded activity observations by the UTC hour they were first seen. An observation is one continuous playback record, not a distinct viewer or a completed watch.",
		"Hours are shown in UTC. Client Device Mix and playback health use the client and delivery mode reported by the provider; observations without them (including all recorded before this version) are not counted.",
		"Watch Time Activity sums, per UTC day a play started, its observed duration (from first to last observation, including pauses), or its last position when it was observed only once.",
	}
	unavailable := []string{}
	if scoped > 0 {
		for _, day := range days {
			var seconds float64
			for _, perServer := range watch {
				seconds += perServer[day]
			}
			data.WatchTime = append(data.WatchTime, map[string]any{"date": day, "label": day, "minutes": graphMinutes(seconds)})
		}
	}
	if scoped > 0 {
		for _, mode := range graphPlaybackModes {
			data.Playback = append(data.Playback, map[string]any{"name": mode.name, "value": combinedMethods[mode.key], "color": mode.color})
		}
	}
	if scoped == 0 {
		// No server in scope records activity: zero would read as "nobody watched".
		unavailable = []string{"device_preferences", "hourly_activity", "playback_health", "watch_time_activity"}
		notes = append(notes, "No active server in this scope records activity history, so Hourly Activity is unavailable.")
	}
	mode := "combined"
	if query.Separated {
		mode = "separated"
		notes = append(notes, "Separated mode lists only active servers that record activity history.")
	}
	if query.Separated && query.Server == 0 {
		separated := &graphSeparated{Enabled: true, Servers: servers, Hourly: make([]graphSeparatedHourly, 24), WatchTime: []any{},
			Devices: graphStack{[]any{}, []any{}}, Playback: graphStack{[]any{}, []any{}}}
		categories, otherDevices := graphTopBuckets(combinedDevices, 5)
		if otherDevices {
			categories = append(categories, "Others")
		}
		for i, name := range categories {
			separated.Devices.Categories = append(separated.Devices.Categories, map[string]any{"key": name, "label": name, "color": graphDevicePalette[i%len(graphDevicePalette)]})
		}
		for _, mode := range graphPlaybackModes {
			separated.Playback.Categories = append(separated.Playback.Categories, map[string]any{"key": mode.name, "label": mode.name, "color": mode.color})
		}
		for _, s := range servers {
			perServer, total := devices.Devices[s.ID], int64(0)
			for _, n := range perServer {
				total += n
			}
			values, countsOut := map[string]int64{}, map[string]int64{}
			for _, name := range categories {
				n := perServer[name]
				if name == "Others" {
					n = 0
					for bucket, c := range perServer {
						if !slices.Contains(categories, bucket) {
							n += c
						}
					}
				}
				countsOut[name], values[name] = n, graphPercent(n, total)
			}
			separated.Devices.Rows = append(separated.Devices.Rows, map[string]any{"server_id": s.ID, "server_key": s.Key, "server_name": s.Name, "service_type": s.ServiceType, "total": total, "values": values, "counts": countsOut})
			methods, methodTotal := devices.Methods[s.ID], int64(0)
			for _, n := range methods {
				methodTotal += n
			}
			pValues, pCounts := map[string]int64{}, map[string]int64{}
			for _, mode := range graphPlaybackModes {
				pCounts[mode.name], pValues[mode.name] = methods[mode.key], graphPercent(methods[mode.key], methodTotal)
			}
			separated.Playback.Rows = append(separated.Playback.Rows, map[string]any{"server_id": s.ID, "server_key": s.Key, "server_name": s.Name, "service_type": s.ServiceType, "total": methodTotal, "values": pValues, "counts": pCounts})
		}
		for hour := range separated.Hourly {
			values := map[string]int64{}
			for _, s := range servers {
				if perHour := counts[s.ID]; perHour != nil {
					values[s.Key] = perHour[hour]
				} else {
					values[s.Key] = 0
				}
			}
			separated.Hourly[hour] = graphSeparatedHourly{hour, fmt.Sprintf("%02d:00", hour), values}
		}
		for _, day := range days {
			values := map[string]float64{}
			for _, s := range servers {
				values[s.Key] = graphMinutes(watch[s.ID][day])
			}
			separated.WatchTime = append(separated.WatchTime, map[string]any{"date": day, "label": day, "values": values})
		}
		data.Separated = separated
	}
	server := "all"
	if query.Server != 0 {
		server = strconv.FormatInt(query.Server, 10)
	}
	meta := graphMeta{
		GeneratedAt: utcTimestamp(now),
		Filters:     map[string]any{"days": query.Days, "server_id": server, "server_mode": mode, "scoped_server_count": scoped},
		Sources: map[string]string{"hourly_activity": "media_activity_history.first_seen_at (UTC)",
			"device_preferences":  "media_activity_history.client and device_name (classified; device names are not returned)",
			"playback_health":     "media_activity_history.play_method (last reported per observation)",
			"watch_time_activity": "media_activity_history first_seen_at/last_seen_at span, else position_ticks (UTC days)"},
		Notes:       notes,
		Unavailable: unavailable,
		Playback:    map[string]int64{"total_rows_considered": devices.Considered, "rows_with_playback_mode": methodRows, "rows_with_device": deviceRows},
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(200)
	_ = json.NewEncoder(w).Encode(map[string]any{"data": data, "meta": meta})
}
