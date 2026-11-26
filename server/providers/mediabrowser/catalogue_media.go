package mediabrowser

import "app/server/providers/provider"

// catalogueSource is one file version a Jellyfin or Emby item lists.
type catalogueSource struct {
	Container    string
	Bitrate      *int64
	Size         *int64
	MediaStreams []struct {
		Type, Codec      string
		Height           *int64
		RealFrameRate    *float64
		AverageFrameRate *float64
		Channels         *int64
		IsDefault        bool
	}
}

// catalogueMedia is the first file version's detail: its first video stream
// and its default audio stream (else the first), in the shared labels.
func catalogueMedia(sources []catalogueSource) *provider.CatalogueMedia {
	if len(sources) == 0 {
		return nil
	}
	src := sources[0]
	out := provider.CatalogueMedia{Container: src.Container, SizeBytes: src.Size}
	if src.Bitrate != nil && *src.Bitrate > 0 {
		kbps := *src.Bitrate / 1000
		out.BitrateKbps = &kbps
	}
	videoSeen, audioDefault := false, false
	for _, stream := range src.MediaStreams {
		switch stream.Type {
		case "Video":
			if videoSeen {
				continue
			}
			videoSeen = true
			out.VideoCodec = stream.Codec
			if stream.Height != nil {
				out.VideoResolution = provider.MediaResolution(*stream.Height)
			}
			if stream.RealFrameRate != nil {
				out.VideoFrameRate = provider.MediaFrameRate(*stream.RealFrameRate)
			} else if stream.AverageFrameRate != nil {
				out.VideoFrameRate = provider.MediaFrameRate(*stream.AverageFrameRate)
			}
		case "Audio":
			if audioDefault || out.AudioCodec != "" && !stream.IsDefault {
				continue
			}
			audioDefault = stream.IsDefault
			out.AudioCodec, out.AudioChannels = stream.Codec, stream.Channels
		}
	}
	return out.Clean()
}
