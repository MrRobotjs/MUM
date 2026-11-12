package main

import (
	"app/server/providers/plex"
	"app/server/providers/provider"
	"encoding/json"
	"strings"
	"testing"
)

func TestPlexMediaDetailsSelectedOutputAndSourcePath(t *testing.T) {
	body := `<MediaContainer size="1"><Video ratingKey="123" type="movie" duration="6554000"><Media id="wrong" container="avi"/><Media id="7" selected="1" duration="6554720" bitrate="7400" width="1920" height="804" aspectRatio="2.39" audioChannels="6" audioCodec="eac3" videoCodec="hevc" videoResolution="1080" videoFrameRate="24p" hasVoiceActivity="0"><Part id="wrong" file="/wrong.mkv"/><Part id="8" selected="1" container="mpegts"><Stream streamType="1" codec="hevc" profile="main 10"/><Stream streamType="2" codec="eac3" channels="6"/></Part></Media></Video></MediaContainer>`
	displays, err := plex.ParseDisplays([]byte(body))
	if err != nil || len(displays) != 1 {
		t.Fatal(err)
	}
	source := plex.DecodeSourceDisplay([]byte(`<MediaContainer size="1"><Video ratingKey="123" type="movie"><Media id="7"><Part id="8" file="/media/Fixture Film.mkv"/></Media></Video></MediaContainer>`), "123", "movie")
	if source == nil {
		t.Fatal("source fixture rejected")
	}
	var live plex.DisplayRow
	live.Item = "123"
	live.Media = []plex.DisplayMedia{{ID: "7", Parts: []plex.DisplayPart{{ID: "8"}}}}
	plex.ApplySourceDisplay(displays[0], live, *source)
	raw, _ := json.Marshal(displays[0])
	var got map[string]any
	json.Unmarshal(raw, &got)
	for key, want := range map[string]any{"media_path": "/media/Fixture Film.mkv", "media_duration": float64(6554720), "media_bitrate": float64(7400), "media_width": float64(1920), "media_height": float64(804), "media_aspect_ratio": "2.39", "media_audio_channels": float64(6), "media_audio_codec": "eac3", "media_video_codec": "hevc", "media_video_resolution": "1080p", "media_container": "mpegts", "media_video_frame_rate": "24p", "media_video_profile": "main 10", "media_has_voice_activity": false} {
		if got[key] != want {
			t.Errorf("%s: got %v want %v", key, got[key], want)
		}
	}
	if strings.Contains(string(raw), "/wrong.mkv") {
		t.Fatal("unselected path leaked")
	}
}

func TestPlexMediaDetailsSourceVersionAndPathValidation(t *testing.T) {
	for _, value := range []string{`C:\Media\Fixture.mkv`, `\\nas\Media\Fixture.mkv`, "/media/Fixture.mkv"} {
		if provider.SafeMediaFilePath(value) != value {
			t.Fatal("valid local path rejected")
		}
	}
	for _, value := range []string{"relative.mkv", "https://fixture.invalid/file", "/media/fixture?token=private", strings.Repeat("x", 1025)} {
		if provider.SafeMediaFilePath(value) != "" {
			t.Fatal("invalid local path admitted")
		}
	}
	original := plex.DecodeSourceDisplay([]byte(`<MediaContainer size="1"><Video ratingKey="123" type="movie"><Media id="7"><Part id="8" file="/media/Fixture.mkv"/></Media></Video></MediaContainer>`), "123", "movie")
	if original == nil {
		t.Fatal("source fixture rejected")
	}
	for _, media := range []plex.DisplayMedia{{ID: "other", Parts: []plex.DisplayPart{{ID: "8"}}}, {ID: "7", Parts: []plex.DisplayPart{{ID: "other"}}}} {
		display := &activityDisplay{}
		plex.ApplySourceDisplay(display, plex.DisplayRow{Media: []plex.DisplayMedia{media}}, *original)
		if display.MediaPath != "" {
			t.Fatal("wrong source version path exposed")
		}
	}
}

func TestPlexMediaDetailsCurrentAdminOnly(t *testing.T) {
	f := activityReadFixture(t)
	activityExec(t, f.store, `UPDATE media_activity_current SET display_json='{"media_path":"/media/private-fixture.mkv","media_video_codec":"hevc"}'`)
	admin := apiRequest(f.app, "GET", "/api/activity/current?scope=all", f.ownerToken, nil, nil)
	if admin.Code != 200 || !strings.Contains(admin.Body.String(), "private-fixture.mkv") {
		t.Fatal("admin details unavailable", admin.Code)
	}
	activityExec(t, f.store, "DELETE FROM admin_privileges WHERE user_uuid=?", f.user)
	for _, query := range []struct{ path, token string }{{"/api/activity/current", f.token}, {"/api/activity/history", f.token}, {"/api/activity/history?scope=all", f.ownerToken}} {
		response := apiRequest(f.app, "GET", query.path, query.token, nil, nil)
		if response.Code != 200 || strings.Contains(response.Body.String(), "private-fixture.mkv") || strings.Contains(response.Body.String(), "media_video_codec") {
			t.Fatal("current details exposed outside administrator current scope", response.Code, query.path)
		}
	}
}

func TestPlexMediaDetailsUnknownAndUntrustedPath(t *testing.T) {
	for _, file := range []string{"https://example.invalid/file?token=secret", "/media/test&#10;secret.mkv"} {
		displays, err := plex.ParseDisplays([]byte(`<MediaContainer><Video><Media><Part file="` + file + `"/></Media></Video></MediaContainer>`))
		if err != nil {
			t.Fatal(err)
		}
		raw, _ := json.Marshal(displays[0])
		var got map[string]any
		json.Unmarshal(raw, &got)
		if _, ok := got["media_path"]; ok {
			t.Fatal("unsafe path admitted")
		}
		if _, ok := got["media_has_voice_activity"]; ok {
			t.Fatal("unknown voice activity invented")
		}
	}
}
