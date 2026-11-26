package tofa

import (
	"fmt"
	"strings"
)

// Tofa's delivery decisions, from its playback session API.
const (
	decisionDirectFile = "DirectFile"
	decisionRemux      = "HlsRemux"
	decisionAudioOnly  = "HlsCopyVideoTranscodeAudio"
	decisionFull       = "HlsFullTranscode"
)

// resolutionLabel turns a "1920x1080" frame size into the resolution class the
// cards and graphs use for every media service: SD, 720p, 1080p, 1440p, 4K.
// Banding by height keeps wide frames such as 1920x800 in their class.
func resolutionLabel(resolution *string) string {
	switch h := frameHeight(resolution); {
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

// trackLabel is a codec with its resolution when known, e.g. "H264 1080p".
func trackLabel(codec, resolution *string) string {
	label := strings.ToUpper(safeLabel(codec, 64))
	if label == "" {
		return ""
	}
	if res := resolutionLabel(resolution); res != "" {
		label += " " + res
	}
	return label
}

func directPlay(label string) string   { return "Direct Play (" + label + ")" }
func directStream(label string) string { return "Direct Stream (" + label + ")" }
func transcode(from, to string) string {
	if to == "" {
		to = "Unknown"
	}
	return "Transcode (" + from + " → " + to + ")"
}

// streamDecisions labels the container, video and audio lines the way the
// other stream cards do. Tofa delivers anything that isn't the file itself
// over HLS and doesn't report the segment format, so the output container is
// shown as HLS. Without a known decision only the source is shown.
func streamDecisions(decision, method, container, video, outVideo, audio, outAudio string) (string, string, string) {
	if container == "" {
		container = "Unknown"
	}
	// Audio inside an HLS transcode is copied when the codec is unchanged.
	hlsAudio := func() string {
		if outAudio == "" || outAudio == audio {
			return directStream(audio)
		}
		return transcode(audio, outAudio)
	}
	label := func(track string, f func(string) string) string {
		if track == "" {
			return ""
		}
		return f(track)
	}
	switch decision {
	case decisionDirectFile:
		return container, label(video, directPlay), label(audio, directPlay)
	case decisionRemux:
		return container, label(video, directStream), label(audio, directStream)
	case decisionAudioOnly:
		return "Converting (" + container + " → HLS)", label(video, directStream), label(audio, func(string) string { return hlsAudio() })
	case decisionFull:
		return "Converting (" + container + " → HLS)",
			label(video, func(v string) string { return transcode(v, outVideo) }),
			label(audio, func(string) string { return hlsAudio() })
	}
	if container == "Unknown" {
		container = ""
	}
	if method == "transcode" && container != "" {
		container = "Converting (" + container + " → HLS)"
	}
	if video != "" && outVideo != "" && outVideo != video {
		video += " → " + outVideo
	}
	if audio != "" && outAudio != "" && outAudio != audio {
		audio += " → " + outAudio
	}
	return container, video, audio
}
