package tofa

import (
	"context"
	"errors"
	"strings"
	"sync"

	"app/server/providers/provider"
)

// tofaFile is one media file as Tofa's item detail reports it.
type tofaFile struct {
	Available   *bool    `json:"available"`
	Container   *string  `json:"container"`
	Bitrate     *int64   `json:"bitrate"`
	VideoCodec  *string  `json:"video_codec"`
	Height      *int64   `json:"height"`
	FrameRate   *float64 `json:"display_frame_rate"`
	AudioCodec  *string  `json:"audio_codec"`
	Size        *int64   `json:"file_size"`
	AudioTracks []struct {
		Codec    string `json:"codec"`
		Channels *int64 `json:"channels"`
	} `json:"audio_tracks"`
}

func text(v *string) string {
	if v == nil {
		return ""
	}
	return *v
}

// fileMedia is the first available file's detail in the shared labels. Tofa
// reports bitrate in bits per second; the first audio track gives the channels.
func fileMedia(files []tofaFile) *provider.CatalogueMedia {
	for _, f := range files {
		if f.Available == nil || !*f.Available {
			continue
		}
		out := provider.CatalogueMedia{Container: text(f.Container), VideoCodec: text(f.VideoCodec), AudioCodec: text(f.AudioCodec), SizeBytes: f.Size}
		if f.Bitrate != nil && *f.Bitrate > 0 {
			kbps := *f.Bitrate / 1000
			out.BitrateKbps = &kbps
		}
		if f.Height != nil {
			out.VideoResolution = provider.MediaResolution(*f.Height)
		}
		if f.FrameRate != nil {
			out.VideoFrameRate = provider.MediaFrameRate(*f.FrameRate)
		}
		if len(f.AudioTracks) > 0 {
			if out.AudioCodec == "" {
				out.AudioCodec = f.AudioTracks[0].Codec
			}
			out.AudioChannels = f.AudioTracks[0].Channels
		}
		return out.Clean()
	}
	return nil
}

// movieMediaWorkers bounds the item detail requests a library sync makes:
// Tofa lists file details only on each item's own detail.
const movieMediaWorkers = 4

// addFileMedia reads the file details of every movie and video in rows from
// its item detail. A failed read fails the sync rather than saving a partial
// snapshot that would erase details already saved.
func (s *Server) addFileMedia(ctx context.Context, rows []provider.CatalogueItem) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	jobs := make(chan int)
	var wg sync.WaitGroup
	var once sync.Once
	var failure error
	for range movieMediaWorkers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := range jobs {
				var detail struct {
					ID    string     `json:"id"`
					Files []tofaFile `json:"files"`
				}
				err := s.get(ctx, "/api/v1/media/"+rows[i].ID, &detail)
				if err == nil && !strings.EqualFold(detail.ID, rows[i].ID) {
					err = errors.New("invalid Tofa item detail")
				}
				if err != nil {
					once.Do(func() { failure = err; cancel() })
					continue
				}
				rows[i].Media = fileMedia(detail.Files)
			}
		}()
	}
	for i := range rows {
		if rows[i].Type != "movie" && rows[i].Type != "video" {
			continue
		}
		select {
		case jobs <- i:
		case <-ctx.Done():
		}
		if ctx.Err() != nil {
			break
		}
	}
	close(jobs)
	wg.Wait()
	if failure != nil {
		return failure
	}
	return ctx.Err()
}
