package plex

import (
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"app/server/providers/provider"
)

type historyRoundTrip func(*http.Request) (*http.Response, error)

func (f historyRoundTrip) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

const historyPage = `<MediaContainer size="3" totalSize="5" offset="0">
<Video historyKey="/status/sessions/history/12" key="/library/metadata/1234" ratingKey="1234" librarySectionID="1" title="A Movie" type="movie" viewedAt="1345678901" accountID="123456" deviceID="12"/>
<Video historyKey="/status/sessions/history/13" ratingKey="88" librarySectionID="2" title="Pilot" parentTitle="Season 1" grandparentTitle="A Show" type="episode" viewedAt="1345679000" accountID="1" deviceID="3"/>
<Track historyKey="/status/sessions/history/14" librarySectionID="9" type="track" viewedAt="1345679100" accountID="77" deviceID="4"/>
</MediaContainer>`

func TestParsePlayHistoryKeepsWhatPlexGives(t *testing.T) {
	page, err := ParsePlayHistory([]byte(historyPage))
	if err != nil {
		t.Fatal(err)
	}
	if page.Total != 5 || page.Offset != 0 || len(page.Entries) != 3 {
		t.Fatalf("page %+v", page)
	}
	first := page.Entries[0]
	if first.Key != "/status/sessions/history/12" || first.AccountID != "123456" || first.RatingKey != "1234" || first.Type != "movie" || first.Section != "1" || first.Title != "A Movie" || !first.ViewedAt.Equal(time.Unix(1345678901, 0)) {
		t.Fatalf("first %+v", first)
	}
	if e := page.Entries[1]; e.ParentTitle != "Season 1" || e.GrandparentTitle != "A Show" || e.AccountID != "1" {
		t.Fatalf("episode %+v", e)
	}
	// An entry for a deleted item has no rating key or title; it is still a play.
	if e := page.Entries[2]; e.RatingKey != "" || e.Title != "" || e.Key != "/status/sessions/history/14" {
		t.Fatalf("deleted item %+v", e)
	}
}

func TestParsePlayHistoryRejectsUnusablePages(t *testing.T) {
	for name, body := range map[string]string{
		"not xml":         `{"MediaContainer":{}}`,
		"no total":        `<MediaContainer size="0" offset="0"></MediaContainer>`,
		"size mismatch":   `<MediaContainer size="2" totalSize="2" offset="0"><Video historyKey="/a" viewedAt="1" accountID="1"/></MediaContainer>`,
		"no key":          `<MediaContainer size="1" totalSize="1" offset="0"><Video viewedAt="1" accountID="1"/></MediaContainer>`,
		"no account":      `<MediaContainer size="1" totalSize="1" offset="0"><Video historyKey="/a" viewedAt="1"/></MediaContainer>`,
		"bad time":        `<MediaContainer size="1" totalSize="1" offset="0"><Video historyKey="/a" viewedAt="soon" accountID="1"/></MediaContainer>`,
		"zero time":       `<MediaContainer size="1" totalSize="1" offset="0"><Video historyKey="/a" viewedAt="0" accountID="1"/></MediaContainer>`,
		"duplicate entry": `<MediaContainer size="2" totalSize="2" offset="0"><Video historyKey="/a" viewedAt="1" accountID="1"/><Video historyKey="/a" viewedAt="2" accountID="1"/></MediaContainer>`,
	} {
		if _, err := ParsePlayHistory([]byte(body)); !errors.Is(err, ErrPlayHistory) {
			t.Errorf("%s accepted: %v", name, err)
		}
	}
	// Overlong titles are dropped rather than failing the page.
	long := strings.Repeat("x", 1025)
	page, err := ParsePlayHistory([]byte(`<MediaContainer size="1" totalSize="1" offset="0"><Video historyKey="/a" viewedAt="1" accountID="1" title="` + long + `"/></MediaContainer>`))
	if err != nil || page.Entries[0].Title != "" {
		t.Fatal(page, err)
	}
}

func TestPlayHistoryReadsOnePageWithGET(t *testing.T) {
	var seen *http.Request
	client := &http.Client{Transport: historyRoundTrip(func(r *http.Request) (*http.Response, error) {
		seen = r
		return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(historyPage)), Request: r}, nil
	})}
	s := New(provider.Config{URL: "http://plex.test/", APIKey: "fixture-secret", Transport: provider.Transport{Client: client}})
	page, err := s.PlayHistory(t.Context(), 500, 500)
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Entries) != 3 {
		t.Fatal(page)
	}
	if seen.Method != http.MethodGet || seen.URL.Path != "/status/sessions/history/all" || seen.URL.Query().Get("sort") != "viewedAt:asc" {
		t.Fatal("request", seen.Method, seen.URL)
	}
	if seen.Header.Get("X-Plex-Container-Start") != "500" || seen.Header.Get("X-Plex-Container-Size") != "500" || seen.Header.Get("X-Plex-Token") != "fixture-secret" {
		t.Fatal("headers", seen.Header)
	}
}

// Posters are chosen as for live playback, and only an item's own thumbnail
// is kept: a path that belongs to another item is dropped.
func TestParsePlayHistoryChoosesPosters(t *testing.T) {
	page, err := ParsePlayHistory([]byte(`<MediaContainer size="5" totalSize="5" offset="0">
<Video historyKey="/m" ratingKey="10" thumb="/library/metadata/10/thumb/1700" type="movie" viewedAt="1" accountID="1"/>
<Video historyKey="/e" ratingKey="22" thumb="/library/metadata/22/thumb/1" parentKey="/library/metadata/21" parentThumb="/library/metadata/21/thumb/2" grandparentKey="/library/metadata/20" grandparentThumb="/library/metadata/20/thumb/3" type="episode" viewedAt="2" accountID="1"/>
<Track historyKey="/t" ratingKey="32" thumb="/library/metadata/31/thumb/4" parentKey="/library/metadata/31" parentThumb="/library/metadata/31/thumb/4" grandparentKey="/library/metadata/30" grandparentThumb="/library/metadata/30/thumb/5" type="track" viewedAt="3" accountID="1"/>
<Video historyKey="/x" ratingKey="40" thumb="/library/metadata/41/thumb/6" type="movie" viewedAt="4" accountID="1"/>
<Video historyKey="/g" ratingKey="50" thumb="https://elsewhere.test/a.jpg" type="movie" viewedAt="5" accountID="1"/>
</MediaContainer>`))
	if err != nil {
		t.Fatal(err)
	}
	want := [][2]string{{"10", "/library/metadata/10/thumb/1700"}, {"20", "/library/metadata/20/thumb/3"}, {"31", "/library/metadata/31/thumb/4"}, {"", ""}, {"", ""}}
	for i, entry := range page.Entries {
		if got := [2]string{entry.PosterItem, entry.PosterPath}; got != want[i] {
			t.Errorf("%s poster %v, want %v", entry.Key, got, want[i])
		}
	}
	// The page without posters (the first fixture) has none.
	plain, _ := ParsePlayHistory([]byte(historyPage))
	for _, entry := range plain.Entries {
		if entry.PosterItem != "" || entry.PosterPath != "" {
			t.Errorf("%s poster without a thumbnail", entry.Key)
		}
	}
}
