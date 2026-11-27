package plex

import "testing"

func TestCatalogueMediaReadsFirstFile(t *testing.T) {
	page, err := DecodeCataloguePage([]byte(`<MediaContainer size="2" totalSize="2" offset="0">` +
		`<Video ratingKey="1" type="movie" title="Film"><Media container="mkv" bitrate="9861" videoCodec="hevc" videoResolution="1080" height="800" videoFrameRate="24p" audioCodec="eac3" audioChannels="6"><Part size="4000"/><Part size="5000"/></Media><Media container="mp4"/></Video>` +
		`<Video ratingKey="2" type="movie" title="Old"><Media videoResolution="sd" videoFrameRate="NTSC"><Part/></Media></Video>` +
		`</MediaContainer>`))
	if err != nil {
		t.Fatal(err)
	}
	m := catalogueMedia(page.Items[0])
	if m == nil || m.Container != "MKV" || *m.BitrateKbps != 9861 || m.VideoCodec != "HEVC" || m.VideoResolution != "1080p" || m.VideoFrameRate != "24p" || m.AudioCodec != "EAC3" || *m.AudioChannels != 6 || *m.SizeBytes != 9000 {
		t.Fatalf("%+v", m)
	}
	old := catalogueMedia(page.Items[1])
	if old == nil || old.VideoResolution != "SD" || old.VideoFrameRate != "30p (NTSC)" || old.SizeBytes != nil {
		t.Fatalf("%+v", old)
	}
	if catalogueMedia(CatalogueEntry{}) != nil {
		t.Fatal("item without files has media info")
	}
}
