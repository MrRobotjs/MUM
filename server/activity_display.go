package main

import (
	"encoding/xml"
	"fmt"
	"strconv"
	"strings"
)

// Current, administrator-only presentation data. Never stores raw provider
// unfiltered payloads or tokens. Allowlisted technical diagnostics and selected local media paths are administrator-only current-session
// details. Canonical avatar descriptors remain private and are
// replaced by signed application URLs in the DTO. Cleared when the session ends.
type activityDisplay struct {
	State                 string   `json:"state,omitempty"`
	RawDataJSON           string   `json:"raw_data_json,omitempty"`
	MediaPath             string   `json:"media_path,omitempty"`
	MediaDuration         *int64   `json:"media_duration,omitempty"`
	MediaBitrate          *int64   `json:"media_bitrate,omitempty"`
	MediaWidth            *int64   `json:"media_width,omitempty"`
	MediaHeight           *int64   `json:"media_height,omitempty"`
	MediaAspectRatio      string   `json:"media_aspect_ratio,omitempty"`
	MediaAudioChannels    *int64   `json:"media_audio_channels,omitempty"`
	MediaAudioCodec       string   `json:"media_audio_codec,omitempty"`
	MediaVideoCodec       string   `json:"media_video_codec,omitempty"`
	MediaVideoResolution  string   `json:"media_video_resolution,omitempty"`
	MediaContainer        string   `json:"media_container,omitempty"`
	MediaVideoFrameRate   string   `json:"media_video_frame_rate,omitempty"`
	MediaVideoProfile     string   `json:"media_video_profile,omitempty"`
	MediaHasVoiceActivity *bool    `json:"media_has_voice_activity,omitempty"`
	Library               string   `json:"library_name,omitempty"`
	Year                  string   `json:"year,omitempty"`
	Edition               string   `json:"edition,omitempty"`
	ParentTitle           string   `json:"parent_title,omitempty"`
	GrandparentTitle      string   `json:"grandparent_title,omitempty"`
	PlayerTitle           string   `json:"player_title,omitempty"`
	PlayerPlatform        string   `json:"player_platform,omitempty"`
	Product               string   `json:"product,omitempty"`
	Quality               string   `json:"quality_detail,omitempty"`
	Stream                string   `json:"stream_detail,omitempty"`
	Container             string   `json:"container_detail,omitempty"`
	Video                 string   `json:"video_detail,omitempty"`
	Audio                 string   `json:"audio_detail,omitempty"`
	Subtitle              string   `json:"subtitle_detail,omitempty"`
	Location              string   `json:"location_detail,omitempty"`
	IP                    string   `json:"location_ip,omitempty"`
	LocationType          string   `json:"location_type_calc,omitempty"`
	Bandwidth             string   `json:"bandwidth_detail,omitempty"`
	Bitrate               *int64   `json:"bitrate_calc,omitempty"`
	IsTranscode           *bool    `json:"is_transcode_calc,omitempty"`
	Speed                 *float64 `json:"transcode_speed,omitempty"`
	Throttled             bool     `json:"transcode_throttled,omitempty"`
	Thumb                 string   `json:"thumb_url,omitempty"`
	Avatar                string   `json:"user_avatar_url,omitempty"`
	Latitude              *float64 `json:"latitude,omitempty"`
	Longitude             *float64 `json:"longitude,omitempty"`
	PublicIP              *bool    `json:"is_public_ip,omitempty"`
	// Stored internally, stripped from the public DTO after signing Thumb.
	PosterItem string `json:"poster_item,omitempty"`
	PosterPath string `json:"poster_path,omitempty"`
	AvatarPath string `json:"avatar_path,omitempty"`
}

type plexDisplayStream struct {
	Width       int    `xml:"width,attr"`
	AspectRatio string `xml:"aspectRatio,attr"`
	FrameRate   string `xml:"frameRate,attr"`
	Profile     string `xml:"profile,attr"`
	ID          string `xml:"id,attr"`
	Channels    int    `xml:"channels,attr"`
	Type        int    `xml:"streamType,attr"`
	Codec       string `xml:"codec,attr"`
	Title       string `xml:"displayTitle,attr"`
	Selected    string `xml:"selected,attr"`
	Height      int    `xml:"height,attr"`
}
type plexDisplayPart struct {
	File      string              `xml:"file,attr"`
	ID        string              `xml:"id,attr"`
	Container string              `xml:"container,attr"`
	Selected  string              `xml:"selected,attr"`
	Streams   []plexDisplayStream `xml:"Stream"`
}
type plexDisplayMedia struct {
	Duration      int64             `xml:"duration,attr"`
	Width         int               `xml:"width,attr"`
	AspectRatio   string            `xml:"aspectRatio,attr"`
	AudioChannels int               `xml:"audioChannels,attr"`
	FrameRate     string            `xml:"videoFrameRate,attr"`
	Profile       string            `xml:"videoProfile,attr"`
	VoiceActivity string            `xml:"hasVoiceActivity,attr"`
	ID            string            `xml:"id,attr"`
	Selected      string            `xml:"selected,attr"`
	Container     string            `xml:"container,attr"`
	Bitrate       int64             `xml:"bitrate,attr"`
	VideoCodec    string            `xml:"videoCodec,attr"`
	AudioCodec    string            `xml:"audioCodec,attr"`
	Resolution    string            `xml:"videoResolution,attr"`
	Height        int               `xml:"height,attr"`
	Parts         []plexDisplayPart `xml:"Part"`
}
type plexDisplayRow struct {
	Duration          int64  `xml:"duration,attr"`
	Item              string `xml:"ratingKey,attr"`
	Kind              string `xml:"type,attr"`
	Year              string `xml:"year,attr"`
	Edition           string `xml:"editionTitle,attr"`
	Library           string `xml:"librarySectionTitle,attr"`
	ParentTitle       string `xml:"parentTitle,attr"`
	Parent            string `xml:"parentRatingKey,attr"`
	ParentPoster      string `xml:"parentThumb,attr"`
	GrandparentTitle  string `xml:"grandparentTitle,attr"`
	Poster            string `xml:"thumb,attr"`
	Grandparent       string `xml:"grandparentRatingKey,attr"`
	GrandparentPoster string `xml:"grandparentThumb,attr"`
	Player            struct {
		State    string `xml:"state,attr"`
		Title    string `xml:"title,attr"`
		Platform string `xml:"platform,attr"`
		Product  string `xml:"product,attr"`
		Address  string `xml:"address,attr"`
		Local    string `xml:"local,attr"`
	} `xml:"Player"`
	User struct {
		Thumb string `xml:"thumb,attr"`
	} `xml:"User"`
	Session struct {
		Bandwidth *int64 `xml:"bandwidth,attr"`
		Location  string `xml:"location,attr"`
	} `xml:"Session"`
	Media     []plexDisplayMedia `xml:"Media"`
	Transcode *struct {
		VideoDecision    string   `xml:"videoDecision,attr"`
		AudioDecision    string   `xml:"audioDecision,attr"`
		SubtitleDecision string   `xml:"subtitleDecision,attr"`
		VideoCodec       string   `xml:"videoCodec,attr"`
		AudioCodec       string   `xml:"audioCodec,attr"`
		AudioChannels    int      `xml:"audioChannels,attr"`
		Height           int      `xml:"height,attr"`
		HWDecode         string   `xml:"transcodeHwDecoding,attr"`
		HWEncode         string   `xml:"transcodeHwEncoding,attr"`
		Container        string   `xml:"container,attr"`
		Throttled        string   `xml:"throttled,attr"`
		Speed            *float64 `xml:"speed,attr"`
	} `xml:"TranscodeSession"`
}

func displayText(v string) string {
	v = strings.TrimSpace(v)
	if !activityText(v, 256) {
		return ""
	}
	return v
}
func plexRate(kbps int64) string {
	if kbps <= 0 {
		return "Unknown"
	}
	return fmt.Sprintf("%.1f Mbps", float64(kbps)/1000)
}
func plexResolution(res string, height int) string {
	res = strings.ToLower(strings.TrimSpace(res))
	if res == "4k" {
		return "4K"
	}
	if res == "sd" {
		return "SD"
	}
	if res == "2k" {
		return "2K"
	}
	if len(res) > 1 && (strings.HasSuffix(res, "p") || strings.HasSuffix(res, "i")) {
		if n, err := strconv.Atoi(res[:len(res)-1]); err == nil && n > 0 && n <= 10000 {
			return res
		}
	}
	if n, err := strconv.Atoi(res); err == nil && n > 0 && n <= 10000 {
		return res + "p"
	}
	if height > 0 && height <= 10000 {
		return strconv.Itoa(height) + "p"
	}
	return "Unknown"
}
func parsePlexDisplays(body []byte) ([]*activityDisplay, error) {
	var page struct {
		Rows []plexDisplayRow `xml:",any"`
	}
	if err := xml.Unmarshal(body, &page); err != nil {
		return nil, errActivitySnapshot
	}
	result := make([]*activityDisplay, 0, len(page.Rows))
	rawPayloads := parsePlexRawPayloads(body)
	for index, row := range page.Rows {
		d := &activityDisplay{Library: displayText(row.Library), Year: displayText(row.Year), Edition: displayText(row.Edition), ParentTitle: displayText(row.ParentTitle), GrandparentTitle: displayText(row.GrandparentTitle), PlayerTitle: displayText(row.Player.Title), PlayerPlatform: displayText(row.Player.Platform), Product: displayText(row.Player.Product), PosterItem: row.Item, PosterPath: row.Poster}
		d.AvatarPath = safePlexActivityAvatar(row.User.Thumb)
		switch row.Player.State {
		case "playing", "paused", "buffering":
			d.State = row.Player.State
		}
		if row.Kind == "episode" && row.GrandparentPoster != "" {
			d.PosterItem, d.PosterPath = row.Grandparent, row.GrandparentPoster
		}
		if row.Kind == "track" {
			if row.ParentPoster != "" {
				d.PosterItem, d.PosterPath = row.Parent, row.ParentPoster
			} else if !validPlexCataloguePoster(d.PosterItem, d.PosterPath) && validPlexCataloguePoster(row.Parent, d.PosterPath) {
				d.PosterItem = row.Parent
			}
		}
		if d.PosterPath != "" && !validPlexCataloguePoster(d.PosterItem, d.PosterPath) {
			// Artwork is optional. Keep authoritative playback even when the
			// provider omits or sends an unusable image identity/path.
			d.PosterItem, d.PosterPath = "", ""
		}
		if ip := sessionAddress(row.Player.Address); ip.IsValid() {
			d.IP = ip.String()
		}
		switch {
		case row.Player.Local == "1" || row.Session.Location == "lan":
			d.LocationType = "LAN"
		case row.Player.Local == "0" || row.Session.Location == "wan":
			d.LocationType = "WAN"
		}
		if d.IP != "" {
			public := publicSessionAddress(d.IP).IsValid() && d.LocationType != "LAN"
			d.PublicIP = &public
			if public && d.LocationType == "" {
				d.LocationType = "WAN"
			}
		}
		if d.LocationType != "" {
			d.Location = d.LocationType
			if d.IP != "" {
				d.Location += ": " + d.IP
			}
		}
		if b := row.Session.Bandwidth; b != nil && *b >= 0 && *b <= 1000000000 {
			n := *b * 1000
			d.Bitrate = &n
			d.Bandwidth = plexRate(*b)
		}
		applyPlexMediaDetails(d, row)
		if len(row.Media) > 0 {
			media := row.Media[0]
			for _, v := range row.Media {
				if v.Selected == "1" {
					media = v
					break
				}
			}
			d.Container = strings.ToUpper(displayText(media.Container))
			if media.Bitrate > 0 && media.Bitrate <= 1000000000 {
				d.Quality = "Original (" + plexRate(media.Bitrate) + ")"
			}
			videoLabel := strings.TrimSpace(strings.ToUpper(displayText(media.VideoCodec)) + " " + plexResolution(media.Resolution, media.Height))
			audioLabel := strings.ToUpper(displayText(media.AudioCodec))
			var subtitle string
			if len(media.Parts) > 0 {
				part := media.Parts[0]
				for _, p := range media.Parts {
					if p.Selected == "1" {
						part = p
						break
					}
				}
				for _, v := range part.Streams {
					if v.Type == 2 && v.Title != "" && (audioLabel == strings.ToUpper(displayText(media.AudioCodec)) || v.Selected == "1") {
						audioLabel = displayText(v.Title)
					}
					if v.Type == 3 && v.Selected == "1" {
						subtitle = displayText(v.Title)
					}
				}
			}
			method := "Direct Play"
			transcoding := false
			if ts := row.Transcode; ts != nil {
				transcoding = ts.VideoDecision == "transcode" || ts.AudioDecision == "transcode"
				method = "Unknown"
				if transcoding {
					method = "Transcode"
				} else if ts.VideoDecision == "copy" || ts.AudioDecision == "copy" {
					method = "Direct Stream"
				}
				d.Throttled = ts.Throttled == "1"
				if ts.Speed != nil && *ts.Speed >= 0 && *ts.Speed <= 100000 {
					d.Speed = ts.Speed
				}
				output := ts.Container
				if output == "" {
					output = media.Container
				}
				d.Container = plexContainerDetail(media.Container, output, transcoding)
				d.Video = plexDecisionDetail(ts.VideoDecision, videoLabel, strings.ToUpper(displayText(ts.VideoCodec)))
				d.Audio = plexDecisionDetail(ts.AudioDecision, audioLabel, plexAudioOutput(ts.AudioCodec, ts.AudioChannels))
			} else {
				d.Video = "Direct Play (" + videoLabel + ")"
				if audioLabel != "" {
					d.Audio = "Direct Play (" + audioLabel + ")"
				}
			}
			d.Stream = method
			if method != "Unknown" {
				d.IsTranscode = &transcoding
			}
			if subtitle != "" {
				d.Subtitle = subtitle
			} else {
				d.Subtitle = "None"
			}
			if row.Kind == "track" {
				d.Video = "Audio Only"
			}
		}
		if len(row.Media) > 0 {
			d.Quality = plexQualityDetail(row, selectedPlexMedia(row.Media).Bitrate)
		}
		if index < len(rawPayloads) {
			d.RawDataJSON = rawPayloads[index]
			boundPlexRawDisplay(d)
		}
		result = append(result, d)
	}
	return result, nil
}

func plexAudioOutput(codec string, channels int) string {
	label := strings.ToUpper(displayText(codec))
	layout := ""
	switch channels {
	case 1:
		layout = "Mono"
	case 2:
		layout = "Stereo"
	case 6:
		layout = "5.1"
	case 8:
		layout = "7.1"
	default:
		if channels > 0 && channels <= 32 {
			layout = strconv.Itoa(channels) + "ch"
		}
	}
	return strings.TrimSpace(label + " " + layout)
}
func plexDecisionDetail(decision, source, destination string) string {
	if source == "" {
		source = "Unknown"
	}
	switch decision {
	case "copy":
		return "Direct Stream (" + source + ")"
	case "transcode":
		if destination == "" {
			destination = "Unknown"
		}
		return "Transcode (" + source + " → " + destination + ")"
	case "directplay":
		return "Direct Play (" + source + ")"
	}
	return "Unknown"
}
