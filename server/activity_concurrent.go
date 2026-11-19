package main

import (
	"context"
	"database/sql"
	"sort"
)

// Most concurrent streams (user decision 2026-11-19), worked out as Tautulli
// does (plexpy/datafactory.py, most_concurrent): every play becomes a start
// (+1) and a stop (-1); walking them in time order, with a stop before a
// start at the same moment, the highest running count is the peak, the
// latest such peak when it repeats. It is taken for every play and again for
// each play method. Unlike Tautulli, plays still going count (their last
// sighting is their stop so far), and with every server shown the peak is
// across all of them. Only MUM's recordings know when a play started and
// stopped, so imported history never counts.

type concurrentPeak struct {
	Kind    string `json:"kind"` // all, transcode, direct_stream or direct_play
	Count   int    `json:"count"`
	Started string `json:"started"` // when the peak began
	Stopped string `json:"stopped"` // when it first dropped
}

type concurrentSpan struct{ start, stop, method string }

// concurrentKinds are the card's rows, in Tautulli's order.
var concurrentKinds = []string{"all", "transcode", "direct_stream", "direct_play"}

// peakConcurrent is the highest number of spans that overlap, with when that
// peak began and ended. Spans without length never overlap anything.
func peakConcurrent(kind string, spans []concurrentSpan) (concurrentPeak, bool) {
	type event struct {
		at    string
		start bool
	}
	events := []event{}
	for _, span := range spans {
		if span.stop > span.start {
			events = append(events, event{span.start, true}, event{span.stop, false})
		}
	}
	if len(events) == 0 {
		return concurrentPeak{}, false
	}
	sort.SliceStable(events, func(i, j int) bool {
		if events[i].at != events[j].at {
			return events[i].at < events[j].at
		}
		return !events[i].start && events[j].start
	})
	peak := concurrentPeak{Kind: kind}
	count, best, began := 0, 0, ""
	for _, e := range events {
		if e.start {
			count++
			if count >= best {
				began = e.at
			}
			continue
		}
		if count >= best {
			best = count
			peak.Count, peak.Started, peak.Stopped = count, began, e.at
		}
		count--
	}
	return peak, true
}

// readConcurrentPeaks finds the peaks among recorded plays seen since the
// window's start (any time when since is empty), on one server or all (0).
func readConcurrentPeaks(ctx context.Context, tx *sql.Tx, since string, server int64) ([]concurrentPeak, error) {
	rows, err := tx.QueryContext(ctx, `SELECT first_seen_at,last_seen_at,coalesce(play_method,'') FROM media_activity_history
	 WHERE last_seen_at>=? AND (?=0 OR server_id=?)`, since, server, server)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	byKind := map[string][]concurrentSpan{}
	for rows.Next() {
		var span concurrentSpan
		if err := rows.Scan(&span.start, &span.stop, &span.method); err != nil {
			return nil, err
		}
		byKind["all"] = append(byKind["all"], span)
		if span.method != "" {
			byKind[span.method] = append(byKind[span.method], span)
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	peaks := []concurrentPeak{}
	for _, kind := range concurrentKinds {
		if peak, ok := peakConcurrent(kind, byKind[kind]); ok {
			peaks = append(peaks, peak)
		}
	}
	return peaks, nil
}
