package main

import (
	"encoding/xml"
	"strings"
	"testing"
)

func TestPlexQualityUsesSelectedLiveBitrateForAnyTranscode(t *testing.T) {
	for _, tc := range []struct{ name, body, source, want string }{
		{"audio_transcode", plexOutputPlaying(), strings.Replace(plexOriginalSource, `bitrate="6900"`, `bitrate="7400"`, 1), "Original (6.9 Mbps)"},
		{"video_transcode", strings.Replace(strings.Replace(plexOutputPlaying(), `bitrate="6900"`, `bitrate="4000"`, 1), `videoDecision="copy"`, `videoDecision="transcode"`, 1), strings.Replace(plexOriginalSource, `bitrate="6900"`, `bitrate="20000"`, 1), "4 Mbps 720p (4.0 Mbps)"},
		{"missing_live_bitrate", strings.Replace(plexOutputPlaying(), `bitrate="6900"`, `bitrate="0"`, 1), plexOriginalSource, "804p (Bitrate N/A)"},
		{"direct_play_source", strings.Replace(plexOutputPlaying(), `<TranscodeSession videoDecision="copy" audioDecision="transcode" videoCodec="hevc" audioCodec="mp3" audioChannels="2" container="mpegts" throttled="1" speed="2.5"/>`, "", 1), strings.Replace(plexOriginalSource, `bitrate="6900"`, `bitrate="7400"`, 1), "Original (7.4 Mbps)"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var live struct {
				Rows []plexDisplayRow `xml:",any"`
			}
			if err := xml.Unmarshal([]byte(tc.body), &live); err != nil {
				t.Fatal(err)
			}
			display, err := parsePlexDisplays([]byte(tc.body))
			if err != nil {
				t.Fatal(err)
			}
			source := decodePlexSourceDisplay([]byte(tc.source), "123", "movie")
			if source == nil {
				t.Fatal("source fixture")
			}
			applyPlexSourceDisplay(display[0], live.Rows[0], *source)
			if display[0].Quality != tc.want {
				t.Fatalf("got %q want %q", display[0].Quality, tc.want)
			}
		})
	}
}
