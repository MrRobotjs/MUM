package main

import (
	"database/sql"
	"fmt"
	"strings"
	"testing"
	"time"

	"app/server/providers/provider"
)

// How one session's notifications between two reads become pause, stop and
// position, following Tautulli's rules: a pause runs from "paused" to the
// next "playing" or "stopped", and buffering neither starts nor ends one.
func TestPlaybackStretchOutcome(t *testing.T) {
	base := time.Date(2026, 11, 17, 12, 0, 0, 0, time.UTC)
	at := func(s int) time.Time { return base.Add(time.Duration(s) * time.Second) }
	ev := func(s int, state string) provider.PlaybackEvent {
		return provider.PlaybackEvent{Session: "10", Item: "1", State: state, At: at(s)}
	}
	ptr := func(t time.Time) *time.Time { return &t }
	ticks := func(v int64) *int64 { return &v }
	stop := ev(50, "stopped")
	stop.Position = ticks(900)
	for _, c := range []struct {
		name    string
		stretch playbackStretch
		paused  time.Duration
		since   *time.Time
		last    time.Time
		pos     *int64
	}{
		{"pause and resume between reads", playbackStretch{From: at(0), Until: at(60), Observed: true, Events: []provider.PlaybackEvent{ev(10, "paused"), ev(25, "playing")}}, 15 * time.Second, nil, at(60), nil},
		{"pause still running at the read", playbackStretch{From: at(0), Until: at(60), Observed: true, Events: []provider.PlaybackEvent{ev(40, "paused")}}, 20 * time.Second, ptr(at(40)), at(60), nil},
		{"a pause carried over from the last read", playbackStretch{From: at(60), Until: at(120), Observed: true, PausedSince: ptr(at(40)), Events: []provider.PlaybackEvent{ev(90, "playing")}}, 30 * time.Second, nil, at(120), nil},
		{"a pause spanning the whole stretch", playbackStretch{From: at(60), Until: at(120), Observed: true, PausedSince: ptr(at(40)), Paused: true}, 60 * time.Second, ptr(at(40)), at(120), nil},
		{"buffering during a pause keeps it", playbackStretch{From: at(0), Until: at(60), Observed: true, Events: []provider.PlaybackEvent{ev(10, "paused"), ev(20, "buffering"), ev(30, "paused"), ev(40, "playing")}}, 30 * time.Second, nil, at(60), nil},
		{"buffering while playing is not a pause", playbackStretch{From: at(0), Until: at(60), Observed: true, Events: []provider.PlaybackEvent{ev(10, "buffering"), ev(20, "playing")}}, 0, nil, at(60), nil},
		{"stopped while paused ends the pause at the stop", playbackStretch{From: at(0), Until: at(60), Events: []provider.PlaybackEvent{ev(10, "paused"), stop}}, 40 * time.Second, nil, at(50), ticks(900)},
		{"ended with no notifications keeps the last read", playbackStretch{From: at(0), Until: at(60), PausedSince: ptr(at(-5))}, 0, nil, at(0), nil},
		{"ended after a resume: last seen at that notification", playbackStretch{From: at(0), Until: at(60), Events: []provider.PlaybackEvent{ev(5, "paused"), ev(15, "playing")}}, 10 * time.Second, nil, at(15), nil},
		// Without notifications MUM estimates as before: a pause seen at a
		// read counts until the next read.
		{"fallback: paused at the read starts a pause", playbackStretch{From: at(0), Until: at(60), Observed: true, Paused: true}, 0, ptr(at(60)), at(60), nil},
		{"fallback: resumed counts the whole stretch", playbackStretch{From: at(60), Until: at(120), Observed: true, PausedSince: ptr(at(60))}, 60 * time.Second, nil, at(120), nil},
	} {
		got := c.stretch.outcome()
		if got.PausedFor != c.paused || !sameTime(got.PausedSince, c.since) || !got.LastSeen.Equal(c.last) || !sameTicks(got.Position, c.pos) {
			t.Errorf("%s: got paused %v since %v last %v pos %v", c.name, got.PausedFor, got.PausedSince, got.LastSeen, got.Position)
		}
	}
}

func sameTime(a, b *time.Time) bool {
	return a == nil && b == nil || a != nil && b != nil && a.Equal(*b)
}
func sameTicks(a, b *int64) bool { return a == nil && b == nil || a != nil && b != nil && *a == *b }

// Wiring: the save uses the notifications between reads for exact pause and
// stop times, keeps a running pause in the database across reads, records
// Plex's final position, and counts a stop within 10 seconds of the end as
// the full length.
func TestActivitySaveUsesPlaybackEvents(t *testing.T) {
	a, store := testApp(t)
	token, _ := bootstrapOwner(t, a)
	owner, err := store.Authenticate(t.Context(), token)
	if err != nil {
		t.Fatal(err)
	}
	server := createManagedServer(t, a, token, "plex", "http://127.0.0.1:1")
	// apply saves one read; body is the sessions reply, events the
	// notifications (their times are offsets from the read, in seconds).
	apply := func(body string, events ...provider.PlaybackEvent) time.Time {
		claim, err := store.beginActivityRead(t.Context(), owner.UUID, token, server)
		if err != nil {
			t.Fatal(err)
		}
		snapshot, err := parseActivitySnapshot("plex", []byte(body))
		if err != nil {
			t.Fatal(err)
		}
		for i := range events {
			events[i].At = snapshot.ObservedAt.Add(events[i].At.Sub(time.Time{}))
		}
		snapshot.Events = events
		if err := store.write(t.Context(), func(tx *sql.Tx) error {
			_, err := commitActivitySnapshot(t.Context(), tx, claim, snapshot)
			return err
		}); err != nil {
			t.Fatal(err)
		}
		return snapshot.ObservedAt
	}
	ev := func(seconds int, state string) provider.PlaybackEvent {
		return provider.PlaybackEvent{Session: "10", Item: "123", State: state, At: time.Time{}.Add(time.Duration(seconds) * time.Second)}
	}
	// rewind moves every stored time back, as if the reads were minutes apart.
	rewind := func(seconds int) {
		shift := fmt.Sprintf("%+d seconds", -seconds)
		f := func(column string) string {
			return column + "=CASE WHEN " + column + " IS NULL THEN NULL ELSE strftime('%Y-%m-%dT%H:%M:%f000000Z'," + column + ",'" + shift + "') END"
		}
		activityExec(t, store, `UPDATE media_activity_history SET `+f("first_seen_at")+`,`+f("last_seen_at")+`,`+f("paused_since"))
		activityExec(t, store, `UPDATE media_activity_state SET `+f("observed_at"))
	}
	type row struct {
		first, last string
		paused      int64
		since       sql.NullString
		position    int64
		ended       bool
	}
	read := func() row {
		var r row
		if err := store.reader.QueryRow(`SELECT first_seen_at,last_seen_at,paused_seconds,paused_since,position_ticks,ended_at IS NOT NULL FROM media_activity_history WHERE server_id=?`, server).Scan(&r.first, &r.last, &r.paused, &r.since, &r.position, &r.ended); err != nil {
			t.Fatal(err)
		}
		return r
	}
	// First read: playback began 20 s earlier, so it starts at that notification.
	first := apply(plexPlaying, ev(-20, "playing"))
	if r := read(); r.first != utcTimestamp(first.Add(-20*time.Second)) || r.paused != 0 || r.since.Valid {
		t.Fatalf("start %+v", r)
	}
	// 120 s later: paused at -100, resumed at -40, paused again at -10.
	rewind(120)
	second := apply(strings.Replace(plexPlaying, `state="playing"`, `state="paused"`, 1), ev(-100, "paused"), ev(-40, "playing"), ev(-10, "paused"))
	if r := read(); r.paused != 70 || r.since.String != utcTimestamp(second.Add(-10*time.Second)) || r.last != utcTimestamp(second) {
		t.Fatalf("pauses %+v", r)
	}
	// 60 s later, no notifications (socket down): the pause keeps counting.
	rewind(60)
	apply(strings.Replace(plexPlaying, `state="playing"`, `state="paused"`, 1))
	if r := read(); r.paused != 130 || !r.since.Valid {
		t.Fatalf("carried pause %+v", r)
	}
	// 60 s later the session is gone: it stopped at -30 while still paused,
	// 5 s before the end of the 10 s item, so the position counts as the end.
	rewind(60)
	stop := ev(-30, "stopped")
	end := int64(5000 * 10000)
	stop.Position = &end
	third := apply(`<MediaContainer size="0"></MediaContainer>`, stop)
	r := read()
	if !r.ended || r.last != utcTimestamp(third.Add(-30*time.Second)) || r.paused != 160 || r.since.Valid || r.position != 100000000 {
		t.Fatalf("stop %+v", r)
	}
}

// A read uses only its session's notifications for the same item received
// after the previous read and up to its own: earlier ones were already
// counted (or are stale), later ones belong to the next read.
func TestStretchEventsWindow(t *testing.T) {
	base := time.Date(2026, 11, 17, 12, 0, 0, 0, time.UTC)
	ev := func(session, item string, s int) provider.PlaybackEvent {
		return provider.PlaybackEvent{Session: session, Item: item, State: "paused", At: base.Add(time.Duration(s) * time.Second)}
	}
	all := []provider.PlaybackEvent{ev("10", "1", 0), ev("10", "1", 5), ev("11", "1", 6), ev("10", "2", 7), ev("10", "1", 10), ev("10", "1", 11)}
	got := stretchEvents(all, "10", "1", base, base.Add(10*time.Second))
	if len(got) != 2 || !got[0].At.Equal(base.Add(5*time.Second)) || !got[1].At.Equal(base.Add(10*time.Second)) {
		t.Fatalf("window %+v", got)
	}
	if wholeSeconds(-time.Second) != 0 || wholeSeconds(1500*time.Millisecond) != 2 {
		t.Fatal("wholeSeconds")
	}
}
