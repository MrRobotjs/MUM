package main

import (
	"context"
	"database/sql"
	"errors"
	"net/http"
	"time"

	"app/server/providers/plex"
	"app/server/providers/provider"
)

// Server resource statistics: a media server's own dashboard graphs
// (bandwidth, CPU and memory), read on demand from the server and never
// stored. Only modules that implement statisticsReader offer them.

// statisticsSource checks the administrator and the server, then returns a
// connection to read from; done releases its request slot.
func (a *App) statisticsSource(w http.ResponseWriter, r *http.Request) (statisticsReader, int64, func(), bool) {
	if _, ok := a.principal(w, r, true); !ok {
		return nil, 0, nil, false
	}
	id, ok := pathID(w, r, "server")
	if !ok {
		return nil, 0, nil, false
	}
	var kind, url, apiKey string
	var active bool
	err := a.store.reader.QueryRowContext(r.Context(), `SELECT s.service_type,s.url,coalesce(s.api_key,''),(s.is_active=1 AND coalesce(p.enabled,0)=1)
	 FROM media_servers s LEFT JOIN provider_settings p ON p.provider_id=s.service_type WHERE s.id=?`, id).Scan(&kind, &url, &apiKey, &active)
	if errors.Is(err, sql.ErrNoRows) {
		domainError(w, ErrNotFound)
		return nil, 0, nil, false
	}
	if err != nil {
		domainError(w, err)
		return nil, 0, nil, false
	}
	if _, ok := moduleRules(kind).(statisticsReader); !ok {
		fail(w, 409, "STATISTICS_UNSUPPORTED", "Resource statistics are available for Plex servers")
		return nil, 0, nil, false
	}
	if !active {
		fail(w, 409, "SERVER_INACTIVE", "Turn this server and its provider on to read resource statistics")
		return nil, 0, nil, false
	}
	connection, err := newServerConnection(ProviderConfig{kind, url, apiKey}, a.ProviderHTTP)
	if err != nil {
		domainError(w, ErrConflict)
		return nil, 0, nil, false
	}
	reader, ok := connection.module().(statisticsReader)
	if !ok {
		fail(w, 409, "STATISTICS_UNSUPPORTED", "Resource statistics are available for Plex servers")
		return nil, 0, nil, false
	}
	select {
	case a.statisticsSlots <- struct{}{}:
	default:
		w.Header().Set("Retry-After", "1")
		fail(w, 503, "STATISTICS_BUSY", "Too many statistics requests are in progress")
		return nil, 0, nil, false
	}
	return reader, id, func() { <-a.statisticsSlots }, true
}

func statisticsUnavailable(w http.ResponseWriter) {
	fail(w, 502, "STATISTICS_UNAVAILABLE", "The server did not return its statistics. Check that it is reachable; Plex shows dashboard statistics only to Plex Pass server owners.")
}

func (a *App) serverBandwidth(w http.ResponseWriter, r *http.Request) {
	timespan := r.URL.Query().Get("timespan")
	if timespan == "" {
		timespan = "seconds"
	}
	if !plex.BandwidthTimespan(timespan) {
		fail(w, 400, "INVALID_TIMESPAN", "Use a timespan of seconds, hours, days, weeks or months")
		return
	}
	// since limits the bins to a period ("Last 7 Days"); absent means all.
	var since time.Time
	if raw := r.URL.Query().Get("since"); raw != "" {
		parsed, err := time.Parse(time.RFC3339, raw)
		if err != nil || parsed.Year() < 2000 || parsed.After(time.Now().Add(time.Minute)) {
			fail(w, 400, "INVALID_SINCE", "Use an RFC 3339 time in the past for since")
			return
		}
		since = parsed
	}
	reader, id, done, ok := a.statisticsSource(w, r)
	if !ok {
		return
	}
	defer done()
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	stats, err := reader.Bandwidth(ctx, timespan, since)
	if err != nil {
		statisticsUnavailable(w)
		return
	}
	samples := make([]map[string]any, 0, len(stats.Samples))
	for _, s := range stats.Samples {
		samples = append(samples, map[string]any{"at": utcTimestamp(s.At), "bytes": s.Bytes, "lan": s.LAN, "account_id": nullableText(s.Account), "device_id": nullableText(s.Device)})
	}
	named := func(list []provider.Named) []map[string]string {
		out := make([]map[string]string, 0, len(list))
		for _, n := range list {
			out = append(out, map[string]string{"id": n.ID, "name": n.Name})
		}
		return out
	}
	respond(w, 200, map[string]any{"server_id": id, "timespan": timespan, "generated_at": utcTimestamp(time.Now()), "samples": samples, "accounts": named(stats.Accounts), "devices": named(stats.Devices)})
}

func (a *App) serverResources(w http.ResponseWriter, r *http.Request) {
	reader, id, done, ok := a.statisticsSource(w, r)
	if !ok {
		return
	}
	defer done()
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	readings, err := reader.Resources(ctx)
	if err != nil {
		statisticsUnavailable(w)
		return
	}
	samples := make([]map[string]any, 0, len(readings))
	for _, s := range readings {
		samples = append(samples, map[string]any{"at": utcTimestamp(s.At), "host_cpu": s.HostCPU, "process_cpu": s.ProcessCPU, "host_memory": s.HostMemory, "process_memory": s.ProcessMemory})
	}
	respond(w, 200, map[string]any{"server_id": id, "generated_at": utcTimestamp(time.Now()), "samples": samples})
}
