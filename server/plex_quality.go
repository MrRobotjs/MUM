package main

// Plex's selected live media carries the delivered bitrate. Library metadata
// describes the source, and must not overwrite that rate during transcoding,
// including audio-only transcoding with copied video.
func plexQualityDetail(live plexDisplayRow, sourceBitrate int64) string {
	media := selectedPlexMedia(live.Media)
	validRate := func(rate int64) bool { return rate > 0 && rate <= 1000000000 }
	transcode := live.Transcode != nil && (live.Transcode.VideoDecision == "transcode" || live.Transcode.AudioDecision == "transcode")
	if !transcode {
		if validRate(sourceBitrate) {
			return "Original (" + plexRate(sourceBitrate) + ")"
		}
		if validRate(media.Bitrate) {
			return "Original (" + plexRate(media.Bitrate) + ")"
		}
		return "Original (Bitrate N/A)"
	}
	height := live.Transcode.Height
	if height <= 0 {
		height = media.Height
	}
	if !validRate(media.Bitrate) {
		return plexResolution(media.Resolution, height) + " (Bitrate N/A)"
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
	return profile + " (" + plexRate(media.Bitrate) + ")"
}
