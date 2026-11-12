package plex

import (
	"bytes"
	"encoding/json"
	"encoding/xml"
	"fmt"
	"io"
	"strconv"
	"strings"

	"app/server/providers/provider"
)

// Stream details shown on the activity cards: what is playing, how it is
// delivered and where the player is. Built only from allowlisted fields of the
// sessions reply; nothing here identifies or authenticates anyone.

// DisplayStream, DisplayPart, DisplayMedia and DisplayRow decode the session
// and library metadata fields the display uses.
type DisplayStream struct {
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
type DisplayPart struct {
	File      string          `xml:"file,attr"`
	ID        string          `xml:"id,attr"`
	Container string          `xml:"container,attr"`
	Selected  string          `xml:"selected,attr"`
	Streams   []DisplayStream `xml:"Stream"`
}
type DisplayMedia struct {
	Duration      int64         `xml:"duration,attr"`
	Width         int           `xml:"width,attr"`
	AspectRatio   string        `xml:"aspectRatio,attr"`
	AudioChannels int           `xml:"audioChannels,attr"`
	FrameRate     string        `xml:"videoFrameRate,attr"`
	Profile       string        `xml:"videoProfile,attr"`
	VoiceActivity string        `xml:"hasVoiceActivity,attr"`
	ID            string        `xml:"id,attr"`
	Selected      string        `xml:"selected,attr"`
	Container     string        `xml:"container,attr"`
	Bitrate       int64         `xml:"bitrate,attr"`
	VideoCodec    string        `xml:"videoCodec,attr"`
	AudioCodec    string        `xml:"audioCodec,attr"`
	Resolution    string        `xml:"videoResolution,attr"`
	Height        int           `xml:"height,attr"`
	Parts         []DisplayPart `xml:"Part"`
}
type DisplayRow struct {
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
	Media     []DisplayMedia `xml:"Media"`
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
	if !provider.ValidText(v, 256) {
		return ""
	}
	return v
}
func bitrateLabel(kbps int64) string {
	if kbps <= 0 {
		return "Unknown"
	}
	return fmt.Sprintf("%.1f Mbps", float64(kbps)/1000)
}
func resolutionLabel(res string, height int) string {
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

// ParseDisplays builds one display per session row, in order.
func ParseDisplays(body []byte) ([]*provider.ActivityDisplay, error) {
	var page struct {
		Rows []DisplayRow `xml:",any"`
	}
	if err := xml.Unmarshal(body, &page); err != nil {
		return nil, provider.ErrActivitySnapshot
	}
	result := make([]*provider.ActivityDisplay, 0, len(page.Rows))
	rawPayloads := parseRawPayloads(body)
	for index, row := range page.Rows {
		d := &provider.ActivityDisplay{Library: displayText(row.Library), Year: displayText(row.Year), Edition: displayText(row.Edition), ParentTitle: displayText(row.ParentTitle), GrandparentTitle: displayText(row.GrandparentTitle), PlayerTitle: displayText(row.Player.Title), PlayerPlatform: displayText(row.Player.Platform), Product: displayText(row.Player.Product), PosterItem: row.Item, PosterPath: row.Poster}
		d.AvatarPath = ActivityAvatar(row.User.Thumb)
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
			} else if !ValidPoster(d.PosterItem, d.PosterPath) && ValidPoster(row.Parent, d.PosterPath) {
				d.PosterItem = row.Parent
			}
		}
		if d.PosterPath != "" && !ValidPoster(d.PosterItem, d.PosterPath) {
			// Artwork is optional. Keep authoritative playback even when the
			// provider omits or sends an unusable image identity/path.
			d.PosterItem, d.PosterPath = "", ""
		}
		if ip := SessionAddress(row.Player.Address); ip.IsValid() {
			d.IP = ip.String()
		}
		switch {
		case row.Player.Local == "1" || row.Session.Location == "lan":
			d.LocationType = "LAN"
		case row.Player.Local == "0" || row.Session.Location == "wan":
			d.LocationType = "WAN"
		}
		if d.IP != "" {
			public := PublicSessionAddress(d.IP).IsValid() && d.LocationType != "LAN"
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
			d.Bandwidth = bitrateLabel(*b)
		}
		applyMediaDetails(d, row)
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
				d.Quality = "Original (" + bitrateLabel(media.Bitrate) + ")"
			}
			videoLabel := strings.TrimSpace(strings.ToUpper(displayText(media.VideoCodec)) + " " + resolutionLabel(media.Resolution, media.Height))
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
				d.Container = containerDetail(media.Container, output, transcoding)
				d.Video = decisionDetail(ts.VideoDecision, videoLabel, strings.ToUpper(displayText(ts.VideoCodec)))
				d.Audio = decisionDetail(ts.AudioDecision, audioLabel, audioOutput(ts.AudioCodec, ts.AudioChannels))
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
			d.Quality = qualityDetail(row, selectedMedia(row.Media).Bitrate)
		}
		if index < len(rawPayloads) {
			d.RawDataJSON = rawPayloads[index]
			boundRawDisplay(d)
		}
		result = append(result, d)
	}
	return result, nil
}

func audioOutput(codec string, channels int) string {
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
func decisionDetail(decision, source, destination string) string {
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

func mediaDetailNumber(value, max int64) *int64 {
	if value <= 0 || value > max {
		return nil
	}
	return &value
}

// Match the reference popup: selected live media/part and stream fallbacks.
// Source enrichment may fill a missing file path, never replace output metrics.
func applyMediaDetails(d *provider.ActivityDisplay, row DisplayRow) {
	media := selectedMedia(row.Media)
	part := selectedPart(media.Parts)
	var video, audio DisplayStream
	for _, s := range part.Streams {
		if s.Type == 1 && video.Type == 0 {
			video = s
		}
		if s.Type == 2 && (audio.Type == 0 || s.Selected == "1") {
			audio = s
		}
	}
	duration := media.Duration
	if duration <= 0 {
		duration = row.Duration
	}
	width, height := media.Width, media.Height
	if width <= 0 {
		width = video.Width
	}
	if height <= 0 {
		height = video.Height
	}
	channels := media.AudioChannels
	if channels <= 0 {
		channels = audio.Channels
	}
	d.MediaPath = provider.SafeMediaFilePath(part.File)
	d.MediaDuration = mediaDetailNumber(duration, 1e12)
	d.MediaBitrate = mediaDetailNumber(media.Bitrate, 1e9)
	d.MediaWidth = mediaDetailNumber(int64(width), 100000)
	d.MediaHeight = mediaDetailNumber(int64(height), 100000)
	d.MediaAudioChannels = mediaDetailNumber(int64(channels), 128)
	d.MediaAspectRatio = displayText(media.AspectRatio)
	if d.MediaAspectRatio == "" {
		d.MediaAspectRatio = displayText(video.AspectRatio)
	}
	d.MediaVideoCodec = displayText(media.VideoCodec)
	if d.MediaVideoCodec == "" {
		d.MediaVideoCodec = displayText(video.Codec)
	}
	d.MediaAudioCodec = displayText(media.AudioCodec)
	if d.MediaAudioCodec == "" {
		d.MediaAudioCodec = displayText(audio.Codec)
	}
	if resolution := resolutionLabel(media.Resolution, height); resolution != "Unknown" {
		d.MediaVideoResolution = resolution
	}
	d.MediaContainer = displayText(media.Container)
	if d.MediaContainer == "" {
		d.MediaContainer = displayText(part.Container)
	}
	d.MediaVideoFrameRate = displayText(media.FrameRate)
	if d.MediaVideoFrameRate == "" {
		d.MediaVideoFrameRate = displayText(video.FrameRate)
	}
	d.MediaVideoProfile = displayText(video.Profile)
	if d.MediaVideoProfile == "" {
		d.MediaVideoProfile = displayText(media.Profile)
	}
	switch media.VoiceActivity {
	case "0", "false":
		value := false
		d.MediaHasVoiceActivity = &value
	case "1", "true":
		value := true
		d.MediaHasVoiceActivity = &value
	}
}

// Plex's selected live media carries the delivered bitrate. Library metadata
// describes the source, and must not overwrite that rate during transcoding,
// including audio-only transcoding with copied video.
func qualityDetail(live DisplayRow, sourceBitrate int64) string {
	media := selectedMedia(live.Media)
	validRate := func(rate int64) bool { return rate > 0 && rate <= 1000000000 }
	transcode := live.Transcode != nil && (live.Transcode.VideoDecision == "transcode" || live.Transcode.AudioDecision == "transcode")
	if !transcode {
		if validRate(sourceBitrate) {
			return "Original (" + bitrateLabel(sourceBitrate) + ")"
		}
		if validRate(media.Bitrate) {
			return "Original (" + bitrateLabel(media.Bitrate) + ")"
		}
		return "Original (Bitrate N/A)"
	}
	height := live.Transcode.Height
	if height <= 0 {
		height = media.Height
	}
	if !validRate(media.Bitrate) {
		return resolutionLabel(media.Resolution, height) + " (Bitrate N/A)"
	}
	profile := "Original"
	// Ascending profile thresholds match the reference selection: the smallest
	// preset that covers the live bitrate and does not exceed a known source.
	for _, preset := range []struct {
		rate  int64
		label string
	}{
		{64, "0.064 Mbps"}, {96, "0.096 Mbps"}, {208, "0.2 Mbps 160p"}, {320, "0.3 Mbps 240p"}, {720, "0.7 Mbps 328p"}, {1500, "1.5 Mbps 480p"}, {2000, "2 Mbps 720p"}, {3000, "3 Mbps 720p"}, {4000, "4 Mbps 720p"}, {8000, "8 Mbps 1080p"}, {10000, "10 Mbps 1080p"}, {12000, "12 Mbps 1080p"}, {20000, "20 Mbps 1080p"},
	} {
		if media.Bitrate <= preset.rate && (!validRate(sourceBitrate) || preset.rate <= sourceBitrate) {
			profile = preset.label
			break
		}
	}
	return profile + " (" + bitrateLabel(media.Bitrate) + ")"
}

func containerDetail(source, output string, transcoding bool) string {
	source = strings.ToUpper(displayText(source))
	output = strings.ToUpper(displayText(output))
	if transcoding {
		if source == "" {
			source = "N/A"
		}
		if output == "" {
			output = "N/A"
		}
		return "Converting (" + source + " → " + output + ")"
	}
	if source == "" {
		return "Unknown"
	}
	return source
}

const rawPayloadLimit = 8192

// A structural projection of the actual session XML, not a synthesized card DTO.
// Never copy text, unknown elements/attributes, users, keys, paths or URLs.
type rawElement struct {
	Element    string            `json:"element"`
	Attributes map[string]string `json:"attributes,omitempty"`
	Children   []*rawElement     `json:"children,omitempty"`
}

func rawChild(parent, child string) bool {
	switch parent {
	case "Video", "Track":
		return child == "Player" || child == "Session" || child == "Media" || child == "TranscodeSession"
	case "Media":
		return child == "Part"
	case "Part":
		return child == "Stream"
	}
	return false
}

func rawAttribute(element, name, value string) bool {
	// The numeric-only list excludes identifiers that may be opaque credentials.
	numeric := ""
	words := ""
	switch element {
	case "Video", "Track":
		numeric = "duration viewOffset year"
		words = "type"
	case "Player":
		numeric = "local relay"
		words = "state"
	case "Session":
		numeric = "bandwidth"
		words = "location"
	case "Media":
		numeric = "selected duration bitrate width height audioChannels hasVoiceActivity aspectRatio"
		words = "container videoCodec audioCodec videoResolution videoFrameRate videoProfile"
	case "Part":
		numeric = "selected duration size"
		words = "container decision"
	case "Stream":
		numeric = "streamType selected index bitrate width height channels samplingRate bitDepth frameRate aspectRatio"
		words = "codec profile decision scanType colorSpace colorRange colorTrc colorPrimaries"
	case "TranscodeSession":
		numeric = "audioChannels width height throttled speed progress remaining duration transcodeHwRequested transcodeHwFullPipeline"
		words = "videoDecision audioDecision subtitleDecision videoCodec audioCodec container transcodeHwDecoding transcodeHwEncoding"
	}
	if value == "" || len(value) > 64 {
		return false
	}
	if strings.Contains(" "+numeric+" ", " "+name+" ") {
		for _, r := range value {
			if (r < '0' || r > '9') && r != '.' {
				return false
			}
		}
		return true
	}
	if strings.Contains(" "+words+" ", " "+name+" ") {
		for _, r := range value {
			if (r < 'a' || r > 'z') && (r < 'A' || r > 'Z') && (r < '0' || r > '9') && r != '_' && r != '-' && r != '.' && r != ' ' {
				return false
			}
		}
		return true
	}
	return false
}

func parseRawPayloads(body []byte) []string {
	decoder := xml.NewDecoder(bytes.NewReader(body))
	var result []string
	var root *rawElement
	var stack []*rawElement
	depth, nodes, budget := 0, 0, 0
	overflow := false
	for {
		token, err := decoder.Token()
		if err == io.EOF {
			return result
		}
		if err != nil {
			return nil
		}
		switch v := token.(type) {
		case xml.StartElement:
			depth++
			if depth < 2 {
				continue
			}
			if depth == 2 {
				root = nil
				stack = nil
				nodes = 0
				budget = 0
				overflow = false
			}
			var node *rawElement
			allowed := depth == 2 && (v.Name.Local == "Video" || v.Name.Local == "Track")
			if depth > 2 && len(stack) > 0 && stack[len(stack)-1] != nil {
				allowed = rawChild(stack[len(stack)-1].Element, v.Name.Local)
			}
			if allowed && !overflow && v.Name.Space == "" {
				nodes++
				budget += 64
				if nodes > 128 || budget > rawPayloadLimit {
					overflow = true
				} else {
					node = &rawElement{Element: v.Name.Local, Attributes: map[string]string{}}
					for _, attr := range v.Attr {
						if attr.Name.Space == "" && rawAttribute(v.Name.Local, attr.Name.Local, attr.Value) {
							node.Attributes[attr.Name.Local] = attr.Value
							budget += len(attr.Name.Local) + len(attr.Value) + 8
						}
					}
					if depth == 2 {
						root = node
					} else {
						parent := stack[len(stack)-1]
						parent.Children = append(parent.Children, node)
					}
				}
			}
			stack = append(stack, node)
		case xml.EndElement:
			if depth == 2 {
				raw := ""
				if !overflow && root != nil {
					encoded, err := json.Marshal(root)
					if err == nil && len(encoded) <= rawPayloadLimit {
						raw = string(encoded)
					}
				}
				result = append(result, raw)
			}
			if depth >= 2 {
				stack = stack[:len(stack)-1]
			}
			depth--
		}
	}
}

// JSON escaping the diagnostic string adds overhead. Omit optional diagnostics
// before the store's existing total limit can reject authoritative playback.
func boundRawDisplay(d *provider.ActivityDisplay) {
	if d.RawDataJSON == "" {
		return
	}
	encoded, err := json.Marshal(d)
	if err != nil || len(encoded) > 16384 {
		d.RawDataJSON = ""
	}
}
