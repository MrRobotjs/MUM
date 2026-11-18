package audiobookshelf

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"app/server/providers/provider"
)

func historyServer(t *testing.T, handle func(w http.ResponseWriter, r *http.Request)) (*Server, *[]string) {
	t.Helper()
	var requests []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests = append(requests, r.Method+" "+r.URL.RequestURI()+" "+r.Header.Get("Authorization"))
		handle(w, r)
	}))
	t.Cleanup(server.Close)
	return New(provider.Config{URL: server.URL, APIKey: "abs-key", Transport: provider.Transport{Client: server.Client()}}), &requests
}

const sessionsPage = `{"total":7,"numPages":4,"page":1,"itemsPerPage":2,"sessions":[
 {"id":"ses_1","userId":"usr_1","libraryId":"lib_1","libraryItemId":"li_book","mediaType":"book","displayTitle":"A Book","displayAuthor":"An Author","startedAt":1762800000000,"updatedAt":1762803600000,"timeListening":3600.5,"currentTime":1800.9,"duration":36000.2},
 {"id":"ses_2","userId":"usr_2","libraryId":"lib_2","libraryItemId":"li_pod","episodeId":"ep_1","mediaType":"podcast","displayTitle":"Episode 4","displayAuthor":"A Podcast","startedAt":1762810000000,"updatedAt":1762810600000,"timeListening":600,"currentTime":600,"duration":1200}
]}`

func TestPlayHistoryReadsSessions(t *testing.T) {
	s, requests := historyServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/sessions" {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		_, _ = w.Write([]byte(sessionsPage))
	})
	page, err := s.PlayHistory(t.Context(), 2, 2)
	if err != nil {
		t.Fatal(err)
	}
	if page.Offset != 2 || page.Read != 2 || page.Total != 7 || len(page.Entries) != 2 {
		t.Fatalf("page %+v", page)
	}
	if got := (*requests)[0]; got != "GET /api/sessions?itemsPerPage=2&page=1&sort=startedAt Bearer abs-key" {
		t.Fatal("request", got)
	}
	book, pod := page.Entries[0], page.Entries[1]
	if book.Key != "ses_1" || book.AccountID != "usr_1" || book.Type != "book" || book.ItemID != "li_book" || book.Section != "lib_1" || book.Title != "A Book" ||
		book.ParentTitle != "An Author" || book.PosterItem != "li_book" || book.PosterPath != "cover" || !book.ViewedAt.Equal(time.UnixMilli(1762800000000)) ||
		book.PositionSeconds == nil || *book.PositionSeconds != 1800 || book.DurationSeconds == nil || *book.DurationSeconds != 36000 {
		t.Fatalf("book %+v", book)
	}
	if pod.Type != "podcast" || pod.Title != "Episode 4" || pod.ParentTitle != "A Podcast" {
		t.Fatalf("podcast %+v", pod)
	}
}

func TestPlayHistoryRejectsUnalignedStartAndBadReplies(t *testing.T) {
	reply := ""
	s, requests := historyServer(t, func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write([]byte(reply)) })
	if _, err := s.PlayHistory(t.Context(), 3, 2); !errors.Is(err, ErrPlayHistory) || len(*requests) != 0 {
		t.Fatal("unaligned start", err, *requests)
	}
	for name, body := range map[string]string{
		"no sessions":  `{"total":1}`,
		"no total":     `{"sessions":[]}`,
		"no id":        `{"total":1,"sessions":[{"userId":"u","startedAt":1762800000000}]}`,
		"no user":      `{"total":1,"sessions":[{"id":"s","startedAt":1762800000000}]}`,
		"no time":      `{"total":1,"sessions":[{"id":"s","userId":"u"}]}`,
		"repeated":     `{"total":2,"sessions":[{"id":"s","userId":"u","startedAt":1762800000000},{"id":"s","userId":"u","startedAt":1762800000000}]}`,
		"too many":     `{"total":3,"sessions":[{"id":"a","userId":"u","startedAt":1},{"id":"b","userId":"u","startedAt":1},{"id":"c","userId":"u","startedAt":1}]}`,
		"not json":     `<html>`,
		"negative len": `{"total":1,"sessions":[{"id":"s","userId":"u","startedAt":1762800000000,"duration":-5}]}`,
	} {
		reply = body
		page, err := s.PlayHistory(t.Context(), 0, 2)
		if name == "negative len" {
			if err != nil || page.Entries[0].DurationSeconds != nil {
				t.Error(name, err, page)
			}
			continue
		}
		if !errors.Is(err, ErrPlayHistory) {
			t.Error(name, err)
		}
	}
}

func TestCoverRefusesOtherTags(t *testing.T) {
	s, requests := historyServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "image/jpeg")
		_, _ = w.Write([]byte("\xff\xd8\xff\xe0jpeg"))
	})
	for _, bad := range [][2]string{{"li_book", "thumb"}, {"../x", "cover"}, {"", "cover"}} {
		if _, _, err := s.CatalogueImage(t.Context(), bad[0], bad[1]); err == nil {
			t.Error("fetched", bad)
		}
	}
	if len(*requests) != 0 {
		t.Fatal("requests for refused covers", *requests)
	}
	kind, body, err := s.CatalogueImage(t.Context(), "li_book", "cover")
	if err != nil || kind != "image/jpeg" || len(body) == 0 || (*requests)[0] != "GET /api/items/li_book/cover Bearer abs-key" {
		t.Fatal(kind, err, *requests)
	}
}

// One user's sessions: the request names the user, a user ID that isn't a
// UUID is refused before any request (Audiobookshelf would ignore it and send
// everyone's), and a reply with another user's session is refused. Sessions
// carry the time listened.
func TestAccountPlayHistory(t *testing.T) {
	const user = "4f8c2b1e-9d3a-4e5f-8a7b-6c5d4e3f2a1b"
	reply := `{"total":1,"sessions":[{"id":"ses_1","userId":"` + user + `","libraryItemId":"li_book","mediaType":"book","displayTitle":"A Book","startedAt":1762800000000,"timeListening":3600.5,"currentTime":1800,"duration":36000}]}`
	s, requests := historyServer(t, func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write([]byte(reply)) })
	page, err := s.AccountPlayHistory(t.Context(), user, 0, 10)
	if err != nil || len(page.Entries) != 1 || page.Entries[0].ListenedSeconds == nil || *page.Entries[0].ListenedSeconds != 3600 {
		t.Fatal(page, err)
	}
	if got := (*requests)[0]; got != "GET /api/sessions?itemsPerPage=10&page=0&sort=startedAt&user="+user+" Bearer abs-key" {
		t.Fatal(got)
	}
	if _, err := s.AccountPlayHistory(t.Context(), "usr_1", 0, 10); !errors.Is(err, ErrPlayHistory) || len(*requests) != 1 {
		t.Fatal("non-UUID user", err)
	}
	reply = sessionsPage
	if _, err := s.AccountPlayHistory(t.Context(), user, 0, 10); !errors.Is(err, ErrPlayHistory) {
		t.Fatal("another user's sessions accepted", err)
	}
}
