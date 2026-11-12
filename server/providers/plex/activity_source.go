package plex

import (
	"context"
	"encoding/xml"
	"log/slog"
	"strings"
	"time"

	"app/server/providers/provider"
)

// Source metadata is optional presentation enrichment. It never supplies session
// membership, identity, progress or playback state. Bound all lookups together,
// deduplicate within this snapshot only and never retain stale cross-poll data.
func (s *Server) enrichSourceDisplay(ctx context.Context, body []byte, snapshot *provider.ActivitySnapshot) {
	var page struct {
		Rows []DisplayRow `xml:",any"`
	}
	if xml.Unmarshal(body, &page) != nil || len(page.Rows) != len(snapshot.Sessions) {
		return
	}
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	cache := map[string]*DisplayRow{}
	failures := 0
	for index, row := range page.Rows {
		if len(row.Media) == 0 || snapshot.Sessions[index].Display == nil {
			continue
		}
		source, known := cache[row.Item]
		if !known {
			if len(cache) >= 32 || ctx.Err() != nil {
				continue
			}
			raw, err := s.Read(ctx, "/library/metadata/"+row.Item, 2<<20)
			if err == nil {
				source = DecodeSourceDisplay(raw, row.Item, row.Kind)
			}
			cache[row.Item] = source
			if source == nil {
				failures++
			}
		}
		if source != nil {
			ApplySourceDisplay(snapshot.Sessions[index].Display, row, *source)
		}
	}
	if failures > 0 {
		slog.Debug("Plex source metadata unavailable; retained session observations", "failed_items", failures)
	}
}

// DecodeSourceDisplay reads one item's library metadata, or nil when the reply
// is not exactly that item.
func DecodeSourceDisplay(body []byte, item, kind string) *DisplayRow {
	page, err := DecodeCataloguePage(body)
	if err != nil || page.Size == nil || *page.Size != 1 || len(page.Items) != 1 || page.Items[0].ID != item || page.Items[0].Kind != kind || page.Total != nil && *page.Total != 1 || page.Offset != nil && *page.Offset != 0 {
		return nil
	}
	var source struct {
		Rows []DisplayRow `xml:",any"`
	}
	if xml.Unmarshal(body, &source) != nil || len(source.Rows) != 1 || source.Rows[0].Item != item {
		return nil
	}
	return &source.Rows[0]
}

func selectedMedia(rows []DisplayMedia) DisplayMedia {
	if len(rows) == 0 {
		return DisplayMedia{}
	}
	for _, v := range rows {
		if v.Selected == "1" {
			return v
		}
	}
	return rows[0]
}
func selectedPart(rows []DisplayPart) DisplayPart {
	if len(rows) == 0 {
		return DisplayPart{}
	}
	for _, v := range rows {
		if v.Selected == "1" {
			return v
		}
	}
	return rows[0]
}

// ApplySourceDisplay fills the source side of a display from the item's
// library metadata, using only the media version and part being played.
func ApplySourceDisplay(d *provider.ActivityDisplay, live, original DisplayRow) {
	liveMedia := selectedMedia(live.Media)
	media := selectedMedia(original.Media)
	if liveMedia.ID == "" && len(original.Media) > 1 {
		selected := 0
		for _, m := range original.Media {
			if m.Selected == "1" {
				media = m
				selected++
			}
		}
		if selected != 1 {
			return
		}
	}
	if liveMedia.ID != "" {
		found := false
		for _, m := range original.Media {
			if m.ID == liveMedia.ID {
				media = m
				found = true
				break
			}
		}
		if !found {
			return
		} // Never guess another source version.
	}
	if len(original.Media) == 0 {
		return
	}
	livePart := selectedPart(liveMedia.Parts)
	part := selectedPart(media.Parts)
	if livePart.ID == "" && len(media.Parts) > 1 {
		selected := 0
		for _, v := range media.Parts {
			if v.Selected == "1" {
				part = v
				selected++
			}
		}
		if selected != 1 {
			return
		}
	}
	if livePart.ID != "" {
		found := false
		for _, v := range media.Parts {
			if v.ID == livePart.ID {
				part = v
				found = true
				break
			}
		}
		if !found {
			return
		}
	}
	videoCodec := displayText(media.VideoCodec)
	if d.MediaPath == "" {
		d.MediaPath = provider.SafeMediaFilePath(part.File)
	}
	videoHeight := media.Height
	audioID := ""
	for _, v := range livePart.Streams {
		if v.Type == 2 && v.Selected == "1" {
			audioID = v.ID
			break
		}
	}
	var audio DisplayStream
	for _, v := range part.Streams {
		if v.Type == 1 {
			if videoCodec == "" {
				videoCodec = displayText(v.Codec)
			}
			if videoHeight == 0 {
				videoHeight = v.Height
			}
		}
		if v.Type == 2 && (audio.Type == 0 || v.Selected == "1") {
			audio = v
		}
	}
	if audioID != "" {
		audio = DisplayStream{}
		for _, v := range part.Streams {
			if v.Type == 2 && v.ID == audioID {
				audio = v
				break
			}
		}
	}
	resolution := resolutionLabel(media.Resolution, videoHeight)
	hasVideoSource := videoCodec != "" || resolution != "Unknown"
	if videoCodec == "" {
		videoCodec = "Unknown"
	}
	videoLabel := strings.TrimSpace(strings.ToUpper(videoCodec) + " " + resolution)
	audioLabel := displayText(audio.Title)
	if audioLabel == "" && audio.Type != 0 {
		audioLabel = audioOutput(audio.Codec, audio.Channels)
	}
	container := strings.ToUpper(displayText(media.Container))
	if container == "" {
		container = strings.ToUpper(displayText(part.Container))
	}
	d.Quality = qualityDetail(live, media.Bitrate)
	if ts := live.Transcode; ts != nil {
		targetHeight := ts.Height
		if targetHeight <= 0 {
			targetHeight = liveMedia.Height
		}
		output := strings.ToUpper(displayText(ts.Container))
		if output == "" {
			output = strings.ToUpper(displayText(liveMedia.Container))
		}
		sourceContainer := container
		if sourceContainer == "" {
			sourceContainer = liveMedia.Container
		}
		d.Container = containerDetail(sourceContainer, output, ts.VideoDecision == "transcode" || ts.AudioDecision == "transcode")
		if hasVideoSource && ts.VideoDecision == "transcode" {
			sourceLabel := videoLabel
			if ts.HWDecode == "1" {
				sourceLabel = strings.TrimSpace(strings.ToUpper(videoCodec) + " (HW) " + resolutionLabel(media.Resolution, videoHeight))
			}
			target := strings.ToUpper(displayText(ts.VideoCodec))
			if ts.HWEncode == "1" {
				target += " (HW)"
			}
			d.Video = decisionDetail("transcode", sourceLabel, strings.TrimSpace(target+" "+resolutionLabel(liveMedia.Resolution, targetHeight)))
		} else if hasVideoSource {
			d.Video = decisionDetail(ts.VideoDecision, videoLabel, "")
		}
		if audioLabel != "" {
			d.Audio = decisionDetail(ts.AudioDecision, audioLabel, audioOutput(ts.AudioCodec, ts.AudioChannels))
		}
	} else {
		if container != "" {
			d.Container = container
		}
		if hasVideoSource {
			d.Video = "Direct Play (" + videoLabel + ")"
		}
		if audioLabel != "" {
			d.Audio = "Direct Play (" + audioLabel + ")"
		}
	}
	if live.Kind == "track" {
		d.Video = "Audio Only"
	}
}
