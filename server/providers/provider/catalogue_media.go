package provider

import (
	"fmt"
	"math"
	"strconv"
	"strings"
)

// CatalogueMedia is the technical detail of an item's file that a library
// sync saves for the item's Overview: what the media info section shows. Text
// is a short label; nil or empty means the server didn't report it.
type CatalogueMedia struct {
	Container       string `json:"container,omitempty"`
	BitrateKbps     *int64 `json:"bitrate_kbps,omitempty"`
	VideoCodec      string `json:"video_codec,omitempty"`
	VideoResolution string `json:"video_resolution,omitempty"`
	VideoFrameRate  string `json:"video_frame_rate,omitempty"`
	AudioCodec      string `json:"audio_codec,omitempty"`
	AudioChannels   *int64 `json:"audio_channels,omitempty"`
	SizeBytes       *int64 `json:"size_bytes,omitempty"`
}

func mediaLabel(v string) string {
	v = strings.Join(strings.Fields(v), " ")
	if !ValidText(v, 32) {
		return ""
	}
	return v
}
func mediaNumber(v *int64, max int64) *int64 {
	if v == nil || *v <= 0 || *v > max {
		return nil
	}
	n := *v
	return &n
}

// Clean drops values that aren't plausible labels or numbers and returns nil
// when nothing is left, so a sync never saves an empty or oversized record.
func (m *CatalogueMedia) Clean() *CatalogueMedia {
	if m == nil {
		return nil
	}
	out := CatalogueMedia{
		Container:       strings.ToUpper(mediaLabel(m.Container)),
		BitrateKbps:     mediaNumber(m.BitrateKbps, 10_000_000),
		VideoCodec:      strings.ToUpper(mediaLabel(m.VideoCodec)),
		VideoResolution: mediaLabel(m.VideoResolution),
		VideoFrameRate:  mediaLabel(m.VideoFrameRate),
		AudioCodec:      strings.ToUpper(mediaLabel(m.AudioCodec)),
		AudioChannels:   mediaNumber(m.AudioChannels, 64),
		SizeBytes:       mediaNumber(m.SizeBytes, 1<<50),
	}
	if out == (CatalogueMedia{}) {
		return nil
	}
	return &out
}

// MediaResolution is the resolution class for a frame height, the same classes
// the stream cards and graphs use: SD, 720p, 1080p, 1440p, 4K.
func MediaResolution(height int64) string {
	switch {
	case height <= 0:
		return ""
	case height <= 480:
		return "SD"
	case height <= 720:
		return "720p"
	case height <= 1080:
		return "1080p"
	case height <= 1440:
		return "1440p"
	case height <= 2160:
		return "4K"
	case height <= 100000:
		return fmt.Sprintf("%dp", height)
	}
	return ""
}

// MediaFrameRate labels frames per second the usual way: 23.976 is "24p",
// 29.97 is "30p", 59.94 is "60p".
func MediaFrameRate(fps float64) string {
	if math.IsNaN(fps) || fps <= 0 || fps > 1000 {
		return ""
	}
	return strconv.Itoa(int(math.Round(fps))) + "p"
}
