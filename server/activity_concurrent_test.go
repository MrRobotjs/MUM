package main

import "testing"

// The peak follows Tautulli's rules: overlapping plays add up, a play that
// stops as another starts doesn't overlap it, the latest of equal peaks is
// kept, and plays without length count for nothing.
func TestPeakConcurrent(t *testing.T) {
	span := func(start, stop string) concurrentSpan { return concurrentSpan{start: start, stop: stop} }
	cases := []struct {
		name             string
		spans            []concurrentSpan
		count            int
		started, stopped string
		none             bool
	}{
		{name: "nothing", none: true},
		{name: "no length", spans: []concurrentSpan{span("10", "10")}, none: true},
		{name: "one", spans: []concurrentSpan{span("10", "20")}, count: 1, started: "10", stopped: "20"},
		// Back to back: one at a time, and the later play is the peak kept.
		{name: "back to back", spans: []concurrentSpan{span("10", "20"), span("20", "30")}, count: 1, started: "20", stopped: "30"},
		{name: "overlap", spans: []concurrentSpan{span("10", "40"), span("20", "30"), span("25", "50")}, count: 3, started: "25", stopped: "30"},
		// Two separate peaks of two: the later one.
		{name: "latest of equal peaks", spans: []concurrentSpan{span("10", "20"), span("15", "25"), span("40", "60"), span("50", "70")}, count: 2, started: "50", stopped: "60"},
		{name: "higher earlier peak wins", spans: []concurrentSpan{span("10", "30"), span("12", "30"), span("14", "30"), span("40", "60"), span("50", "70")}, count: 3, started: "14", stopped: "30"},
	}
	for _, c := range cases {
		peak, ok := peakConcurrent("all", c.spans)
		if c.none {
			if ok {
				t.Fatalf("%s: peak %+v", c.name, peak)
			}
			continue
		}
		if !ok || peak.Kind != "all" || peak.Count != c.count || peak.Started != c.started || peak.Stopped != c.stopped {
			t.Fatalf("%s: peak %+v ok=%v", c.name, peak, ok)
		}
	}
}
