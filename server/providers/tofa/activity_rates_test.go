package tofa

import "testing"

func TestStreamRatesUseExpectedBandwidth(t *testing.T) {
	n := func(v int64) *int64 { return &v }
	s := func(v string) *string { return &v }
	cases := []struct {
		name                    string
		method                  string
		source, limit, observed *int64
		sourceRes, outputRes    *string
		bandwidth, measured     int64
		quality                 string
	}{
		// A 1080p transcode with a limit above the file keeps the file's bitrate.
		{"transcode under a higher limit", "transcode", n(10178), n(38065), n(1912), s("1920x1080"), s("1920x1080"), 10178, 1912, "Original (10.2 Mbps)"},
		{"transcode limited below the file", "transcode", n(10178), n(4000), n(3500), s("1920x1080"), s("1280x720"), 4000, 3500, "Up to 4.0 Mbps"},
		{"transcode to a lower resolution without a lower limit", "transcode", n(40000), n(80000), n(9000), s("3840x2160"), s("1920x1080"), 9000, 0, "1080p"},
		{"direct play uses the file", "direct_play", n(10178), nil, n(2500), s("1920x1080"), nil, 10178, 2500, "Original (10.2 Mbps)"},
		{"direct stream uses the file", "direct_stream", n(8000), n(1000), nil, nil, nil, 8000, 0, "Original (8.0 Mbps)"},
		{"unknown figures fall back to the measured rate", "transcode", nil, nil, n(5000), nil, nil, 5000, 0, ""},
		{"unknown resolution falls back to the measured rate", "transcode", n(10000), n(20000), n(6000), nil, s("1920x1080"), 6000, 0, ""},
		{"nothing reported", "", nil, nil, nil, nil, nil, 0, 0, ""},
		{"out of range rates are ignored", "direct_play", n(-1), nil, n(100000000), nil, nil, 0, 0, ""},
	}
	for _, c := range cases {
		got := streamRates(c.method, c.source, c.limit, c.observed, c.sourceRes, c.outputRes)
		if got.Bandwidth != c.bandwidth || got.Measured != c.measured || got.Quality != c.quality {
			t.Errorf("%s: got %+v", c.name, got)
		}
	}
}
