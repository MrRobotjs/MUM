package main

import "strings"

func mediaDetailNumber(value, max int64) *int64 {
	if value <= 0 || value > max {
		return nil
	}
	return &value
}

func safeMediaFilePath(value string) string {
	value = strings.TrimSpace(value)
	if !activityText(value, 1024) || strings.Contains(value, "://") || strings.Contains(value, "?") {
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

// Match the reference popup: selected live media/part and stream fallbacks.
// Source enrichment may fill a missing file path, never replace output metrics.
func applyPlexMediaDetails(d *activityDisplay, row plexDisplayRow) {
	media := selectedPlexMedia(row.Media)
	part := selectedPlexPart(media.Parts)
	var video, audio plexDisplayStream
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
	d.MediaPath = safeMediaFilePath(part.File)
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
	if resolution := plexResolution(media.Resolution, height); resolution != "Unknown" {
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
