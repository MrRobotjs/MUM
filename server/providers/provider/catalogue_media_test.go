package provider

import (
	"math"
	"strings"
	"testing"
)

func TestCatalogueMediaClean(t *testing.T) {
	n := func(v int64) *int64 { return &v }
	if (&CatalogueMedia{Container: "  ", BitrateKbps: n(0), AudioChannels: n(-2)}).Clean() != nil {
		t.Fatal("empty record kept")
	}
	got := (&CatalogueMedia{Container: "mkv", VideoCodec: "hevc", AudioCodec: "eac3", VideoResolution: "1080p", BitrateKbps: n(9861), AudioChannels: n(6), SizeBytes: n(9_400_000_000), VideoFrameRate: strings.Repeat("x", 40)}).Clean()
	if got.Container != "MKV" || got.VideoCodec != "HEVC" || got.AudioCodec != "EAC3" || *got.BitrateKbps != 9861 || *got.AudioChannels != 6 || got.VideoFrameRate != "" {
		t.Fatalf("%+v", got)
	}
	if (&CatalogueMedia{AudioChannels: n(500), Container: "a\x00b"}).Clean() != nil {
		t.Fatal("implausible values kept")
	}
}

func TestMediaLabels(t *testing.T) {
	for h, want := range map[int64]string{0: "", 480: "SD", 720: "720p", 800: "1080p", 1080: "1080p", 1440: "1440p", 1600: "4K", 2160: "4K", 4320: "4320p"} {
		if got := MediaResolution(h); got != want {
			t.Errorf("height %d: %q", h, got)
		}
	}
	for fps, want := range map[float64]string{23.976: "24p", 25: "25p", 29.97: "30p", 59.94: "60p", 0: "", -1: "", math.NaN(): ""} {
		if got := MediaFrameRate(fps); got != want {
			t.Errorf("fps %v: %q", fps, got)
		}
	}
}
