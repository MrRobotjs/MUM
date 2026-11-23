package plex

import "testing"

func TestSessionResolutionCapture(t *testing.T) {
	const body = `<MediaContainer size="1"><Video ratingKey="123" type="movie"><Player state="playing"/><Media videoResolution="1080" height="804"/><TranscodeSession videoDecision="transcode" height="480"/></Video></MediaContainer>`
	displays, err := ParseDisplays([]byte(body))
	if err != nil || len(displays) != 1 {
		t.Fatalf("display: %v", err)
	}
	if displays[0].StreamResolution != "480p" {
		t.Fatalf("stream resolution %q", displays[0].StreamResolution)
	}
	if displays[0].SourceResolution != "" {
		t.Fatalf("unverified source resolution %q", displays[0].SourceResolution)
	}
}

func TestSourceResolutionCapture(t *testing.T) {
	live := DisplayRow{Kind: "movie", Media: []DisplayMedia{{ID: "7"}}}
	original := DisplayRow{Media: []DisplayMedia{{ID: "7", Resolution: "1080", Height: 804}}}
	displays, err := ParseDisplays([]byte(`<MediaContainer size="1"><Video type="movie"><Player state="playing"/></Video></MediaContainer>`))
	if err != nil || len(displays) != 1 {
		t.Fatal(err)
	}
	ApplySourceDisplay(displays[0], live, original)
	if displays[0].SourceResolution != "1080p" || displays[0].StreamResolution != "" {
		t.Fatalf("source %q output %q", displays[0].SourceResolution, displays[0].StreamResolution)
	}
	// A selected video stream explicitly reported as direct play proves its
	// output has the same resolution as the matched source.
	live.Media[0].Parts = []DisplayPart{{Streams: []DisplayStream{{Type: 1, Selected: "1", Decision: "directplay"}}}}
	ApplySourceDisplay(displays[0], live, original)
	if displays[0].StreamResolution != "1080p" {
		t.Fatalf("explicit direct play output %q", displays[0].StreamResolution)
	}
	// Multiple unmatched media versions are ambiguous and must remain unknown.
	original.Media = append(original.Media, DisplayMedia{ID: "8", Resolution: "720"})
	live.Media[0].ID = "missing"
	other := *displays[0]
	other.SourceResolution, other.StreamResolution = "", ""
	ApplySourceDisplay(&other, live, original)
	if other.SourceResolution != "" || other.StreamResolution != "" {
		t.Fatal("ambiguous version was recorded")
	}
}
