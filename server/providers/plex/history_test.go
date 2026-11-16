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
