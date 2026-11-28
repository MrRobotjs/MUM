package mediabrowser

import (
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"app/server/providers/provider"
)

// historyFixture serves one activity log page and one item lookup, and
// records every request.
func historyFixture(t *testing.T, prefix, log, items string) (*Server, *[]string) {
	t.Helper()
	var requests []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests = append(requests, r.Method+" "+r.URL.Path+" "+requestKey(r))
		switch r.URL.Path {
		case prefix + "/System/ActivityLog/Entries":
			if r.URL.Query().Get("StartIndex") != "0" || r.URL.Query().Get("Limit") != "50" {
				w.WriteHeader(http.StatusBadRequest)
				return
			}
			_, _ = w.Write([]byte(log))
		case prefix + "/Items":
			_, _ = w.Write([]byte(items))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(server.Close)
	return New(provider.Config{URL: server.URL, APIKey: "server-api-key", Transport: provider.Transport{Client: server.Client()}}, prefix == "/emby"), &requests
}

const jellyfinLog = `{"Items":[
 {"Id":1,"Name":"viewer has signed in","Type":"AuthenticationSucceeded","UserId":"ab12cd34ab12cd34ab12cd34ab12cd34","Date":"2026-11-10T19:00:00.0000000Z"},
 {"Id":2,"Name":"viewer is playing Film","Type":"VideoPlayback","ItemId":"m1","UserId":"ab12cd34ab12cd34ab12cd34ab12cd34","Date":"2026-11-10T19:01:00.0000000Z"},
 {"Id":3,"Name":"viewer has finished playing Film","Type":"VideoPlaybackStopped","ItemId":"m1","UserId":"ab12cd34ab12cd34ab12cd34ab12cd34","Date":"2026-11-10T21:00:00.0000000Z"},
 {"Id":4,"Name":"viewer has finished playing Pilot","Type":"VideoPlaybackStopped","ItemId":"e1","UserId":"AB12CD34-AB12-CD34-AB12-CD34AB12CD34","Date":"2026-11-10T22:00:00.5Z"},
 {"Id":5,"Name":"viewer has finished playing Song","Type":"AudioPlaybackStopped","ItemId":"t1","UserId":"ab12cd34ab12cd34ab12cd34ab12cd34","Date":"2026-11-10T23:00:00Z"},
 {"Id":6,"Name":"viewer has finished playing Gone","Type":"VideoPlaybackStopped","ItemId":"gone","UserId":"ab12cd34ab12cd34ab12cd34ab12cd34","Date":"2026-11-10T23:30:00Z"}
],"TotalRecordCount":40,"StartIndex":0}`

const jellyfinItems = `{"Items":[
 {"Id":"m1","Name":"Film","Type":"Movie","ImageTags":{"Primary":"tagm"}},
 {"Id":"e1","Name":"Pilot","Type":"Episode","SeriesName":"A Show","SeriesId":"s1","SeriesPrimaryImageTag":"tags","ImageTags":{"Primary":"tage"}},
 {"Id":"t1","Name":"Song","Type":"Audio","Album":"Album","AlbumId":"a1","AlbumPrimaryImageTag":"taga"}
],"TotalRecordCount":3}`

func TestPlayHistoryKeepsPlaybackStops(t *testing.T) {
	s, requests := historyFixture(t, "", jellyfinLog, jellyfinItems)
	page, err := s.PlayHistory(t.Context(), 0, 50)
	if err != nil {
		t.Fatal(err)
	}
	if page.Offset != 0 || page.Read != 6 || page.Total != 40 || len(page.Entries) != 4 {
		t.Fatalf("page %+v", page)
	}
	film, pilot, song, gone := page.Entries[0], page.Entries[1], page.Entries[2], page.Entries[3]
	if film.Key != "a3" || film.AccountID != "ab12cd34ab12cd34ab12cd34ab12cd34" || film.ItemID != "m1" || film.Type != "movie" || film.Title != "Film" ||
		film.PosterItem != "m1" || film.PosterPath != "tagm" || !film.ViewedAt.Equal(time.Date(2026, 11, 10, 21, 0, 0, 0, time.UTC)) {
		t.Fatalf("film %+v", film)
	}
	if pilot.Key != "a4" || pilot.AccountID != "AB12CD34-AB12-CD34-AB12-CD34AB12CD34" || pilot.Type != "episode" || pilot.GrandparentTitle != "A Show" || pilot.PosterItem != "s1" || pilot.PosterPath != "tags" {
		t.Fatalf("episode %+v", pilot)
	}
	if song.Type != "track" || song.ParentTitle != "Album" || song.PosterItem != "a1" || song.PosterPath != "taga" {
		t.Fatalf("track %+v", song)
	}
	if gone.Key != "a6" || gone.ItemID != "gone" || gone.Title != "" || gone.Type != "" || gone.PosterItem != "" || gone.PosterPath != "" {
		t.Fatalf("deleted item %+v", gone)
	}
	for _, request := range *requests {
		if !strings.HasPrefix(request, "GET ") || !strings.HasSuffix(request, " server-api-key") {
			t.Fatal("request", request)
		}
	}
}

func TestPlayHistoryEmbyPageWithoutPlays(t *testing.T) {
	log := `{"Items":[{"Id":10,"Name":"viewer signed in","Type":"user.authenticated","UserId":"u1","Date":"2026-11-10T19:00:00.0000000Z"},
	 {"Id":11,"Name":"viewer is playing Film","Type":"playback.start","ItemId":"m1","UserId":"u1","Date":"2026-11-10T19:01:00.0000000Z"}],"TotalRecordCount":90}`
	s, requests := historyFixture(t, "/emby", log, `{"Items":[]}`)
	page, err := s.PlayHistory(t.Context(), 0, 50)
	if err != nil || page.Read != 2 || len(page.Entries) != 0 || page.Total != 90 {
		t.Fatalf("page %+v %v", page, err)
	}
	if len(*requests) != 1 {
		t.Fatal("looked up items for a page without plays", *requests)
	}
	stop := `{"Items":[{"Id":12,"Name":"viewer has finished playing Film","Type":"playback.stop","ItemId":"m1","UserId":"u1","Date":"2026-11-10T21:00:00.0000000Z"}],"TotalRecordCount":1}`
	s, _ = historyFixture(t, "/emby", stop, `{"Items":[{"Id":"m1","Name":"Film","Type":"Movie"}]}`)
	if page, err := s.PlayHistory(t.Context(), 0, 50); err != nil || len(page.Entries) != 1 || page.Entries[0].Key != "a12" || page.Entries[0].Title != "Film" {
		t.Fatalf("emby stop %+v %v", page, err)
	}
}

func TestPlayHistoryRejectsBadReplies(t *testing.T) {
	for name, log := range map[string]string{
		"no items":     `{"TotalRecordCount":3}`,
		"no total":     `{"Items":[]}`,
		"bad date":     `{"Items":[{"Id":3,"Type":"VideoPlaybackStopped","ItemId":"m1","UserId":"u1","Date":"yesterday"}],"TotalRecordCount":1}`,
		"repeated id":  `{"Items":[{"Id":3,"Type":"VideoPlaybackStopped","ItemId":"m1","UserId":"u1","Date":"2026-11-10T21:00:00Z"},{"Id":3,"Type":"VideoPlaybackStopped","ItemId":"m1","UserId":"u1","Date":"2026-11-10T21:00:00Z"}],"TotalRecordCount":2}`,
		"not json":     `<html>`,
		"too many":     `{"Items":[` + strings.Repeat(`{"Id":1,"Type":"x","Date":"2026-11-10T21:00:00Z"},`, 50) + `{"Id":2,"Type":"x","Date":"2026-11-10T21:00:00Z"}],"TotalRecordCount":51}`,
		"negative":     `{"Items":[],"TotalRecordCount":-1}`,
		"bad item ref": `{"Items":[{"Id":3,"Type":"VideoPlaybackStopped","ItemId":"../x","UserId":"u1","Date":"2026-11-10T21:00:00Z"}],"TotalRecordCount":1}`,
	} {
		s, _ := historyFixture(t, "", log, `{"Items":[]}`)
		if _, err := s.PlayHistory(t.Context(), 0, 50); !errors.Is(err, ErrPlayHistory) {
			t.Error(name, err)
		}
	}
}

// A busy page is looked up in batches, so no request line grows past what
// Jellyfin, Emby or a proxy in front of them accepts.
func TestPlayHistoryLooksUpItemsInBatches(t *testing.T) {
	var entries, lookups []string
	for i := range 250 {
		entries = append(entries, fmt.Sprintf(`{"Id":%d,"Type":"AudioPlaybackStopped","ItemId":"%032x","UserId":"u1","Date":"2026-11-10T21:00:00Z"}`, i+1, i+1))
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if len(r.URL.RequestURI()) > 4096 {
			w.WriteHeader(http.StatusRequestURITooLong)
			return
		}
		switch r.URL.Path {
		case "/System/ActivityLog/Entries":
			_, _ = w.Write([]byte(`{"Items":[` + strings.Join(entries, ",") + `],"TotalRecordCount":250}`))
		case "/Items":
			ids := strings.Split(r.URL.Query().Get("Ids"), ",")
			lookups = append(lookups, r.URL.Query().Get("Ids"))
			var items []string
			for _, id := range ids {
				items = append(items, fmt.Sprintf(`{"Id":"%s","Name":"Song %s","Type":"Audio"}`, id, id))
			}
			_, _ = w.Write([]byte(`{"Items":[` + strings.Join(items, ",") + `]}`))
		}
	}))
	t.Cleanup(server.Close)
	s := New(provider.Config{URL: server.URL, APIKey: "k", Transport: provider.Transport{Client: server.Client()}}, false)
	page, err := s.PlayHistory(t.Context(), 0, 500)
	if err != nil || len(page.Entries) != 250 {
		t.Fatal(len(page.Entries), err)
	}
	for _, entry := range page.Entries {
		if entry.Title != "Song "+entry.ItemID {
			t.Fatal("unresolved", entry)
		}
	}
	if len(lookups) != 3 {
		t.Fatal("lookups", len(lookups))
	}
}
