package main

import (
	"app/server/providers/plex"
	"encoding/json"
	"encoding/xml"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

const plexOriginalSource = `<MediaContainer size="1"><Video ratingKey="123" type="movie"><Media id="6" container="avi" videoCodec="mpeg4" videoResolution="480"/><Media id="7" container="mkv" videoCodec="hevc" videoResolution="1080" height="804" bitrate="6900"><Part id="8" container="mkv"><Stream id="10" streamType="1" codec="hevc" height="804"/><Stream id="9" streamType="2" codec="eac3" displayTitle="English (EAC3 5.1)" selected="1"/></Part></Media></Video></MediaContainer>`

const plexSingleOriginalSource = `<MediaContainer size="1"><Video ratingKey="123" type="movie"><Media container="mkv" videoCodec="hevc" videoResolution="1080" height="804" bitrate="6900"><Part><Stream streamType="1" codec="hevc" height="804"/><Stream streamType="2" codec="eac3" displayTitle="English (EAC3 5.1)"/></Part></Media></Video></MediaContainer>`

func plexOutputPlaying() string {
	body := strings.Replace(plexRichPlaying, `<Media selected="1" container="mkv"`, `<Media id="7" selected="1" container="mpegts"`, 1)
	body = strings.Replace(body, `videoResolution="1080" height="1080"`, `height="804"`, 1)
	body = strings.Replace(body, `<Part selected="1">`, `<Part id="8" selected="1">`, 1)
	body = strings.Replace(body, `<Stream streamType="2"`, `<Stream id="9" streamType="2"`, 1)
	return body
}

func TestPlexSourceLookupFailureAndDeduplicationPreserveSessions(t *testing.T) {
	for _, fail := range []bool{false, true} {
		var metadataReads atomic.Int64
		movie := strings.TrimSuffix(strings.TrimPrefix(plexOutputPlaying(), `<MediaContainer size="1">`), `</MediaContainer>`)
		body := `<MediaContainer size="2">` + movie + strings.Replace(movie, `sessionKey="10"`, `sessionKey="11"`, 1) + `</MediaContainer>`
		upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path == "/status/sessions" {
				fmt.Fprint(w, body)
				return
			}
			metadataReads.Add(1)
			if fail {
				w.WriteHeader(503)
			} else {
				fmt.Fprint(w, plexOriginalSource)
			}
		}))
		p, _ := newServerConnection(ProviderConfig{"plex", upstream.URL, "fixture-secret"}, nil)
		s, err := p.readActivitySnapshot(t.Context())
		upstream.Close()
		if err != nil || len(s.Sessions) != 2 || metadataReads.Load() != 1 {
			t.Fatal("optional metadata changed session membership or was not deduplicated", err, metadataReads.Load())
		}
	}
}

func TestPlexSourceLookupCapAndIdentityChecks(t *testing.T) {
	if plex.DecodeSourceDisplay([]byte(strings.Replace(plexOriginalSource, `ratingKey="123"`, `ratingKey="999"`, 1)), "123", "movie") != nil {
		t.Fatal("wrong source identity accepted")
	}
	var requests atomic.Int64
	movie := strings.TrimSuffix(strings.TrimPrefix(plexOutputPlaying(), `<MediaContainer size="1">`), `</MediaContainer>`)
	var body strings.Builder
	body.WriteString(`<MediaContainer size="40">`)
	for i := 1; i <= 40; i++ {
		row := strings.Replace(movie, `sessionKey="10"`, `sessionKey="`+strconv.Itoa(i)+`"`, 1)
		row = strings.Replace(row, `ratingKey="123"`, `ratingKey="`+strconv.Itoa(i)+`"`, 1)
		body.WriteString(row)
	}
	body.WriteString(`</MediaContainer>`)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/status/sessions" {
			fmt.Fprint(w, body.String())
			return
		}
		requests.Add(1)
		w.WriteHeader(404)
	}))
	defer upstream.Close()
	p, _ := newServerConnection(ProviderConfig{"plex", upstream.URL, "fixture-secret"}, nil)
	s, err := p.readActivitySnapshot(t.Context())
	if err != nil || len(s.Sessions) != 40 || requests.Load() != 32 {
		t.Fatal("source lookup budget not bounded", err, requests.Load())
	}
}

func TestPlexActivityAvatarProxyRechecksAuthorizationAndRedactsSecrets(t *testing.T) {
	for _, tc := range []struct {
		name, sql string
		status    int
	}{
		{"unchanged", "", 200},
		{"logout", "DELETE FROM app_sessions", 403},
		{"source_disabled", "UPDATE media_servers SET is_active=0", 404},
		{"avatar_replaced", `UPDATE media_activity_current SET display_json=json_set(display_json,'$.avatar_path','https://plex.tv/users/replaced/avatar')`, 409},
	} {
		t.Run(tc.name, func(t *testing.T) {
			a, s := testApp(t)
			token, _ := bootstrapOwner(t, a)
			body := strings.Replace(plexPlaying, `<User id="42" title="Viewer"/>`, `<User id="42" title="Viewer" thumb="https://plex.tv/users/fixture-user/avatar?c=123&amp;X-Plex-Token=never-store"/>`, 1)
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path != "/status/sessions" {
					t.Error("unexpected request", r.URL.Path)
				}
				fmt.Fprint(w, body)
			}))
			defer upstream.Close()
			server := createManagedServer(t, a, token, "plex", upstream.URL)
			activityExec(t, s, "UPDATE activity_monitor_schedules SET next_run_at='2000-01-01T00:00:00Z' WHERE server_id=?", server)
			if err := a.runOneActivityMonitor(t.Context()); err != nil {
				t.Fatal(err)
			}
			response := apiRequest(a, "GET", "/api/activity/current?scope=all", token, nil, nil)
			var result struct{ Data activityReadResponse }
			if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil || response.Code != 200 || len(result.Data.Items) != 1 {
				t.Fatal(response.Body.String(), err)
			}
			d := result.Data.Items[0].Display
			if d == nil || !strings.HasPrefix(d.Avatar, "/api/activity/avatars/") || d.AvatarPath != "" || strings.Contains(response.Body.String(), "plex.tv") {
				t.Fatal("unsafe/missing public avatar descriptor", response.Body.String())
			}
			var stored string
			if err := s.reader.QueryRow("SELECT display_json FROM media_activity_current").Scan(&stored); err != nil || strings.Contains(stored, "never-store") {
				t.Fatal("avatar credential persisted", err)
			}
			a.ProviderHTTP = &http.Client{Transport: providerTransport(func(r *http.Request) (*http.Response, error) {
				if r.URL.Host != "plex.tv" || r.Header.Get("X-Plex-Token") != "" || r.Header.Get("Authorization") != "" || r.Header.Get("Cookie") != "" || r.URL.Query().Get("X-Plex-Token") != "" {
					t.Fatal("avatar sent credentials or contacted untrusted host")
				}
				if tc.sql != "" {
					activityExec(t, s, tc.sql)
				}
				return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": {"image/png"}}, Body: io.NopCloser(strings.NewReader("PNG avatar")), Request: r}, nil
			})}
			image := apiRequest(a, "GET", d.Avatar, "", nil, nil)
			if image.Code != tc.status || image.Header().Get("Cache-Control") != "private, no-store" {
				t.Fatal(image.Code, image.Body.String())
			}
			if tc.status != 200 && strings.Contains(image.Body.String(), "PNG avatar") {
				t.Fatal("avatar delivered after revocation")
			}
		})
	}
}

func TestPlexCloudAvatarRejectsRedirects(t *testing.T) {
	var calls int
	p, _ := newServerConnection(ProviderConfig{"plex", "http://127.0.0.1", "private-key"}, &http.Client{Transport: providerTransport(func(r *http.Request) (*http.Response, error) {
		calls++
		return &http.Response{StatusCode: 302, Header: http.Header{"Location": {"https://evil.test/avatar"}}, Body: io.NopCloser(strings.NewReader("")), Request: r}, nil
	})})
	if _, _, err := p.activityAvatar(t.Context(), "https://plex.tv/users/fixture-user/avatar"); err == nil || calls != 1 {
		t.Fatal("avatar redirect was followed", err, calls)
	}
}

func TestPlexSourceLookupDeadlineKeepsValidSessions(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/status/sessions" {
			fmt.Fprint(w, plexOutputPlaying())
			return
		}
		<-r.Context().Done()
	}))
	defer upstream.Close()
	p, _ := newServerConnection(ProviderConfig{"plex", upstream.URL, "fixture-secret"}, nil)
	started := time.Now()
	s, err := p.readActivitySnapshot(t.Context())
	if err != nil || len(s.Sessions) != 1 || time.Since(started) > 6*time.Second {
		t.Fatal("optional source deadline lost sessions or exceeded budget", err)
	}
}

func TestPlexSourceSelectionDoesNotGuessOrEraseKnownVideo(t *testing.T) {
	var live struct {
		Rows []plex.DisplayRow `xml:",any"`
	}
	if err := xml.Unmarshal([]byte(plexOutputPlaying()), &live); err != nil {
		t.Fatal(err)
	}
	source := plex.DecodeSourceDisplay([]byte(plexOriginalSource), "123", "movie")
	if source == nil {
		t.Fatal("source fixture invalid")
	}
	displays, err := plex.ParseDisplays([]byte(plexOutputPlaying()))
	if err != nil {
		t.Fatal(err)
	}
	d := *displays[0]
	before := d.Video
	beforeContainer := d.Container
	wrong := live.Rows[0]
	wrong.Media = append([]plex.DisplayMedia(nil), wrong.Media...)
	wrong.Media[0].ID = "999"
	plex.ApplySourceDisplay(&d, wrong, *source)
	if d.Video != before || d.Container != beforeContainer {
		t.Fatal("another version was guessed", d)
	}
	sparse := plex.DecodeSourceDisplay([]byte(`<MediaContainer size="1"><Video ratingKey="123" type="movie"><Media id="7"><Part id="8"/></Media></Video></MediaContainer>`), "123", "movie")
	plex.ApplySourceDisplay(&d, live.Rows[0], *sparse)
	if d.Video != before {
		t.Fatal("sparse metadata erased reported video", d)
	}
}

func TestPlexLocalAvatarUsesOnlyConfiguredProvider(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/proxy/accounts/42/thumb" || r.Header.Get("X-Plex-Token") != "fixture-secret" {
			t.Error("local avatar identity/credential mismatch")
		}
		w.Header().Set("Content-Type", "image/png")
		fmt.Fprint(w, "PNG avatar")
	}))
	defer upstream.Close()
	p, _ := newServerConnection(ProviderConfig{"plex", upstream.URL + "/proxy", "fixture-secret"}, nil)
	if _, _, err := p.activityAvatar(t.Context(), "/accounts/42/thumb"); err != nil {
		t.Fatal(err)
	}
}

func TestPlexSourceTranscodeUsesSourceAndOutputResolutions(t *testing.T) {
	body := plexOutputPlaying()
	body = strings.Replace(body, `videoDecision="copy"`, `videoDecision="transcode"`, 1)
	body = strings.Replace(body, `height="804"`, `height="720"`, 1)
	body = strings.Replace(body, `<TranscodeSession videoDecision="transcode" audioDecision="transcode" videoCodec="hevc"`, `<TranscodeSession transcodeHwDecoding="1" transcodeHwEncoding="1" videoDecision="transcode" audioDecision="transcode" videoCodec="h264"`, 1)
	var live struct {
		Rows []plex.DisplayRow `xml:",any"`
	}
	if err := xml.Unmarshal([]byte(body), &live); err != nil {
		t.Fatal(err)
	}
	displays, err := plex.ParseDisplays([]byte(body))
	if err != nil {
		t.Fatal(err)
	}
	source := plex.DecodeSourceDisplay([]byte(plexOriginalSource), "123", "movie")
	plex.ApplySourceDisplay(displays[0], live.Rows[0], *source)
	if displays[0].Video != "Transcode (HEVC (HW) 1080p → H264 (HW) 720p)" {
		t.Fatal("source/output resolutions mixed", displays[0].Video)
	}
}

func TestPlexSourceMetadataSeparatesSourceFromPlaybackOutput(t *testing.T) {
	var metadataReads atomic.Int64
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-Plex-Token") != "fixture-secret" {
			t.Error("missing header credential")
		}
		switch r.URL.Path {
		case "/status/sessions":
			fmt.Fprint(w, plexOutputPlaying())
		case "/library/metadata/123":
			metadataReads.Add(1)
			fmt.Fprint(w, plexOriginalSource)
		default:
			t.Error("unexpected provider request", r.URL.Path)
			w.WriteHeader(404)
		}
	}))
	defer upstream.Close()
	provider, err := newServerConnection(ProviderConfig{"plex", upstream.URL, "fixture-secret"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	s, err := provider.readActivitySnapshot(t.Context())
	if err != nil || len(s.Sessions) != 1 {
		t.Fatal(err)
	}
	d := s.Sessions[0].Display
	if metadataReads.Load() != 1 || d.Container != "Converting (MKV → MPEGTS)" || d.Video != "Direct Stream (HEVC 1080p)" || d.Audio != "Transcode (English (EAC3 5.1) → MP3 Stereo)" {
		t.Fatalf("source details mixed with output: %+v; metadata reads %d", d, metadataReads.Load())
	}
}

func TestPlexAvatarPathsRemoveSecretsAndRejectUntrustedOrigins(t *testing.T) {
	got := plex.ActivityAvatar("https://plex.tv/users/fixture-user/avatar?c=123&X-Plex-Token=secret")
	if got != "https://plex.tv/users/fixture-user/avatar?c=123" {
		t.Fatal("unsafe avatar canonicalization", got)
	}
	for _, bad := range []string{"https://evil.test/avatar", "https://plex.tv.evil.test/users/id/avatar", "https://user:secret@plex.tv/users/id/avatar", "https://plex.tv:123/users/id/avatar", "/library/metadata/1/thumb", "//evil.test/avatar"} {
		if plex.ActivityAvatar(bad) != "" {
			t.Fatal("untrusted avatar accepted", bad)
		}
	}
}
