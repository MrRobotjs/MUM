package tofa

import (
	"app/server/providers/provider"
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
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
			fmt.Fprint(w, `[{"session_id":"01234567-89ab-4cde-8fab-0123456789ab","user_id":"11234567-89ab-4cde-8fab-0123456789ab","media_id":"21234567-89ab-4cde-8fab-0123456789ab","media_file_id":"31234567-89ab-4cde-8fab-0123456789ab","media_title":"Movie","username":"Viewer","play_method":"Transcode","position_ms":3000,"duration_ms":9000,"is_paused":false,"video_codec":"hevc","output_video_codec":"h264","observed_bitrate_kbps":5000,"client_ip":"127.0.0.1"}]`)
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
	if p.Display.Container != "Source: MKV" || p.Display.Video != "HEVC → H264" || p.Display.Bandwidth != "5.0 Mbps" || p.Display.LocationType != "LAN" {
		t.Fatal("incorrect stream details", p.Display)
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
