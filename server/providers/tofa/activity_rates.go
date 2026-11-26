package tofa

import (
	"fmt"
	"strconv"
	"strings"
)

// rates is what a stream card shows for a session's bitrate: the bandwidth
// the stream is expected to use, its quality, and the delivery rate Tofa
// measured. Rates are in kbps; zero means unknown.
type rates struct {
	Bandwidth int64
	Quality   string
	Measured  int64
}

func validRate(kbps *int64) int64 {
	if kbps == nil || *kbps <= 0 || *kbps >= 100000000 {
		return 0
	}
	return *kbps
}

func mbps(kbps int64) string { return fmt.Sprintf("%.1f Mbps", float64(kbps)/1000) }

// frameHeight reads the height from a "1920x1080" resolution; zero when unknown.
func frameHeight(res *string) int64 {
	if res == nil {
		return 0
	}
	_, h, ok := strings.Cut(strings.ToLower(strings.TrimSpace(*res)), "x")
	if !ok {
		return 0
	}
	n, err := strconv.ParseInt(h, 10, 64)
	if err != nil || n <= 0 || n > 100000 {
		return 0
	}
	return n
}

// streamRates works out the expected bandwidth from what Tofa reports. Tofa
// does not report the bitrate a transcode targets, so:
//   - direct play and direct stream send the file, so they use its bitrate;
//   - a transcode limited below the file's bitrate uses that limit;
//   - a transcode at the file's resolution with no lower limit keeps about the
//     file's bitrate;
//   - anything else (a transcode to a lower resolution, or missing figures)
//     falls back to the measured rate.
func streamRates(method string, source, limit, observed *int64, sourceRes, outputRes *string) rates {
	src, max, seen := validRate(source), validRate(limit), validRate(observed)
	from, to := frameHeight(sourceRes), frameHeight(outputRes)
	out := rates{Measured: seen}
	switch method {
	case "direct_play", "direct_stream":
		out.Bandwidth = src
		if src > 0 {
			out.Quality = "Original (" + mbps(src) + ")"
		}
	case "transcode":
		switch {
		case max > 0 && src > 0 && max < src:
			out.Bandwidth = max
			out.Quality = "Up to " + mbps(max)
		case from > 0 && to > 0 && to < from:
			out.Quality = fmt.Sprintf("%dp", to)
		case src > 0 && from > 0 && to == from:
			out.Bandwidth = src
			out.Quality = "Original (" + mbps(src) + ")"
		}
	}
	if out.Bandwidth == 0 {
		out.Bandwidth = seen
	}
	if out.Bandwidth == seen {
		out.Measured = 0
	}
	return out
}
