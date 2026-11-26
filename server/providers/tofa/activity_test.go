package tofa

import (
	"app/server/providers/provider"
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestActivitySnapshotUsesTofaSessions(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer fixture" {
			w.WriteHeader(401)
			return
		}
		switch r.URL.Path {
		case "/api/v1/system/playback/sessions":
			fmt.Fprint(w, `[{"session_id":"01234567-89ab-4cde-8fab-0123456789ab","user_id":"11234567-89ab-4cde-8fab-0123456789ab","media_id":"21234567-89ab-4cde-8fab-0123456789ab","media_file_id":"31234567-89ab-4cde-8fab-0123456789ab","media_title":"Movie","username":"Viewer","profile_name":"Household member","play_method":"Transcode","position_ms":3000,"duration_ms":9000,"is_paused":false,"video_codec":"hevc","output_video_codec":"h264","source_resolution":"3840x2160","resolution":"1920x1080","observed_bitrate_kbps":5000,"client_ip":"127.0.0.1"}]`)
		case "/api/v1/media/21234567-89ab-4cde-8fab-0123456789ab":
			fmt.Fprint(w, `{"id":"21234567-89ab-4cde-8fab-0123456789ab","media_type":"movie","title":"Movie","poster_path":"present","files":[{"id":"31234567-89ab-4cde-8fab-0123456789ab","container":"mkv"}]}`)
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	s := New(provider.Config{URL: server.URL, APIKey: "fixture", Transport: provider.Transport{Client: server.Client()}})
	v, err := s.ActivitySnapshot(context.Background())
	if err != nil || len(v.Sessions) != 1 {
		t.Fatal(v, err)
	}
	p := v.Sessions[0]
	if p.Kind != "Movie" || p.PlayMethod != "transcode" || p.Position == nil || *p.Position != 30000000 || p.Display == nil || p.Display.PosterPath != "poster" {
		t.Fatal(p)
	}
	if p.Display.Container != "Converting (MKV → HLS)" || p.Display.Video != "HEVC 4K → H264 1080p" || p.Display.Bandwidth != "5.0 Mbps" || p.Display.LocationType != "LAN" || p.Display.ProfileName != "Household member" || p.Display.SourceResolution != "4K" || p.Display.StreamResolution != "1080p" {
		t.Fatal("incorrect stream details", p.Display)
	}
}

func TestUserAvatarUsesOnlyMatchingPrimaryProfile(t *testing.T) {
	user := "11234567-89ab-4cde-8fab-0123456789ab"
	body := `[{"user_id":"` + user + `","is_primary":true,"avatar_ref":"preset:blue"}]`
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/v1/users/" + user + "/profiles":
			fmt.Fprint(w, body)
		case "/api/v1/profiles/avatars/blue.png":
			w.Header().Set("Content-Type", "image/png")
			fmt.Fprint(w, "image")
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()
	s := New(provider.Config{URL: srv.URL, APIKey: "key", Transport: provider.Transport{Client: srv.Client()}})
	_, image, err := s.UserAvatarImage(context.Background(), user)
	if err != nil || string(image) != "image" {
		t.Fatal(err)
	}
	body = `[{"user_id":"21234567-89ab-4cde-8fab-0123456789ab","is_primary":true,"avatar_ref":"preset:blue"}]`
	if _, _, err = s.UserAvatarImage(context.Background(), user); err == nil {
		t.Fatal("accepted a different user's profile")
	}
}

func TestActivitySnapshotRejectsInvalidOrPartialReplies(t *testing.T) {
	body := `null`
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { fmt.Fprint(w, body) }))
	defer upstream.Close()
	s := New(provider.Config{URL: upstream.URL, Transport: provider.Transport{Client: upstream.Client()}})
	for _, input := range []string{`null`, `{}`, `[{"session_id":"x"}]`, `[{"session_id":"01234567-89ab-4cde-8fab-0123456789ab","session_id":"01234567-89ab-4cde-8fab-0123456789ab"}]`} {
		body = input
		if v, err := s.ActivitySnapshot(context.Background()); err == nil {
			t.Fatal("accepted invalid snapshot", v)
		}
	}
	body = `[]`
	v, err := s.ActivitySnapshot(context.Background())
	if err != nil || v.Sessions == nil || len(v.Sessions) != 0 {
		t.Fatal(v, err)
	}
}

func TestActivitySnapshotResolvesEpisodeFromFile(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/v1/system/playback/sessions":
			fmt.Fprint(w, `[{"session_id":"01234567-89ab-4cde-8fab-0123456789ab","user_id":"11234567-89ab-4cde-8fab-0123456789ab","media_id":"21234567-89ab-4cde-8fab-0123456789ab","media_file_id":"31234567-89ab-4cde-8fab-0123456789ab","media_title":"Series","play_method":"DirectPlay","position_ms":1000,"duration_ms":2000,"is_paused":false}]`)
		case "/api/v1/media/21234567-89ab-4cde-8fab-0123456789ab":
			fmt.Fprint(w, `{"id":"21234567-89ab-4cde-8fab-0123456789ab","media_type":"tv","title":"Series","seasons":[{"season_number":1,"episodes":[{"id":"41234567-89ab-4cde-8fab-0123456789ab","title":"Pilot","files":[{"id":"31234567-89ab-4cde-8fab-0123456789ab","container":"mkv"}]}]}]}`)
		default:
			http.NotFound(w, r)
		}
	}))
	defer upstream.Close()
	s := New(provider.Config{URL: upstream.URL, Transport: provider.Transport{Client: upstream.Client()}})
	v, err := s.ActivitySnapshot(context.Background())
	if err != nil || len(v.Sessions) != 1 {
		t.Fatal(v, err)
	}
	p := v.Sessions[0]
	if p.Kind != "Episode" || p.Title != "Pilot" || p.ParentTitle != "Series" || p.Parent != "21234567-89ab-4cde-8fab-0123456789ab" || p.Item != "41234567-89ab-4cde-8fab-0123456789ab" || p.Display.Container != "MKV" {
		t.Fatal(p)
	}
}

func TestActivitySnapshotAllowsSessionWithoutMediaID(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/v1/system/playback/sessions":
			fmt.Fprint(w, `[{"session_id":"01234567-89ab-4cde-8fab-0123456789ab","user_id":"11234567-89ab-4cde-8fab-0123456789ab","media_id":null,"media_file_id":"31234567-89ab-4cde-8fab-0123456789ab","media_title":null,"play_method":"DirectPlay","is_paused":false},{"session_id":"51234567-89ab-4cde-8fab-0123456789ab","user_id":"11234567-89ab-4cde-8fab-0123456789ab","media_id":"21234567-89ab-4cde-8fab-0123456789ab","media_file_id":"61234567-89ab-4cde-8fab-0123456789ab","media_title":"Movie","play_method":"DirectPlay","is_paused":false}]`)
		case "/api/v1/media/21234567-89ab-4cde-8fab-0123456789ab":
			fmt.Fprint(w, `{"id":"21234567-89ab-4cde-8fab-0123456789ab","media_type":"movie","title":"Movie"}`)
		default:
			http.NotFound(w, r)
		}
	}))
	defer upstream.Close()
	s := New(provider.Config{URL: upstream.URL, Transport: provider.Transport{Client: upstream.Client()}})
	v, err := s.ActivitySnapshot(context.Background())
	if err != nil || len(v.Sessions) != 2 {
		t.Fatal(v, err)
	}
	if v.Sessions[0].Item != "31234567-89ab-4cde-8fab-0123456789ab" || v.Sessions[0].Kind != "Video" || v.Sessions[0].Title != "Unknown title" || v.Sessions[0].Display.PosterPath != "" {
		t.Fatal(v.Sessions[0])
	}
}

func TestActivityDiagnosticsAllowlistExcludesSecrets(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/v1/system/playback/sessions":
			fmt.Fprint(w, `[{"session_id":"01234567-89ab-4cde-8fab-0123456789ab","user_id":"11234567-89ab-4cde-8fab-0123456789ab","media_id":"21234567-89ab-4cde-8fab-0123456789ab","media_file_id":"31234567-89ab-4cde-8fab-0123456789ab","media_title":"Movie","play_method":"Transcode","position_ms":1234,"is_paused":false,"video_codec":"hevc","output_video_codec":"h264","api_key":"secret-value","stream_dir":"secret-path"}]`)
		case "/api/v1/media/21234567-89ab-4cde-8fab-0123456789ab":
			fmt.Fprint(w, `{"id":"21234567-89ab-4cde-8fab-0123456789ab","media_type":"movie","title":"Movie"}`)
		default:
			http.NotFound(w, r)
		}
	}))
	defer upstream.Close()
	s := New(provider.Config{URL: upstream.URL, Transport: provider.Transport{Client: upstream.Client()}})
	v, err := s.ActivitySnapshot(context.Background())
	if err != nil || len(v.Sessions) != 1 {
		t.Fatal(v, err)
	}
	raw := v.Sessions[0].Display.RawDataJSON
	if !strings.Contains(raw, `"video_codec":"hevc"`) || !strings.Contains(raw, `"position_ms":1234`) || strings.Contains(raw, "secret") {
		t.Fatal("unsafe or missing diagnostics", raw)
	}
}

func TestActivityProfileAvatarRequiresMatchingUserAndProfile(t *testing.T) {
	mode := "match"
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/v1/system/playback/sessions":
			fmt.Fprint(w, `[{"session_id":"01234567-89ab-4cde-8fab-0123456789ab","user_id":"11234567-89ab-4cde-8fab-0123456789ab","profile_id":"41234567-89ab-4cde-8fab-0123456789ab","profile_name":"Profile","media_id":"21234567-89ab-4cde-8fab-0123456789ab","media_file_id":"31234567-89ab-4cde-8fab-0123456789ab","media_title":"Movie","play_method":"DirectPlay","is_paused":false}]`)
		case "/api/v1/media/21234567-89ab-4cde-8fab-0123456789ab":
			fmt.Fprint(w, `{"id":"21234567-89ab-4cde-8fab-0123456789ab","media_type":"movie","title":"Movie"}`)
		case "/api/v1/users/11234567-89ab-4cde-8fab-0123456789ab/profiles":
			u := "11234567-89ab-4cde-8fab-0123456789ab"
			if mode == "wrong_user" {
				u = "51234567-89ab-4cde-8fab-0123456789ab"
			}
			ref := "preset:blue"
			if mode == "unsafe" {
				ref = "preset:../secret"
			}
			fmt.Fprintf(w, `[{"id":"41234567-89ab-4cde-8fab-0123456789ab","user_id":%q,"avatar_ref":%q}]`, u, ref)
		case "/api/v1/profiles/avatars/blue.png":
			w.Header().Set("Content-Type", "image/png")
			fmt.Fprint(w, "fixture")
		default:
			http.NotFound(w, r)
		}
	}))
	defer upstream.Close()
	s := New(provider.Config{URL: upstream.URL, Transport: provider.Transport{Client: upstream.Client()}})
	v, err := s.ActivitySnapshot(context.Background())
	if err != nil || v.Sessions[0].Display.AvatarPath != "preset:blue" {
		t.Fatal(v, err)
	}
	kind, image, err := s.ActivityAvatarImage(context.Background(), "preset:blue")
	if err != nil || kind != "image/png" || string(image) != "fixture" {
		t.Fatal(kind, err)
	}
	for _, mode = range []string{"wrong_user", "unsafe"} {
		v, err = s.ActivitySnapshot(context.Background())
		if err != nil || v.Sessions[0].Display.AvatarPath != "" {
			t.Fatal(mode, v, err)
		}
	}
	if _, _, err = s.ActivityAvatarImage(context.Background(), "preset:../secret"); err == nil {
		t.Fatal("accepted unsafe avatar")
	}
}

func TestActivityAvatarRejectsRedirectWithoutLeakingCredentials(t *testing.T) {
	leaked := false
	other := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { leaked = true }))
	defer other.Close()
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, other.URL, http.StatusFound) }))
	defer upstream.Close()
	s := New(provider.Config{URL: upstream.URL, APIKey: "secret", Transport: provider.Transport{Client: upstream.Client()}})
	if _, _, err := s.ActivityAvatarImage(context.Background(), "preset:blue"); err == nil || leaked {
		t.Fatal("followed an unsafe redirect")
	}
}
