package main

import (
	"context"
	"math"
	"slices"
	"strings"
	"sync"
	"time"

	"app/server/providers/provider"
)

// Playback events from a server's notification socket (Plex announces each
// pause, resume and stop) wait here, in memory, for the next activity read.
// The read saves their exact times with its snapshot, in the same
// transaction, so the socket never writes to the database itself. Events are
// dropped only after that save succeeds; a restart loses the ones not yet
// saved, and MUM then falls back to its read-to-read estimates.
const (
	playbackEventLimit = 4096             // per server; the oldest go first
	playbackEventAge   = 15 * time.Minute // older ones are of no use to a read
)

type playbackEvents struct {
	mu      sync.Mutex
	servers map[int64][]provider.PlaybackEvent
}

// record adds the events received at at.
func (b *playbackEvents) record(server int64, events []provider.PlaybackEvent, at time.Time) {
	if len(events) == 0 {
		return
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.servers == nil {
		b.servers = map[int64][]provider.PlaybackEvent{}
	}
	list := b.servers[server]
	cutoff := at.Add(-playbackEventAge)
	isTofa := false
	for _, e := range events {
		if e.User != "" || e.Barrier {
			isTofa = true
			break
		}
	}
	if !isTofa {
		for _, e := range list {
			if e.User != "" || e.Barrier {
				isTofa = true
				break
			}
		}
	}
	previous := len(list)
	list = slices.DeleteFunc(list, func(e provider.PlaybackEvent) bool { return e.At.Before(cutoff) })
	if isTofa && len(list) != previous {
		list = append([]provider.PlaybackEvent{{Barrier: true, At: cutoff}}, list...)
	}
	for _, e := range events {
		e.At = at
		list = append(list, e)
	}
	if extra := len(list) - playbackEventLimit; extra > 0 {
		boundary := list[extra-1].At
		list = slices.Delete(list, 0, extra)
		if isTofa {
			list[0] = provider.PlaybackEvent{Barrier: true, At: boundary}
		}
	}
	b.servers[server] = list
}

// Item-less notifications are used only for the same observed account and
// when no session restart or notification gap intervened.
func tofaStretchEvents(events []provider.PlaybackEvent, session, user, item string, from, until time.Time) []provider.PlaybackEvent {
	var out []provider.PlaybackEvent
	for _, e := range events {
		if !e.At.After(from) || e.At.After(until) {
			continue
		}
		if e.Barrier && (e.Session == "" || strings.EqualFold(e.Session, session)) {
			return nil
		}
		if strings.EqualFold(e.Session, session) && e.User != "" && !strings.EqualFold(e.User, user) {
			return nil
		}
		if strings.EqualFold(e.Session, session) && strings.EqualFold(e.User, user) && user != "" {
			e.Item = item
			out = append(out, e)
		}
	}
	return out
}

// peek copies the events received up to until, oldest first.
func (b *playbackEvents) peek(server int64, until time.Time) []provider.PlaybackEvent {
	b.mu.Lock()
	defer b.mu.Unlock()
	var out []provider.PlaybackEvent
	for _, e := range b.servers[server] {
		if !e.At.After(until) {
			out = append(out, e)
		}
	}
	return out
}

// discard drops the events received up to until, after a read saved them.
func (b *playbackEvents) discard(server int64, until time.Time) {
	b.mu.Lock()
	defer b.mu.Unlock()
	list := slices.DeleteFunc(b.servers[server], func(e provider.PlaybackEvent) bool { return !e.At.After(until) })
	if len(list) == 0 {
		delete(b.servers, server)
	} else {
		b.servers[server] = list
	}
}

// forget drops a server's events, when its socket stops.
func (b *playbackEvents) forget(server int64) {
	b.mu.Lock()
	defer b.mu.Unlock()
	delete(b.servers, server)
}

// playbackStretch is one session between two reads: from the previous read
// (or, for a new play, its first notification) until this read. Events are
// the session's notifications for its item within (From, Until], oldest
// first.
type playbackStretch struct {
	From, Until time.Time
	PausedSince *time.Time // the stored start of a running pause
	Events      []provider.PlaybackEvent
	Observed    bool // the session is in this read
	Paused      bool // this read shows it paused (used without notifications)
}

// playbackOutcome is what the stretch adds to the play.
type playbackOutcome struct {
	PausedFor   time.Duration
	PausedSince *time.Time // a pause still running at Until
	LastSeen    time.Time
	Position    *int64 // the stop notification's position
}

// outcome follows these rules for notifications: a pause runs from
// "paused" to the next "playing" or "stopped", and buffering neither starts
// nor ends one. The part of a pause before From was counted by the previous
// read. A play that ended was last seen at its last notification (its stop),
// or at the previous read when none came. Without notifications MUM estimates
// as before: a pause seen at a read lasts until the next read.
func (s playbackStretch) outcome() playbackOutcome {
	out := playbackOutcome{PausedSince: s.PausedSince, LastSeen: s.From}
	endPause := func(at time.Time) {
		if out.PausedSince == nil {
			return
		}
		if start := maxTime(*out.PausedSince, s.From); at.After(start) {
			out.PausedFor += at.Sub(start)
		}
		out.PausedSince = nil
	}
	if len(s.Events) == 0 {
		if !s.Observed {
			out.PausedSince = nil
			return out
		}
		out.LastSeen = s.Until
		if out.PausedSince != nil {
			out.PausedFor = s.Until.Sub(maxTime(*out.PausedSince, s.From))
		}
		if !s.Paused {
			out.PausedSince = nil
		} else if out.PausedSince == nil {
			until := s.Until
			out.PausedSince = &until
		}
		return out
	}
events:
	for _, e := range s.Events {
		out.LastSeen = e.At
		switch e.State {
		case "paused":
			if out.PausedSince == nil {
				at := e.At
				out.PausedSince = &at
			}
		case "playing":
			endPause(e.At)
		case "stopped":
			endPause(e.At)
			out.Position = e.Position
			break events
		}
	}
	if s.Observed {
		// Still playing: a running pause counts up to this read.
		if out.PausedSince != nil {
			out.PausedFor += s.Until.Sub(maxTime(*out.PausedSince, s.From))
		}
		out.LastSeen = s.Until
		out.Position = nil
		return out
	}
	endPause(out.LastSeen)
	return out
}

func maxTime(a, b time.Time) time.Time {
	if a.After(b) {
		return a
	}
	return b
}

// stretchEvents picks one session's notifications for its item received in
// (from, until], oldest first.
func stretchEvents(events []provider.PlaybackEvent, session, item string, from, until time.Time) []provider.PlaybackEvent {
	var out []provider.PlaybackEvent
	for _, e := range events {
		if e.Session == session && e.Item == item && e.At.After(from) && !e.At.After(until) {
			out = append(out, e)
		}
	}
	return out
}

// wholeSeconds rounds a duration to whole seconds, never below zero.
func wholeSeconds(d time.Duration) int64 {
	return max(0, int64(math.Round(d.Seconds())))
}

// optionalTimestamp stores a time, or NULL.
func optionalTimestamp(t *time.Time) any {
	if t == nil {
		return nil
	}
	return utcTimestamp(*t)
}

// saveActivity saves a read with the notifications received up to it, and
// drops them once saved. A failed save keeps them for the next read.
func (a *App) saveActivity(ctx context.Context, c activityReadClaim, snapshot activitySnapshot) (activityApplyResult, error) {
	until := snapshot.ObservedAt
	snapshot.Events = a.playback.peek(c.Server, until)
	result, err := a.store.applyActivitySnapshot(ctx, c, snapshot)
	if err == nil {
		a.playback.discard(c.Server, until)
		a.logActivitySnapshot(c, snapshot)
	}
	return result, err
}
