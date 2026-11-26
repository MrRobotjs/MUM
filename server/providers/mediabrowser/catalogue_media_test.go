package mediabrowser

import (
	"encoding/json"
	"testing"
)

func TestCatalogueMediaUsesVideoAndDefaultAudio(t *testing.T) {
	var sources []catalogueSource
	if err := json.Unmarshal([]byte(`[{"Container":"mkv","Bitrate":9861000,"Size":8800000000,"MediaStreams":[
		{"Type":"Video","Codec":"hevc","Height":1080,"RealFrameRate":23.976},
		{"Type":"Audio","Codec":"aac","Channels":2},
		{"Type":"Audio","Codec":"eac3","Channels":6,"IsDefault":true},
		{"Type":"Audio","Codec":"dts","Channels":8},
		{"Type":"Subtitle","Codec":"srt"}]},{"Container":"mp4"}]`), &sources); err != nil {
		t.Fatal(err)
	}
	m := catalogueMedia(sources)
	if m == nil || m.Container != "MKV" || *m.BitrateKbps != 9861 || *m.SizeBytes != 8800000000 || m.VideoCodec != "HEVC" || m.VideoResolution != "1080p" || m.VideoFrameRate != "24p" || m.AudioCodec != "EAC3" || *m.AudioChannels != 6 {
		t.Fatalf("%+v", m)
	}
	if catalogueMedia(nil) != nil {
		t.Fatal("item without files has media info")
	}
}
