package tofa

import (
	"app/server/providers/plex"
	"app/server/providers/provider"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"strings"
	"time"
)

type activityRow struct {
	Session          string   `json:"session_id"`
	User             string   `json:"user_id"`
	File             string   `json:"media_file_id"`
	Item             *string  `json:"media_id"`
	Title            *string  `json:"media_title"`
	UserName         *string  `json:"username"`
	ProfileName      *string  `json:"profile_name"`
	ProfileID        *string  `json:"profile_id"`
	Method           string   `json:"play_method"`
	Paused           *bool    `json:"is_paused"`
	Position         *int64   `json:"position_ms"`
	Duration         *int64   `json:"duration_ms"`
	Client           *string  `json:"client_name"`
	Device           *string  `json:"device_name"`
	Platform         *string  `json:"platform"`
	IP               *string  `json:"client_ip"`
	SourceVideo      *string  `json:"video_codec"`
	OutputVideo      *string  `json:"output_video_codec"`
	SourceAudio      *string  `json:"audio_codec"`
	OutputAudio      *string  `json:"output_audio_codec"`
	Resolution       *string  `json:"resolution"`
	SourceResolution *string  `json:"source_resolution"`
	Bitrate          *int64   `json:"observed_bitrate_kbps"`
	SourceBitrate    *int64   `json:"source_bitrate_kbps"`
	MaxBitrate       *int64   `json:"max_bitrate_kbps"`
	Speed            *float64 `json:"transcode_speed"`
	Subtitle         *struct {
		Codec    string  `json:"codec"`
		Language *string `json:"language"`
		Title    *string `json:"title"`
		BurnedIn *bool   `json:"burned_in"`
	} `json:"selected_subtitle"`
}

func safeLabel(s *string, max int) string {
	if s == nil {
		return ""
	}
	v := strings.Join(strings.Fields(*s), " ")
	if !provider.ValidText(v, max) {
		return ""
	}
	return v
}
func activityTicks(ms *int64) (*int64, error) {
	if ms == nil {
		return nil, nil
	}
	if *ms < 0 || *ms > math.MaxInt64/10000 {
		return nil, provider.ErrActivitySnapshot
	}
	v := *ms * 10000
	return &v, nil
}
func (s *Server) ActivitySnapshot(ctx context.Context) (provider.ActivitySnapshot, error) {
	result := provider.ActivitySnapshot{Provider: "tofa", Sessions: []provider.ActivitySession{}}
	var raw json.RawMessage
	if err := s.get(ctx, "/api/v1/system/playback/sessions", &raw); err != nil {
		return result, provider.ActivityReadError(err)
	}
	result.ObservedAt = time.Now().UTC()
	if len(raw) > 2<<20 {
		return result, provider.ErrActivitySnapshot
	}
	d := json.NewDecoder(bytes.NewReader(raw))
	if err := provider.UniqueJSONKeys(d); err != nil {
		return result, provider.ErrActivitySnapshot
	}
	if _, err := d.Token(); err != io.EOF {
		return result, provider.ErrActivitySnapshot
	}
	var rows []activityRow
	if json.Unmarshal(raw, &rows) != nil || rows == nil || len(rows) > 1000 {
		return result, provider.ErrActivitySnapshot
	}
	seen := map[string]bool{}
	for _, r := range rows {
		if !uuid.MatchString(r.Session) || !uuid.MatchString(r.User) || !uuid.MatchString(r.File) || (r.Item != nil && !uuid.MatchString(*r.Item)) || seen[r.Session] || r.Paused == nil {
			return result, provider.ErrActivitySnapshot
		}
		seen[r.Session] = true
		pos, err := activityTicks(r.Position)
		if err != nil {
			return result, err
		}
		duration, err := activityTicks(r.Duration)
		if err != nil {
			return result, err
		}
		var media struct {
			ID      string  `json:"id"`
			Type    string  `json:"media_type"`
			Title   string  `json:"title"`
			Poster  *string `json:"poster_path"`
			Release *string `json:"release_date"`
			Files   []struct {
				ID        string  `json:"id"`
				Container *string `json:"container"`
			} `json:"files"`
			Seasons []struct {
				Number   *int64 `json:"season_number"`
				Episodes []struct {
					ID    string  `json:"id"`
					Title *string `json:"title"`
					Files []struct {
						ID        string  `json:"id"`
						Container *string `json:"container"`
					} `json:"files"`
				} `json:"episodes"`
			} `json:"seasons"`
		}
		itemID := r.File
		if r.Item != nil {
			itemID = *r.Item
			if err := s.get(ctx, "/api/v1/media/"+itemID, &media); err != nil {
				return result, provider.ActivityReadError(err)
			}
			if !strings.EqualFold(media.ID, itemID) {
				return result, provider.ErrActivitySnapshot
			}
		} else {
			media.Type = "other"
		}
		kind := "Video"
		switch media.Type {
		case "movie":
			kind = "Movie"
		case "tv":
			kind = "Episode"
		case "other":
		default:
			return result, provider.ErrActivitySnapshot
		}
		title := safeLabel(r.Title, 1024)
		if title == "" {
			title = safeLabel(&media.Title, 1024)
		}
		if title == "" && r.Item == nil {
			title = "Unknown title"
		}
		session := provider.ActivitySession{Session: r.Session, User: r.User, Item: itemID, UserName: safeLabel(r.UserName, 128), Title: title, Kind: kind, Paused: *r.Paused, Position: pos, Duration: duration, Client: safeLabel(r.Client, 128), Device: safeLabel(r.Device, 256), Platform: safeLabel(r.Platform, 64), PlayMethod: provider.PlayMethods[r.Method]}
		display := &provider.ActivityDisplay{PlayerTitle: session.Device, PlayerPlatform: session.Platform, ProfileName: safeLabel(r.ProfileName, 128), Product: session.Client, SourceResolution: safeLabel(r.SourceResolution, 8), StreamResolution: safeLabel(r.Resolution, 8), MediaVideoCodec: safeLabel(r.SourceVideo, 64), MediaAudioCodec: safeLabel(r.SourceAudio, 64)}
		if r.ProfileID != nil && uuid.MatchString(*r.ProfileID) {
			avatar, avatarErr := s.profileAvatar(ctx, r.User, *r.ProfileID)
			if avatarErr != nil {
				return result, avatarErr
			}
			display.AvatarPath = avatar
		}
		// Keep only playback diagnostics, never provider URLs, tokens or file paths.
		method := "Unknown"
		if session.PlayMethod != "" {
			method = r.Method
		}
		diagnostics := map[string]any{
			"play_method":           method,
			"is_paused":             r.Paused,
			"position_ms":           r.Position,
			"duration_ms":           r.Duration,
			"video_codec":           safeLabel(r.SourceVideo, 64),
			"output_video_codec":    safeLabel(r.OutputVideo, 64),
			"audio_codec":           safeLabel(r.SourceAudio, 64),
			"output_audio_codec":    safeLabel(r.OutputAudio, 64),
			"source_resolution":     safeLabel(r.SourceResolution, 64),
			"resolution":            safeLabel(r.Resolution, 64),
			"observed_bitrate_kbps": r.Bitrate,
			"source_bitrate_kbps":   r.SourceBitrate,
			"max_bitrate_kbps":      r.MaxBitrate,
		}
		if encoded, err := json.Marshal(diagnostics); err == nil && len(encoded) <= 8192 {
			display.RawDataJSON = string(encoded)
		}
		for _, f := range media.Files {
			if strings.EqualFold(f.ID, r.File) {
				display.Container = strings.ToUpper(safeLabel(f.Container, 64))
			}
		}
		if kind == "Episode" {
			for _, season := range media.Seasons {
				for _, episode := range season.Episodes {
					for _, f := range episode.Files {
						if strings.EqualFold(f.ID, r.File) && uuid.MatchString(episode.ID) {
							session.Item = episode.ID
							session.Parent = *r.Item
							session.ParentTitle = safeLabel(&media.Title, 1024)
							if episodeTitle := safeLabel(episode.Title, 1024); episodeTitle != "" {
								session.Title = episodeTitle
							}
							display.ParentTitle = session.ParentTitle
							display.Container = strings.ToUpper(safeLabel(f.Container, 64))
						}
					}
				}
			}
		}
		if media.Poster != nil && *media.Poster != "" {
			display.PosterItem = *r.Item
			display.PosterPath = "poster"
		}
		if media.Release != nil && len(*media.Release) >= 4 {
			display.Year = (*media.Release)[:4]
		}
		if r.IP != nil {
			if ip := plex.SessionAddress(*r.IP); ip.IsValid() {
				session.Address = ip.String()
				display.IP = ip.String()
				public := plex.PublicSessionAddress(display.IP).IsValid()
				display.PublicIP = &public
				if public {
					display.LocationType = "WAN"
				} else {
					display.LocationType = "LAN"
				}
				display.Location = display.LocationType + ": " + display.IP
			}
		}
		video := strings.ToUpper(safeLabel(r.SourceVideo, 64))
		audio := strings.ToUpper(safeLabel(r.SourceAudio, 64))
		outVideo := strings.ToUpper(safeLabel(r.OutputVideo, 64))
		outAudio := strings.ToUpper(safeLabel(r.OutputAudio, 64))
		if video != "" && display.SourceResolution != "" {
			video += " " + display.SourceResolution
		}
		if outVideo != "" && display.StreamResolution != "" {
			outVideo += " " + display.StreamResolution
		}
		switch session.PlayMethod {
		case "direct_play":
			display.Stream = "Direct Play"
		case "direct_stream":
			display.Stream = "Direct Stream"
		case "transcode":
			display.Stream = "Transcode"
		}
		if session.PlayMethod == "transcode" && display.Container != "" {
			display.Container = "Source: " + display.Container
		}
		if session.PlayMethod != "" {
			isTranscode := session.PlayMethod == "transcode"
			display.IsTranscode = &isTranscode
		}
		if video != "" {
			display.Video = video
			if outVideo != "" && outVideo != video {
				display.Video += " → " + outVideo
			}
		}
		if audio != "" {
			display.Audio = audio
			if outAudio != "" && outAudio != audio {
				display.Audio += " → " + outAudio
			}
		}
		if r.Subtitle != nil {
			label := safeLabel(r.Subtitle.Title, 128)
			if label == "" {
				label = safeLabel(r.Subtitle.Language, 64)
			}
			codec := safeLabel(&r.Subtitle.Codec, 64)
			if label != "" && codec != "" {
				label += " (" + strings.ToUpper(codec) + ")"
			} else if label == "" {
				label = strings.ToUpper(codec)
			}
			if label != "" && r.Subtitle.BurnedIn != nil && *r.Subtitle.BurnedIn {
				label += " · Burned in"
			}
			display.Subtitle = label
		}
		if r.Bitrate != nil && *r.Bitrate >= 0 && *r.Bitrate <= 100000000 {
			v := *r.Bitrate
			display.Bitrate = &v
			display.Bandwidth = fmt.Sprintf("%.1f Mbps", float64(v)/1000)
		}
		if session.PlayMethod == "transcode" && r.MaxBitrate != nil && *r.MaxBitrate > 0 && *r.MaxBitrate < 100000000 {
			display.Quality = fmt.Sprintf("Up to %.1f Mbps", float64(*r.MaxBitrate)/1000)
		} else if session.PlayMethod != "transcode" && r.SourceBitrate != nil && *r.SourceBitrate > 0 && *r.SourceBitrate < 100000000 {
			display.Quality = fmt.Sprintf("Original (%.1f Mbps)", float64(*r.SourceBitrate)/1000)
		}
		if r.Speed != nil && *r.Speed >= 0 && !math.IsNaN(*r.Speed) && !math.IsInf(*r.Speed, 0) {
			display.Speed = r.Speed
		}
		session.Display = display
		if !provider.ValidActivitySession(session) {
			return result, provider.ErrActivitySnapshot
		}
		result.Sessions = append(result.Sessions, session)
	}
	return result, nil
}
