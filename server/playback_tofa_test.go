package main

import (
	"app/server/providers/provider"
	"database/sql"
	"testing"
	"time"
)

func TestTofaEventsRequireUserAndUnbrokenSession(t *testing.T) {
	start := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	events := []provider.PlaybackEvent{{Session: "s", User: "u", State: "paused", At: start.Add(time.Second)}, {Session: "s", User: "u", State: "playing", At: start.Add(4 * time.Second)}, {Session: "s", User: "u", State: "stopped", At: start.Add(6 * time.Second)}}
	bound := tofaStretchEvents(events, "s", "u", "item", start, start.Add(10*time.Second))
	if len(bound) != 3 || bound[0].Item != "item" {
		t.Fatal(bound)
	}
	out := (playbackStretch{From: start, Until: start.Add(10 * time.Second), Events: bound}).outcome()
	if out.PausedFor != 3*time.Second || !out.LastSeen.Equal(start.Add(6*time.Second)) {
		t.Fatal(out)
	}
	if len(tofaStretchEvents(events, "s", "different", "item", start, start.Add(10*time.Second))) != 0 {
		t.Fatal("matched different user")
	}
	foreign := append(append([]provider.PlaybackEvent{}, events...), provider.PlaybackEvent{Session: "s", User: "different", State: "playing", At: start.Add(7 * time.Second)})
	if len(tofaStretchEvents(foreign, "s", "u", "item", start, start.Add(10*time.Second))) != 0 {
		t.Fatal("crossed changed user")
	}
	events = append(events, provider.PlaybackEvent{Session: "s", Barrier: true, At: start.Add(7 * time.Second)})
	if len(tofaStretchEvents(events, "s", "u", "item", start, start.Add(10*time.Second))) != 0 {
		t.Fatal("crossed session boundary")
	}
	events[len(events)-1].Session = ""
	if len(tofaStretchEvents(events, "s", "u", "item", start, start.Add(10*time.Second))) != 0 {
		t.Fatal("crossed missed-event boundary")
	}
}

func TestTofaEventBufferMarksOverflowAndExpiry(t *testing.T) {
	var b playbackEvents
	start := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	for i := range playbackEventLimit + 10 {
		b.record(1, []provider.PlaybackEvent{{Session: "s", User: "u", State: "playing"}}, start.Add(time.Duration(i)*time.Millisecond))
	}
	events := b.peek(1, start.Add(time.Minute))
	if len(events) != playbackEventLimit || len(tofaStretchEvents(events, "s", "u", "item", start.Add(-time.Second), start.Add(time.Minute))) != 0 {
		t.Fatal("overflow did not break attribution")
	}
	b.record(1, []provider.PlaybackEvent{{Session: "s", User: "u", State: "playing"}}, start.Add(2*playbackEventAge))
	events = b.peek(1, start.Add(3*playbackEventAge))
	if len(tofaStretchEvents(events, "s", "u", "item", start, start.Add(3*playbackEventAge))) != 0 {
		t.Fatal("expiry did not break attribution")
	}
}

func TestTofaHistoryUsesPauseAndStopNotifications(t *testing.T) {
	a, store := testApp(t)
	token, _ := bootstrapOwner(t, a)
	owner, err := store.Authenticate(t.Context(), token)
	if err != nil {
		t.Fatal(err)
	}
	server := createManagedServer(t, a, token, "tofa", "http://127.0.0.1:1")
	user := "11234567-89ab-4cde-8fab-0123456789ab"
	session := "01234567-89ab-4cde-8fab-0123456789ab"
	seedExternalService(t, store, server, user)
	play := provider.ActivitySession{Session: session, User: user, Item: "item", Title: "Film", Kind: "Movie"}
	apply := func(sessions []provider.ActivitySession, events []provider.PlaybackEvent) time.Time {
		claim, e := store.beginActivityRead(t.Context(), owner.UUID, token, server)
		if e != nil {
			t.Fatal(e)
		}
		at := time.Now().UTC()
		for i := range events {
			events[i].At = at.Add(events[i].At.Sub(time.Time{}))
		}
		snapshot := provider.ActivitySnapshot{Provider: "tofa", ObservedAt: at, Sessions: sessions, Events: events}
		if e = store.write(t.Context(), func(tx *sql.Tx) error { _, e := commitActivitySnapshot(t.Context(), tx, claim, snapshot); return e }); e != nil {
			t.Fatal(e)
		}
		return at
	}
	apply([]provider.ActivitySession{play}, nil)
	rewind := func() {
		activityExec(t, store, `UPDATE media_activity_history SET last_seen_at=strftime('%Y-%m-%dT%H:%M:%f000000Z',last_seen_at,'-120 seconds'),first_seen_at=strftime('%Y-%m-%dT%H:%M:%f000000Z',first_seen_at,'-120 seconds')`)
	}
	event := func(sec int, state string) provider.PlaybackEvent {
		return provider.PlaybackEvent{Session: session, User: user, State: state, At: time.Time{}.Add(time.Duration(sec) * time.Second)}
	}
	rewind()
	apply([]provider.ActivitySession{play}, []provider.PlaybackEvent{event(-100, "paused"), event(-40, "playing")})
	var paused int
	if err = store.reader.QueryRow("SELECT paused_seconds FROM media_activity_history WHERE server_id=?", server).Scan(&paused); err != nil || paused != 60 {
		t.Fatal(paused, err)
	}
	rewind()
	stop := event(-20, "stopped")
	position := int64(50000000)
	stop.Position = &position
	at := apply([]provider.ActivitySession{}, []provider.PlaybackEvent{event(-70, "paused"), stop})
	var last string
	var pos int64
	if err = store.reader.QueryRow("SELECT last_seen_at,paused_seconds,position_ticks FROM media_activity_history WHERE server_id=?", server).Scan(&last, &paused, &pos); err != nil || paused != 110 || pos != position || last != utcTimestamp(at.Add(-20*time.Second)) {
		t.Fatal(last, paused, pos, err)
	}
}
