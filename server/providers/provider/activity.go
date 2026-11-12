package provider

import (
	"bytes"
	"encoding/json"
	"errors"
	"strings"
	"time"
)

// ErrActivitySnapshot reports a sessions reply that is unsupported, incomplete
// or invalid. A module returns it instead of a partial or empty snapshot, so a
// failed read never looks like "nobody is playing".
var ErrActivitySnapshot = errors.New("provider activity snapshot is unsupported, incomplete or invalid")

// ActivityReadError reports a failed sessions request as ErrActivitySnapshot.
// Only an authority error from the transport's guard is kept, so the core can
// tell a revoked operation from an unreachable server.
func ActivityReadError(err error) error {
	var status *HTTPError
	if errors.Is(err, ErrRequestFailed) || errors.Is(err, ErrUnsupportedType) || errors.Is(err, ErrUnreadableBody) || errors.As(err, &status) {
		return ErrActivitySnapshot
	}
	return err
}

// ActivitySession is one playback session as reported by a media server.
type ActivitySession struct {
	Session, User, Item, Kind, Title string
	UserName                         string
	Display                          *ActivityDisplay
	// Parent is the series of an episode or the album of a track, used to
	// attribute plays to library catalogue items. Optional.
	Parent, ParentTitle string
	Paused              bool
	Position, Duration  *int64
	// Client application, device name and delivery mode as last reported.
	// Empty means unknown. Device names stay private: only classified
	// buckets leave MUM's store.
	Client, Device, PlayMethod string
}

// ActivitySnapshot is a complete list of a server's current sessions.
type ActivitySnapshot struct {
	Provider   string
	ObservedAt time.Time
	Sessions   []ActivitySession
}

// ActivityDisplay is current, administrator-only presentation data. It never
// holds raw unfiltered payloads or tokens. Allowlisted technical diagnostics
// and selected local media paths are administrator-only current-session
// details. Avatar and poster descriptors stay private and are replaced by
// signed application URLs in MUM's DTO. MUM clears it when the session ends.
type ActivityDisplay struct {
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

// ValidActivitySession checks the identity, text and progress fields every
// stored session must have.
func ValidActivitySession(s ActivitySession) bool {
	if s.UserName != "" && !ValidText(s.UserName, 128) {
		return false
	}
	if !ValidText(s.Session, 256) || !ValidText(s.User, 256) || !ValidText(s.Item, 256) || !ValidText(s.Title, 1024) {
		return false
	}
	if s.Parent != "" && !ValidText(s.Parent, 256) || s.ParentTitle != "" && (s.Parent == "" || !ValidText(s.ParentTitle, 1024)) {
		return false
	}
	switch s.Kind {
	case "Movie", "Episode", "Audio", "Video", "MusicVideo", "Trailer":
	default:
		return false
	}
	if s.Position != nil && *s.Position < 0 || s.Duration != nil && *s.Duration < 0 || s.Position != nil && s.Duration != nil && *s.Position > *s.Duration {
		return false
	}
	return true
}

// PlayMethods maps reported delivery modes to stored values. Unrecognised
// methods are recorded as unknown.
var PlayMethods = map[string]string{"DirectPlay": "direct_play", "DirectStream": "direct_stream", "Transcode": "transcode"}

// OptionalLabel reads an optional string from a sessions reply. Absent, null,
// blank, oversized or control-character values are unknown (""); a value of
// another JSON type makes the snapshot malformed.
func OptionalLabel(raw json.RawMessage, maximum int) (string, error) {
	if raw == nil || bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return "", nil
	}
	var value string
	if err := json.Unmarshal(raw, &value); err != nil {
		return "", ErrActivitySnapshot
	}
	value = strings.Join(strings.Fields(value), " ")
	if !ValidText(value, maximum) {
		return "", nil
	}
	return value, nil
}

// SafeMediaFilePath keeps an absolute local media path and drops anything
// that looks like a URL or carries a query.
func SafeMediaFilePath(value string) string {
	value = strings.TrimSpace(value)
	if !ValidText(value, 1024) || strings.Contains(value, "://") || strings.Contains(value, "?") {
		return ""
	}
	absolute := strings.HasPrefix(value, "/") || strings.HasPrefix(value, `\\`)
	if len(value) > 3 && ((value[0] >= 'A' && value[0] <= 'Z') || (value[0] >= 'a' && value[0] <= 'z')) && value[1] == ':' && (value[2] == '/' || value[2] == '\\') {
		absolute = true
	}
	if !absolute {
		return ""
	}
	return value
}

// UniqueJSONKeys reads one JSON value from d and rejects duplicate object keys
// at any nesting level, so a reply cannot hide a second value for a field
// MUM decodes. Unknown fields are allowed.
func UniqueJSONKeys(d *json.Decoder) error { return uniqueKeys(d, 0) }

func uniqueKeys(d *json.Decoder, depth int) error {
	bad := ErrActivitySnapshot
	if depth > 32 {
		return bad
	}
	token, err := d.Token()
	if err != nil {
		return bad
	}
	delimiter, container := token.(json.Delim)
	if !container {
		return nil
	}
	switch delimiter {
	case '{':
		seen := map[string]bool{}
		for d.More() {
			key, err := d.Token()
			if err != nil {
				return bad
			}
			name, ok := key.(string)
			if !ok || seen[name] {
				return bad
			}
			seen[name] = true
			if err := uniqueKeys(d, depth+1); err != nil {
				return err
			}
		}
	case '[':
		for d.More() {
			if err := uniqueKeys(d, depth+1); err != nil {
				return err
			}
		}
	default:
		return bad
	}
	close, err := d.Token()
	if err != nil || delimiter == '{' && close != json.Delim('}') || delimiter == '[' && close != json.Delim(']') {
		return bad
	}
	return nil
}
