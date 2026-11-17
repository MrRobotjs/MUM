package audiobookshelf

import (
	"context"
	"errors"
	"math"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"app/server/providers/provider"
)

// ErrPlayHistory is any unusable listening session reply. The caller stops
// and keeps what it already stored; nothing is guessed from a bad page.
var ErrPlayHistory = errors.New("unusable Audiobookshelf listening sessions")

// ValidItemID restricts library item IDs, which are placed in API paths, to
// the characters Audiobookshelf uses (UUIDs, or "li_" IDs on older servers).
func ValidItemID(id string) bool {
	if id == "" || len(id) > 64 {
		return false
	}
	for _, c := range id {
		if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '-' || c == '_') {
			return false
		}
	}
	return true
}

// PlayHistory reads one page of every user's listening sessions, oldest
// first, so sessions added while an import runs land after the pages already
// read. Audiobookshelf pages by number, so start must be a multiple of size.
// Each session is one play with how long and how far. It only reads, and
// needs an administrator's API key.
func (s *Server) PlayHistory(ctx context.Context, start, size int) (provider.HistoryPage, error) {
	if start < 0 || size < 1 || size > 1000 || start%size != 0 {
		return provider.HistoryPage{}, ErrPlayHistory
	}
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	var reply struct {
		Total    *int `json:"total"`
		Sessions *[]struct {
			ID            string   `json:"id"`
			UserID        string   `json:"userId"`
			LibraryID     string   `json:"libraryId"`
			LibraryItemID string   `json:"libraryItemId"`
			MediaType     string   `json:"mediaType"`
			DisplayTitle  string   `json:"displayTitle"`
			DisplayAuthor string   `json:"displayAuthor"`
			StartedAt     *int64   `json:"startedAt"`
			CurrentTime   *float64 `json:"currentTime"`
			Duration      *float64 `json:"duration"`
		} `json:"sessions"`
	}
	query := url.Values{"itemsPerPage": {strconv.Itoa(size)}, "page": {strconv.Itoa(start / size)}, "sort": {"startedAt"}}
	if err := s.api(ctx, http.MethodGet, "/sessions?"+query.Encode(), nil, &reply); err != nil {
		if strings.Contains(err.Error(), "invalid JSON") {
			return provider.HistoryPage{}, ErrPlayHistory
		}
		return provider.HistoryPage{}, err
	}
	if reply.Total == nil || reply.Sessions == nil || *reply.Total < 0 || len(*reply.Sessions) > size {
		return provider.HistoryPage{}, ErrPlayHistory
	}
	optional := func(value string, limit int) string {
		if value != "" && provider.ValidText(value, limit) {
			return value
		}
		return ""
	}
	seconds := func(v *float64) *int64 {
		if v == nil || *v < 0 || math.IsNaN(*v) || *v > math.MaxInt32 {
			return nil
		}
		n := int64(*v)
		return &n
	}
	page := provider.HistoryPage{Offset: start, Read: len(*reply.Sessions), Total: *reply.Total, Entries: []provider.HistoryEntry{}}
	seen := map[string]bool{}
	for _, row := range *reply.Sessions {
		if !provider.ValidText(row.ID, 256) || !provider.ValidText(row.UserID, 64) || row.StartedAt == nil || *row.StartedAt <= 0 || seen[row.ID] {
			return provider.HistoryPage{}, ErrPlayHistory
		}
		seen[row.ID] = true
		entry := provider.HistoryEntry{
			Key: row.ID, AccountID: row.UserID, ViewedAt: time.UnixMilli(*row.StartedAt).UTC(),
			Type: optional(row.MediaType, 32), ItemID: optional(row.LibraryItemID, 256), Section: optional(row.LibraryID, 64),
			Title: optional(row.DisplayTitle, 1024), ParentTitle: optional(row.DisplayAuthor, 1024),
			PositionSeconds: seconds(row.CurrentTime), DurationSeconds: seconds(row.Duration),
		}
		if ValidItemID(row.LibraryItemID) {
			entry.PosterItem, entry.PosterPath = row.LibraryItemID, "cover"
		}
		page.Entries = append(page.Entries, entry)
	}
	return page, nil
}

// CatalogueImage fetches one bounded library item cover; "cover" is the only
// image reference an Audiobookshelf item has.
func (s *Server) CatalogueImage(ctx context.Context, item, tag string) (string, []byte, error) {
	if tag != "cover" || !ValidItemID(item) {
		return "", nil, provider.ErrCatalogueUnsupported
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, s.url+"/api/items/"+item+"/cover", nil)
	if err != nil {
		return "", nil, errors.New("invalid provider request")
	}
	req.Header.Set("Accept", "image/*")
	s.authorize(req.Header)
	kind, body, err := s.transport.Fetch(req, provider.CatalogueImageMax, provider.ImageType)
	switch {
	case errors.Is(err, provider.ErrUnsupportedType):
		return "", nil, errors.New("provider returned an unsupported image type")
	case errors.Is(err, provider.ErrUnreadableBody):
		return "", nil, errors.New("provider image exceeds size limit or could not be read")
	case err != nil:
		return "", nil, err
	}
	return kind, body, nil
}
