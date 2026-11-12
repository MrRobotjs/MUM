package main

import (
	"app/server/providers/plex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

const plexRichPlaying = `<MediaContainer size="1"><Video sessionKey="10" ratingKey="123" type="movie" title="Fixture movie" year="2026" editionTitle="Web-DL" librarySectionTitle="Movies" thumb="/library/metadata/123/thumb/7" duration="10000" viewOffset="2000"><User id="42" title="Viewer"/><Player state="playing" product="Plex Web" title="Chrome" platform="Chrome" address="127.0.0.1" local="1"/><Session bandwidth="12400" location="lan"/><Media selected="1" container="mkv" bitrate="6900" videoCodec="hevc" videoResolution="1080" height="1080" audioCodec="eac3" audioChannels="6"><Part selected="1"><Stream streamType="1" codec="hevc" height="1080"/><Stream streamType="2" codec="eac3" displayTitle="English (EAC3 5.1)" selected="1"/></Part></Media><TranscodeSession videoDecision="copy" audioDecision="transcode" videoCodec="hevc" audioCodec="mp3" audioChannels="2" container="mpegts" throttled="1" speed="2.5"/></Video></MediaContainer>`

func TestPlexDisplayUsesReportedTranscodeAndBandwidth(t *testing.T) {
	s, err := plex.ParseActivity([]byte(plexRichPlaying))
	if err != nil || len(s.Sessions) != 1 {
		t.Fatal(err)
	}
	d := s.Sessions[0].Display
	if d == nil || d.IsTranscode == nil || !*d.IsTranscode || d.Bitrate == nil || *d.Bitrate != 12400000 || d.Container != "Converting (MKV → MPEGTS)" || d.Quality != "Original (6.9 Mbps)" || d.Video != "Direct Stream (HEVC 1080p)" || !strings.Contains(d.Audio, "MP3") || d.PlayerPlatform != "Chrome" || d.PosterPath == "" {
		t.Fatalf("incorrect rich session: %+v", d)
	}
	// Paths, tokens, upstream JSON and media file names are not presentation data.
	unsafe, err := plex.ParseActivity([]byte(strings.Replace(plexRichPlaying, `/library/metadata/123/thumb/7`, `https://untrusted.test/?token=secret`, 1)))
	if err != nil || len(unsafe.Sessions) != 1 || unsafe.Sessions[0].Display.PosterPath != "" {
		t.Fatal("unusable artwork must be omitted without hiding valid playback", err)
	}
}

func TestPlexAlbumArtworkDoesNotHideConcurrentMovie(t *testing.T) {
	movie := strings.TrimSuffix(strings.TrimPrefix(plexRichPlaying, `<MediaContainer size="1">`), `</MediaContainer>`)
	track := `<Track sessionKey="11" ratingKey="782" parentRatingKey="781" parentTitle="Album" type="track" title="Song" thumb="/library/metadata/781/thumb/1396406871"><User id="43" title="Listener"/><Player state="playing"/></Track>`
	s, err := plex.ParseActivity([]byte(`<MediaContainer size="2">` + movie + track + `</MediaContainer>`))
	if err != nil || len(s.Sessions) != 2 || s.Sessions[1].Display.PosterItem != "781" || s.Sessions[1].Display.PosterPath != "/library/metadata/781/thumb/1396406871" {
		t.Fatal("album artwork suppressed concurrent playback", s, err)
	}
}

func TestPlexActivityPostersRecheckAuthorizationAndCurrentSource(t *testing.T) {
	for _, tc := range []struct {
		name, sql string
		status    int
	}{
		{"unchanged", "", 200},
		{"logout", "DELETE FROM app_sessions", 403},
		{"source_disabled", "UPDATE media_servers SET is_active=0", 404},
		{"session_ended", "DELETE FROM media_activity_current", 404},
		{"poster_replaced", `UPDATE media_activity_current SET display_json=json_set(display_json,'$.poster_path','/library/metadata/123/thumb/8')`, 409},
	} {
		t.Run(tc.name, func(t *testing.T) {
			a, s := testApp(t)
			token, _ := bootstrapOwner(t, a)
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Header.Get("X-Plex-Token") != "fixture-secret" {
					t.Error("missing private header")
				}
				switch r.URL.Path {
				case "/library/metadata/123":
					fmt.Fprint(w, plexSingleOriginalSource)
				case "/status/sessions":
					fmt.Fprint(w, plexRichPlaying)
				case "/library/metadata/123/thumb/7":
					w.Header().Set("Content-Type", "image/png")
					fmt.Fprint(w, "PNG fixture")
				default:
					t.Error("unexpected upstream path", r.URL.Path)
					w.WriteHeader(404)
				}
			}))
			defer upstream.Close()
			server := createManagedServer(t, a, token, "plex", upstream.URL)
			activityExec(t, s, "UPDATE activity_monitor_schedules SET next_run_at='2000-01-01T00:00:00Z' WHERE server_id=?", server)
			if err := a.runOneActivityMonitor(t.Context()); err != nil {
				t.Fatal(err)
			}
			w := apiRequest(a, "GET", "/api/activity/current?scope=all", token, nil, nil)
			var view struct{ Data activityReadResponse }
			if err := json.Unmarshal(w.Body.Bytes(), &view); err != nil || w.Code != 200 || len(view.Data.Items) != 1 {
				t.Fatal(w.Body.String(), err)
			}
			d := view.Data.Items[0].Display
			if d == nil || d.Thumb == "" || d.PosterPath != "" || d.IP != "127.0.0.1" {
				t.Fatalf("display missing or internal path leaked: %+v", d)
			}
			if strings.Contains(w.Body.String(), "fixture-secret") {
				t.Fatal("provider secret leaked")
			}
			a.ProviderHTTP = &http.Client{Transport: providerTransport(func(r *http.Request) (*http.Response, error) {
				response, err := http.DefaultTransport.RoundTrip(r)
				if err == nil && tc.sql != "" {
					activityExec(t, s, tc.sql)
				}
				return response, err
			})}
			image := apiRequest(a, "GET", d.Thumb, "", nil, nil)
			if image.Code != tc.status || image.Header().Get("Cache-Control") != "private, no-store" {
				t.Fatal(image.Code, image.Body.String())
			}
			if tc.status != 200 && strings.Contains(image.Body.String(), "PNG fixture") {
				t.Fatal("image delivered after revocation")
			}
		})
	}
}

func TestActivityDisplayPrivateToAdministrativeCurrentView(t *testing.T) {
	f := activityReadFixture(t)
	activityExec(t, f.store, `UPDATE media_activity_current SET display_json='{"location_ip":"192.0.2.1","player_title":"Private player"}'`)
	for _, query := range []struct {
		path, token string
		private     bool
	}{
		{"/api/activity/current", f.token, false},
		{"/api/activity/history?scope=all", f.ownerToken, false},
		{"/api/activity/current?scope=all", f.ownerToken, true},
	} {
		w := apiRequest(f.app, "GET", query.path, query.token, nil, nil)
		if w.Code != 200 {
			t.Fatal(w.Code, w.Body.String())
		}
		if strings.Contains(w.Body.String(), "Private player") != query.private || strings.Contains(w.Body.String(), "192.0.2.1") != query.private {
			t.Fatal("private stream details crossed scope", w.Body.String())
		}
	}
}
