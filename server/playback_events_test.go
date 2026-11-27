package main

import (
	"testing"
	"time"

	"app/server/providers/provider"
)

// The socket's playback events wait in memory for the next read: a read
// takes those received up to its own time, they are dropped only after its
// save succeeds, and the list stays bounded.
func TestPlaybackEventsBuffer(t *testing.T) {
	var b playbackEvents
	base := time.Date(2026, 11, 17, 12, 0, 0, 0, time.UTC)
	b.record(1, []provider.PlaybackEvent{{Session: "10", Item: "1", State: "paused"}}, base)
	b.record(1, []provider.PlaybackEvent{{Session: "10", Item: "1", State: "playing"}}, base.Add(5*time.Second))
	b.record(2, []provider.PlaybackEvent{{Session: "20", Item: "2", State: "playing"}}, base)
	got := b.peek(1, base.Add(time.Second))
	if len(got) != 1 || got[0].State != "paused" || !got[0].At.Equal(base) {
		t.Fatalf("peek %+v", got)
	}
	// A failed save keeps them for the next read.
	if again := b.peek(1, base.Add(time.Second)); len(again) != 1 {
		t.Fatal("peek consumed events")
	}
	b.discard(1, base.Add(time.Second))
	if left := b.peek(1, base.Add(time.Minute)); len(left) != 1 || left[0].State != "playing" {
		t.Fatalf("discard %+v", left)
	}
	if other := b.peek(2, base.Add(time.Minute)); len(other) != 1 {
		t.Fatal("another server's events were touched")
	}
	// Bounded: the oldest go first, and stale ones are dropped.
	for i := range playbackEventLimit + 10 {
		b.record(3, []provider.PlaybackEvent{{Session: "s", Item: "1", State: "playing"}}, base.Add(time.Duration(i)*time.Millisecond))
	}
	if all := b.peek(3, base.Add(time.Hour)); len(all) != playbackEventLimit || !all[0].At.Equal(base.Add(10*time.Millisecond)) {
		t.Fatalf("limit: %d first %v", len(all), all[0].At)
	}
	b.record(3, []provider.PlaybackEvent{{Session: "s", Item: "1", State: "paused"}}, base.Add(playbackEventAge+time.Hour))
	if all := b.peek(3, base.Add(playbackEventAge+2*time.Hour)); len(all) != 1 {
		t.Fatalf("stale events kept: %d", len(all))
	}
	b.forget(3)
	if all := b.peek(3, base.Add(2*playbackEventAge)); len(all) != 0 {
		t.Fatal("forget kept events")
	}
}
