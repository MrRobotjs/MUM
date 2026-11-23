package mediabrowser

import (
	"app/server/providers/plex"
	"app/server/providers/provider"
	"encoding/json"
	"fmt"
	"strings"
)

type cardStream struct {
	Type, Codec, DisplayTitle        string
	Height, Width, BitRate, Channels int64
	Index                            int64
	IsDefault                        bool
}
type cardMedia struct {
	Container, PrimaryImageTag, AlbumPrimaryImageTag            string
	ProductionYear                                              int
	SeriesId, SeriesName, Album, AlbumId, SeriesPrimaryImageTag string
	ImageTags                                                   map[string]string
	MediaStreams                                                []cardStream
	MediaSources                                                []struct {
		Bitrate int64
		Path    string
	}
}
type cardTranscode struct {
	Container, VideoCodec, AudioCodec string
	Bitrate, Height, AudioChannels    int64
	IsVideoDirect, IsAudioDirect      *bool
}

func cardLabel(s string) string {
	s = strings.Join(strings.Fields(s), " ")
	if !provider.ValidText(s, 256) {
		return ""
	}
	return s
}
func cardCodec(s string) string { return strings.ToUpper(cardLabel(s)) }
func cardResolution(h int64) string {
	switch {
	case h <= 0:
		return ""
	case h <= 480:
		return "SD"
	case h <= 720:
		return "720p"
	case h <= 1080:
		return "1080p"
	case h <= 1440:
		return "1440p"
	case h <= 2160:
		return "4K"
	default:
		return fmt.Sprintf("%dp", h)
	}
}
func cardRate(b int64) string {
	if b <= 0 || b > 10000000000 {
		return ""
	}
	return fmt.Sprintf("%.1f Mbps", float64(b)/1000000)
}
func streamDisplay(row map[string]json.RawMessage, item json.RawMessage, s provider.ActivitySession) *provider.ActivityDisplay {
	var m cardMedia
	if json.Unmarshal(item, &m) != nil {
		return nil
	}
	var tr cardTranscode
	_ = json.Unmarshal(row["TranscodingInfo"], &tr)
	d := &provider.ActivityDisplay{PlayerTitle: s.Device, PlayerPlatform: s.Client, Product: s.Client, ParentTitle: s.ParentTitle}
	var avatarTag string
	_ = json.Unmarshal(row["UserPrimaryImageTag"], &avatarTag)
	if ValidToken(s.User) && ValidToken(avatarTag) {
		d.AvatarPath = s.User + ":" + avatarTag
	}
	var endpoint string
	if json.Unmarshal(row["RemoteEndPoint"], &endpoint) == nil {
		if addr := plex.SessionAddress(endpoint); addr.IsValid() {
			if !addr.IsUnspecified() && !addr.IsMulticast() && !addr.IsLinkLocalUnicast() {
				d.IP = addr.String()
				public := plex.PublicSessionAddress(d.IP).IsValid()
				d.PublicIP = &public
				d.LocationType = "LAN"
				if public {
					d.LocationType = "WAN"
				}
				d.Location = d.LocationType + ": " + d.IP
			}
		}
	}
	if m.ProductionYear > 0 && m.ProductionYear < 10000 {
		d.Year = fmt.Sprint(m.ProductionYear)
	}
	image, tag := s.Item, m.ImageTags["Primary"]
	if tag == "" {
		tag = m.PrimaryImageTag
	}
	if s.Kind == "Episode" && ValidToken(s.Parent) {
		image = s.Parent
		tag = m.SeriesPrimaryImageTag
		if tag == "" {
			tag = m.ImageTags["SeriesPrimary"]
		}
		if !ValidToken(tag) {
			image = s.Item
			tag = m.ImageTags["Primary"]
			if tag == "" {
				tag = m.PrimaryImageTag
			}
		}
	}
	if s.Kind == "Audio" && ValidToken(s.Parent) && ValidToken(m.AlbumPrimaryImageTag) {
		image, tag = s.Parent, m.AlbumPrimaryImageTag
	}
	if ValidToken(image) && ValidToken(tag) {
		d.PosterItem = image
		d.PosterPath = tag
	}
	var video, audio *cardStream
	for i := range m.MediaStreams {
		x := &m.MediaStreams[i]
		if x.Type == "Video" && video == nil {
			video = x
		}
		if x.Type == "Audio" && (audio == nil || x.IsDefault) {
			audio = x
		}
	}
	method := ""
	switch s.PlayMethod {
	case "direct_play":
		method = "Direct Play"
	case "direct_stream":
		method = "Direct Stream"
	case "transcode":
		method = "Transcode"
	}
	d.Stream = method
	if method != "" {
		v := method == "Transcode"
		d.IsTranscode = &v
	}
	original := cardCodec(m.Container)
	target := cardCodec(tr.Container)
	d.Container = original
	if method == "Transcode" && original != "" && target != "" && original != target {
		d.Container = fmt.Sprintf("Converting (%s → %s)", original, target)
	}
	if video != nil {
		codec, res := cardCodec(video.Codec), cardResolution(video.Height)
		if codec != "" {
			label := method
			if label == "Transcode" && tr.IsVideoDirect == nil {
				label = "Source"
			}
			d.Video = strings.TrimSpace(fmt.Sprintf("%s (%s %s)", label, codec, res))
			d.MediaVideoCodec = codec
		}
		if video.Width > 0 && video.Width <= 1000000000000 {
			v := video.Width
			d.MediaWidth = &v
		}
		if video.Height > 0 && video.Height <= 1000000000000 {
			v := video.Height
			d.MediaHeight = &v
		}
		d.MediaVideoResolution = res
		d.SourceResolution = res
		d.Quality = res
	}
	if method == "Transcode" && tr.IsVideoDirect != nil && !*tr.IsVideoDirect && cardCodec(tr.VideoCodec) != "" {
		targetVideo := strings.TrimSpace(cardCodec(tr.VideoCodec) + " " + cardResolution(tr.Height))
		if d.Video != "" {
			d.Video = fmt.Sprintf("Transcode (%s → %s)", strings.TrimSuffix(strings.TrimPrefix(d.Video, method+" ("), ")"), targetVideo)
		} else {
			d.Video = "Transcode (" + targetVideo + ")"
		}
		d.StreamResolution = cardResolution(tr.Height)
		if d.StreamResolution != "" {
			d.Quality = d.StreamResolution
		}
	}
	if method == "Transcode" && tr.IsVideoDirect != nil && *tr.IsVideoDirect && video != nil && cardCodec(video.Codec) != "" {
		d.Video = strings.TrimSpace(fmt.Sprintf("Direct Stream (%s %s)", cardCodec(video.Codec), cardResolution(video.Height)))
	}
	if audio != nil {
		name := cardLabel(audio.DisplayTitle)
		if name == "" {
			name = cardCodec(audio.Codec)
		}
		if name != "" {
			label := method
			if label == "Transcode" && tr.IsAudioDirect == nil {
				label = "Source"
			}
			d.Audio = label + " (" + name + ")"
		}
		d.MediaAudioCodec = cardCodec(audio.Codec)
		if audio.Channels > 0 && audio.Channels <= 1000000000000 {
			v := audio.Channels
			d.MediaAudioChannels = &v
		}
	}
	if method == "Transcode" && tr.IsAudioDirect != nil && !*tr.IsAudioDirect && cardCodec(tr.AudioCodec) != "" {
		source := ""
		if audio != nil {
			source = cardLabel(audio.DisplayTitle)
			if source == "" {
				source = cardCodec(audio.Codec)
			}
		}
		targetAudio := cardCodec(tr.AudioCodec)
		if tr.AudioChannels == 2 {
			targetAudio += " Stereo"
		} else if tr.AudioChannels > 0 && tr.AudioChannels < 32 {
			targetAudio += fmt.Sprintf(" %dch", tr.AudioChannels)
		}
		if source != "" {
			d.Audio = "Transcode (" + source + " → " + targetAudio + ")"
		} else {
			d.Audio = "Transcode (" + targetAudio + ")"
		}
		d.MediaAudioCodec = cardCodec(tr.AudioCodec)
		if tr.AudioChannels > 0 && tr.AudioChannels <= 32 {
			channels := tr.AudioChannels
			d.MediaAudioChannels = &channels
		}
	}
	if method == "Transcode" && tr.IsAudioDirect != nil && *tr.IsAudioDirect && audio != nil {
		name := cardLabel(audio.DisplayTitle)
		if name == "" {
			name = cardCodec(audio.Codec)
		}
		if name != "" {
			d.Audio = "Direct Stream (" + name + ")"
		}
	}
	var state struct{ SubtitleStreamIndex *int64 }
	if json.Unmarshal(row["PlayState"], &state) == nil && state.SubtitleStreamIndex != nil {
		if *state.SubtitleStreamIndex == -1 {
			d.Subtitle = "None"
		} else {
			for _, stream := range m.MediaStreams {
				if stream.Type == "Subtitle" && stream.Index == *state.SubtitleStreamIndex {
					d.Subtitle = cardLabel(stream.DisplayTitle)
					if d.Subtitle == "" {
						d.Subtitle = cardCodec(stream.Codec)
					}
					break
				}
			}
		}
	}
	bitrate := tr.Bitrate
	if bitrate <= 0 && len(m.MediaSources) > 0 {
		bitrate = m.MediaSources[0].Bitrate
	}
	if bitrate <= 0 {
		if video != nil {
			bitrate += video.BitRate
		}
		if audio != nil {
			bitrate += audio.BitRate
		}
	}
	d.Bandwidth = cardRate(bitrate)
	if d.Bandwidth != "" {
		kb := bitrate / 1000
		d.Bitrate = &kb
		if d.Quality != "" {
			d.Quality += " (" + d.Bandwidth + ")"
		}
	}
	if s.Duration != nil && *s.Duration >= 10000 && *s.Duration/10000 <= 1000000000000 {
		ms := *s.Duration / 10000
		d.MediaDuration = &ms
	}
	if len(m.MediaSources) > 0 {
		if m.MediaSources[0].Bitrate >= 1000 && m.MediaSources[0].Bitrate <= 10000000000 {
			value := m.MediaSources[0].Bitrate / 1000
			d.MediaBitrate = &value
		}
		if provider.ValidText(m.MediaSources[0].Path, 1024) && !strings.Contains(m.MediaSources[0].Path, "://") {
			d.MediaPath = m.MediaSources[0].Path
		}
	}
	// Diagnostics contain a bounded allowlist, never the provider's tokens or URLs.
	diagnostic := map[string]any{"PlayMethod": s.PlayMethod, "NowPlayingItem": map[string]any{"Container": m.Container, "MediaStreams": m.MediaStreams}, "TranscodingInfo": tr}
	if raw, err := json.Marshal(diagnostic); err == nil && len(raw) <= 8192 {
		d.RawDataJSON = string(raw)
	}
	d.MediaContainer = original
	if method == "Transcode" && target != "" {
		d.MediaContainer = target
	}
	return d
}
