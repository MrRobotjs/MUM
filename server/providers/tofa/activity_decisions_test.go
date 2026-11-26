package tofa

import "testing"

func TestStreamDecisionsLabelEachTrack(t *testing.T) {
	cases := []struct {
		decision, method        string
		container, video, audio string
	}{
		{decisionDirectFile, "direct_play", "MKV", "Direct Play (H264 1080p)", "Direct Play (EAC3)"},
		{decisionRemux, "direct_stream", "MKV", "Direct Stream (H264 1080p)", "Direct Stream (EAC3)"},
		{decisionAudioOnly, "transcode", "Converting (MKV → HLS)", "Direct Stream (H264 1080p)", "Transcode (EAC3 → AAC)"},
		// Tofa re-encodes the video in a full transcode even when the codec is unchanged.
		{decisionFull, "transcode", "Converting (MKV → HLS)", "Transcode (H264 1080p → H264 1080p)", "Transcode (EAC3 → AAC)"},
		{"", "transcode", "Converting (MKV → HLS)", "H264 1080p", "EAC3 → AAC"},
		{"Unrecognised", "direct_play", "MKV", "H264 1080p", "EAC3 → AAC"},
	}
	for _, c := range cases {
		container, video, audio := streamDecisions(c.decision, c.method, "MKV", "H264 1080p", "H264 1080p", "EAC3", "AAC")
		if container != c.container || video != c.video || audio != c.audio {
			t.Errorf("%q: got %q / %q / %q", c.decision, container, video, audio)
		}
	}
	// Audio copied inside a full transcode is a direct stream.
	if _, _, audio := streamDecisions(decisionFull, "transcode", "MKV", "HEVC 4K", "H264 1080p", "AAC", "AAC"); audio != "Direct Stream (AAC)" {
		t.Errorf("copied audio: %q", audio)
	}
	if _, video, _ := streamDecisions(decisionFull, "transcode", "", "HEVC 4K", "", "AAC", ""); video != "Transcode (HEVC 4K → Unknown)" {
		t.Errorf("unknown output: %q", video)
	}
	if container, _, _ := streamDecisions(decisionDirectFile, "direct_play", "", "", "", "", ""); container != "Unknown" {
		t.Errorf("unknown container: %q", container)
	}
}

// Graphs group plays by these labels, so they must match what the other
// media services record.
func TestResolutionLabelUsesSharedClasses(t *testing.T) {
	for in, want := range map[string]string{"720x480": "SD", "1280x720": "720p", "1920x1080": "1080p", "1920x800": "1080p", "2560x1440": "1440p", "3840x2160": "4K", "3840x1600": "4K", "7680x4320": "4320p", "": "", "wide": "", "1920x": "", "1920x-1": ""} {
		v := in
		if got := resolutionLabel(&v); got != want {
			t.Errorf("%q: %q, want %q", in, got, want)
		}
	}
	if resolutionLabel(nil) != "" {
		t.Error("nil resolution")
	}
}

func TestTrackLabelAddsResolution(t *testing.T) {
	s := func(v string) *string { return &v }
	for in, want := range map[[2]string]string{{"h264", "1920x1080"}: "H264 1080p", {"hevc", "3840x2160"}: "HEVC 4K", {"aac", ""}: "AAC", {"", "1920x1080"}: ""} {
		res := s(in[1])
		if in[1] == "" {
			res = nil
		}
		if got := trackLabel(s(in[0]), res); got != want {
			t.Errorf("%v: %q, want %q", in, got, want)
		}
	}
}
