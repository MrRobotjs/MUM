package plex

import (
	"strconv"
	"strings"

	"app/server/providers/provider"
)

// catalogueMediaEntry is one file version Plex lists under an item.
type catalogueMediaEntry struct {
	Container  string `xml:"container,attr"`
	Bitrate    *int64 `xml:"bitrate,attr"`
	VideoCodec string `xml:"videoCodec,attr"`
	Resolution string `xml:"videoResolution,attr"`
	Height     *int64 `xml:"height,attr"`
	FrameRate  string `xml:"videoFrameRate,attr"`
	AudioCodec string `xml:"audioCodec,attr"`
	Channels   *int64 `xml:"audioChannels,attr"`
	Parts      []struct {
		Size *int64 `xml:"size,attr"`
	} `xml:"Part"`
}

// catalogueMedia is the first file version's detail, in the labels every media
// service uses: the resolution class from the frame height, and the frame
// rate as "24p" (Plex's PAL and NTSC are 25p and 30p).
func catalogueMedia(row CatalogueEntry) *provider.CatalogueMedia {
	if len(row.Media) == 0 {
		return nil
	}
	m := row.Media[0]
	out := provider.CatalogueMedia{Container: m.Container, BitrateKbps: m.Bitrate, VideoCodec: m.VideoCodec, AudioCodec: m.AudioCodec, AudioChannels: m.Channels}
	if m.Height != nil {
		out.VideoResolution = provider.MediaResolution(*m.Height)
	}
	if out.VideoResolution == "" {
		switch res := strings.ToLower(strings.TrimSpace(m.Resolution)); res {
		case "4k":
			out.VideoResolution = "4K"
		case "sd":
			out.VideoResolution = "SD"
		default:
			if n, err := strconv.ParseInt(res, 10, 64); err == nil {
				out.VideoResolution = provider.MediaResolution(n)
			}
		}
	}
	switch rate := strings.ToLower(strings.TrimSpace(m.FrameRate)); rate {
	case "pal":
		out.VideoFrameRate = "25p"
	case "ntsc":
		out.VideoFrameRate = "30p"
	default:
		if n, err := strconv.Atoi(strings.TrimSuffix(rate, "p")); err == nil && strings.HasSuffix(rate, "p") && n > 0 {
			out.VideoFrameRate = strconv.Itoa(n) + "p"
		}
	}
	var size int64
	for _, part := range m.Parts {
		if part.Size == nil || *part.Size <= 0 {
			size = 0
			break
		}
		size += *part.Size
	}
	if size > 0 {
		out.SizeBytes = &size
	}
	return out.Clean()
}
