package main

import (
	"app/server/providers/plex"
	"encoding/json"
	"strings"
	"testing"
)

func TestPlexRawPayloadCapturesOnlyThisSessionTechnicalXML(t *testing.T) {
	first := strings.TrimSuffix(strings.TrimPrefix(plexRichPlaying, `<MediaContainer size="1">`), `</MediaContainer>`)
	first = strings.Replace(first, `<Player `, `<Unknown secret="unknown-secret">hidden-text<Media container="nested-secret"/></Unknown><Player token="token-secret" url="https://private/?key=url-secret" `, 1)
	first = strings.Replace(first, `<Stream streamType="1" codec="hevc"`, `<Stream profile="https://private/?key=known-field-secret" streamType="1" codec="hevc"`, 1)
	second := `<Track sessionKey="11" ratingKey="124" type="track" title="Other viewer"><User id="99" title="other-user-secret"/><Player state="paused"/><Media bitrate="123"/></Track>`
	snap, err := plex.ParseActivity([]byte(`<MediaContainer size="2">` + first + second + `</MediaContainer>`))
	if err != nil || len(snap.Sessions) != 2 {
		t.Fatal(err)
	}
	encoded, _ := json.Marshal(snap.Sessions[0].Display)
	var display map[string]any
	json.Unmarshal(encoded, &display)
	raw, _ := display["raw_data_json"].(string)
	if !json.Valid([]byte(raw)) || !strings.Contains(raw, `"audioDecision":"transcode"`) || !strings.Contains(raw, `"bandwidth":"12400"`) {
		t.Fatalf("missing actual provider diagnostics: %s", raw)
	}
	for _, secret := range []string{"unknown-secret", "nested-secret", "hidden-text", "token-secret", "url-secret", "known-field-secret", "other-user-secret", "User", "https://"} {
		if strings.Contains(raw, secret) {
			t.Fatalf("leaked %q: %s", secret, raw)
		}
	}
	secondJSON, _ := json.Marshal(snap.Sessions[1].Display)
	if strings.Contains(string(secondJSON), "12400") {
		t.Fatal("another session leaked")
	}
}

func TestPlexRawPayloadBudgetDoesNotRejectPlayback(t *testing.T) {
	extra := strings.Repeat(`<Stream streamType="1" codec="hevc" width="1920" height="1080"/>`, 600)
	body := strings.Replace(plexRichPlaying, `</Part>`, extra+`</Part>`, 1)
	snap, err := plex.ParseActivity([]byte(body))
	if err != nil || len(snap.Sessions) != 1 {
		t.Fatal("diagnostic overflow rejected playback", err)
	}
	encoded, _ := json.Marshal(snap.Sessions[0].Display)
	if strings.Contains(string(encoded), "raw_data_json") {
		t.Fatal("oversized diagnostic should be omitted")
	}
}

func TestPlexRawPayloadExcludedFromOwnAndHistory(t *testing.T) {
	f := activityReadFixture(t)
	activityExec(t, f.store, `UPDATE media_activity_current SET display_json='{"raw_data_json":"{\"element\":\"Video\"}"}'`)
	for _, tc := range []struct {
		path, token string
		want        bool
	}{
		{"/api/activity/current", f.token, false}, {"/api/activity/current?scope=all", f.ownerToken, true}, {"/api/activity/history?scope=all", f.ownerToken, false},
	} {
		w := apiRequest(f.app, "GET", tc.path, tc.token, nil, nil)
		if w.Code != 200 || strings.Contains(w.Body.String(), "raw_data_json") != tc.want {
			t.Fatalf("%s: %d %s", tc.path, w.Code, w.Body.String())
		}
	}
}

func TestPlexRawPayloadAggregateOverflowPreservesPlaybackAndCaller(t *testing.T) {
	_, s, token, _, _ := roleReadFixture(t)
	actor, _ := s.Authenticate(t.Context(), token)
	server := seedServer(t, s)
	service := seedService(t, s, server)
	claim, err := s.beginActivityRead(t.Context(), actor.UUID, token, server)
	if err != nil {
		t.Fatal(err)
	}
	snapshot := activityForUser(t, service)
	var d *activityDisplay
	for count := 1; count <= 100; count++ {
		streams := strings.Repeat(`<Stream codec="`+strings.Repeat("h", 64)+`" profile="`+strings.Repeat("m", 64)+`"/>`, count)
		parsed, err := plex.ParseDisplays([]byte(`<MediaContainer><Video><Media><Part>` + streams + `</Part></Media></Video></MediaContainer>`))
		if err != nil {
			t.Fatal(err)
		}
		if parsed[0].RawDataJSON == "" {
			break
		}
		d = parsed[0]
	}
	if d == nil {
		t.Fatal("missing bounded provider diagnostics")
	}
	// Populate otherwise bounded display strings until diagnostics fit just under
	// the store cap, then simulate later source-path enrichment crossing it.
	fields := []*string{&d.Library, &d.Year, &d.Edition, &d.ParentTitle, &d.GrandparentTitle, &d.PlayerTitle, &d.PlayerPlatform, &d.Product, &d.Video, &d.Audio, &d.Subtitle, &d.Location, &d.Bandwidth, &d.Quality, &d.Container, &d.Stream, &d.MediaAspectRatio, &d.MediaAudioCodec, &d.MediaVideoCodec, &d.MediaVideoProfile, &d.MediaVideoFrameRate, &d.MediaContainer, &d.MediaVideoResolution, &d.IP, &d.LocationType, &d.AvatarPath, &d.PosterPath, &d.PosterItem}
	for _, field := range fields {
		*field = strings.Repeat("x", 256)
		current, _ := json.Marshal(d)
		if len(current) >= 15700 {
			break
		}
	}
	before, _ := json.Marshal(d)
	if len(before) > 16384 || len(before) < 15360 {
		t.Fatalf("bad boundary fixture: %d", len(before))
	}
	d.MediaPath = "/" + strings.Repeat("p", 1020)
	after, _ := json.Marshal(d)
	if len(after) <= 16384 {
		t.Fatalf("fixture did not overflow: %d", len(after))
	}
	snapshot.Sessions[0].Display = d
	if _, err := s.applyActivitySnapshot(t.Context(), claim, snapshot); err != nil {
		t.Fatal("optional diagnostic rejected playback", err)
	}
	if d.RawDataJSON == "" {
		t.Fatal("caller display mutated")
	}
	var stored string
	if err := s.reader.QueryRow("SELECT display_json FROM media_activity_current WHERE server_id=?", server).Scan(&stored); err != nil {
		t.Fatal(err)
	}
	if len(stored) > 16384 || strings.Contains(stored, "raw_data_json") || !strings.Contains(stored, "media_path") {
		t.Fatal("diagnostic fallback lost playback display")
	}
}
