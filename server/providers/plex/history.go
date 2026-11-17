package plex

import (
	"context"
	"encoding/xml"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"app/server/providers/provider"
)

// ErrPlayHistory is any unusable play history reply. The caller stops and
// keeps what it already stored; nothing is guessed from a bad page.
var ErrPlayHistory = errors.New("unusable Plex play history")

// maxHistoryBytes bounds one history page; 500 entries are about 250 KiB.
const maxHistoryBytes = 8 << 20

// Play history entries use provider.HistoryEntry: Plex writes an entry when an
// item is finished, with a single time and no length, player or quality. An
// entry for a deleted item has no rating key (ItemID) and may have no title.
// The poster is chosen as for live playback: the movie's own, the show's for
// an episode, the album's for a track; empty when Plex sent none or the path
// is not that item's own thumbnail.

// PlayHistory reads one page of the server's play history, oldest first, so
// entries Plex adds while an import runs land after the pages already read.
// It only reads.
func (s *Server) PlayHistory(ctx context.Context, start, size int) (provider.HistoryPage, error) {
	if start < 0 || size < 1 || size > 1000 {
		return provider.HistoryPage{}, ErrPlayHistory
	}
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, s.url+"/status/sessions/history/all?sort=viewedAt:asc", nil)
	if err != nil {
		return provider.HistoryPage{}, ErrPlayHistory
	}
	req.Header.Set("Accept", "application/xml")
	req.Header.Set("X-Plex-Container-Start", strconv.Itoa(start))
	req.Header.Set("X-Plex-Container-Size", strconv.Itoa(size))
	s.Authorize(req.Header)
	_, body, err := s.transport.Fetch(req, maxHistoryBytes, nil)
	if err != nil {
		return provider.HistoryPage{}, err
	}
	return ParsePlayHistory(body)
}

// ParsePlayHistory validates one history page: its size must match its rows,
// and every row needs a unique history key, an account and a time. Titles and
// other descriptive fields that are too long are dropped, not fatal.
func ParsePlayHistory(body []byte) (provider.HistoryPage, error) {
	var page struct {
		XMLName xml.Name `xml:"MediaContainer"`
		Size    *int     `xml:"size,attr"`
		Total   *int     `xml:"totalSize,attr"`
		Offset  int      `xml:"offset,attr"`
		Rows    []struct {
			Key              string `xml:"historyKey,attr"`
			Account          string `xml:"accountID,attr"`
			Viewed           string `xml:"viewedAt,attr"`
			Type             string `xml:"type,attr"`
			RatingKey        string `xml:"ratingKey,attr"`
			Section          string `xml:"librarySectionID,attr"`
			Title            string `xml:"title,attr"`
			ParentTitle      string `xml:"parentTitle,attr"`
			GrandparentTitle string `xml:"grandparentTitle,attr"`
			Thumb            string `xml:"thumb,attr"`
			ParentKey        string `xml:"parentKey,attr"`
			ParentThumb      string `xml:"parentThumb,attr"`
			GrandparentKey   string `xml:"grandparentKey,attr"`
			GrandparentThumb string `xml:"grandparentThumb,attr"`
		} `xml:",any"`
	}
	if len(body) > maxHistoryBytes || xml.Unmarshal(body, &page) != nil || page.Size == nil || page.Total == nil {
		return provider.HistoryPage{}, ErrPlayHistory
	}
	if *page.Size != len(page.Rows) || *page.Total < 0 || page.Offset < 0 {
		return provider.HistoryPage{}, ErrPlayHistory
	}
	out := provider.HistoryPage{Entries: make([]provider.HistoryEntry, 0, len(page.Rows)), Offset: page.Offset, Read: len(page.Rows), Total: *page.Total}
	seen := map[string]bool{}
	optional := func(value string, limit int) string {
		if value != "" && provider.ValidText(value, limit) {
			return value
		}
		return ""
	}
	for _, row := range page.Rows {
		viewed, err := strconv.ParseInt(row.Viewed, 10, 64)
		if !provider.ValidText(row.Key, 256) || !provider.ValidText(row.Account, 64) || err != nil || viewed <= 0 || seen[row.Key] {
			return provider.HistoryPage{}, ErrPlayHistory
		}
		seen[row.Key] = true
		item, path := row.RatingKey, row.Thumb
		switch {
		case row.Type == "episode" && row.GrandparentThumb != "":
			item, path = metadataID(row.GrandparentKey), row.GrandparentThumb
		case row.Type == "track" && row.ParentThumb != "":
			item, path = metadataID(row.ParentKey), row.ParentThumb
		}
		if !ValidPoster(item, path) {
			item, path = "", ""
		}
		out.Entries = append(out.Entries, provider.HistoryEntry{
			Key: row.Key, AccountID: row.Account, ViewedAt: time.Unix(viewed, 0),
			Type: optional(row.Type, 32), ItemID: optional(row.RatingKey, 256), Section: optional(row.Section, 64),
			Title: optional(row.Title, 1024), ParentTitle: optional(row.ParentTitle, 1024), GrandparentTitle: optional(row.GrandparentTitle, 1024),
			PosterItem: item, PosterPath: path,
		})
	}
	return out, nil
}

// metadataID is the rating key in a "/library/metadata/{id}" key, or "".
func metadataID(key string) string {
	id, found := strings.CutPrefix(key, "/library/metadata/")
	if !found || !NumericID(id) {
		return ""
	}
	return id
}
