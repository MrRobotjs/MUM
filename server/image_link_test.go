package main

import (
	"testing"
	"time"
)

// Live stream updates re-read the same pictures; their links must not change
// within a step, or the browser reloads them and the posters flicker.
func TestImageLinksStayStableBetweenUpdates(t *testing.T) {
	a, _ := testApp(t)
	start := time.Unix(1_800_000_000, 0).Truncate(imageLinkStep)
	first := a.signedImageURL("activity-poster", "/api/activity/images", "session", 7, start.Add(time.Second))
	if again := a.signedImageURL("activity-poster", "/api/activity/images", "session", 7, start.Add(imageLinkStep-time.Second)); again != first {
		t.Fatalf("link changed within a step: %s then %s", first, again)
	}
	if next := a.signedImageURL("activity-poster", "/api/activity/images", "session", 7, start.Add(imageLinkStep)); next == first {
		t.Fatal("link never rotates")
	}
	for _, offset := range []time.Duration{0, time.Second, imageLinkStep - time.Second} {
		now := start.Add(offset)
		left := time.Unix(imageLinkExpiry(now), 0).Sub(now)
		if left < catalogueImageTTL || left > catalogueImageTTL+imageLinkStep {
			t.Fatalf("link valid for %s at offset %s", left, offset)
		}
	}
}
