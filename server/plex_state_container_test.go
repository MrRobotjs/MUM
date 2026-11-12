package main

import (
	"app/server/providers/plex"
	"encoding/json"
	"encoding/xml"
	"strings"
	"testing"
)

func TestPlexCurrentDisplayPreservesBufferingState(t *testing.T) {
	for _, state := range []string{"playing", "paused", "buffering"} {
		body := strings.Replace(plexRichPlaying, `state="playing"`, `state="`+state+`"`, 1)
		snapshot, err := plex.ParseActivity([]byte(body))
		if err != nil {
			t.Fatal(err)
		}
		encoded, _ := json.Marshal(snapshot.Sessions[0].Display)
		var data map[string]any
		json.Unmarshal(encoded, &data)
		if data["state"] != state {
			t.Errorf("state got %v want %s", data["state"], state)
		}
		if snapshot.Sessions[0].Paused != (state == "paused") {
			t.Fatal("paused history invariant changed")
		}
	}
}

func TestPlexSameContainerTranscodingAndCopyOnlyDisplay(t *testing.T) {
	for _, tc := range []struct{ name, body, want string }{
		{"audio_transcode_same_format", strings.Replace(plexRichPlaying, `container="mpegts"`, `container="mkv"`, 1), "Converting (MKV → MKV)"},
		{"video_transcode_same_format", strings.Replace(strings.Replace(plexRichPlaying, `container="mpegts"`, `container="mkv"`, 1), `videoDecision="copy"`, `videoDecision="transcode"`, 1), "Converting (MKV → MKV)"},
		{"copy_only_different_format", strings.Replace(plexRichPlaying, `audioDecision="transcode"`, `audioDecision="copy"`, 1), "MKV"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			display, err := plex.ParseDisplays([]byte(tc.body))
			if err != nil {
				t.Fatal(err)
			}
			if display[0].Container != tc.want {
				t.Errorf("initial got %q want %q", display[0].Container, tc.want)
			}
			var live struct {
				Rows []plex.DisplayRow `xml:",any"`
			}
			if err = xml.Unmarshal([]byte(tc.body), &live); err != nil {
				t.Fatal(err)
			}
			source := plex.DecodeSourceDisplay([]byte(plexSingleOriginalSource), "123", "movie")
			if source == nil {
				t.Fatal("source fixture")
			}
			plex.ApplySourceDisplay(display[0], live.Rows[0], *source)
			if display[0].Container != tc.want {
				t.Errorf("enriched got %q want %q", display[0].Container, tc.want)
			}
		})
	}
}
