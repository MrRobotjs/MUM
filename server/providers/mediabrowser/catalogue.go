package mediabrowser

import (
	"context"
	"errors"
	"math"
	"net/http"
	"net/url"
	"strconv"
	"time"

	"app/server/providers/provider"
)

// ValidToken restricts item and image identifiers, which are placed in API
// paths, to the characters Jellyfin and Emby use.
func ValidToken(v string) bool {
	if v == "" || len(v) > 64 {
		return false
	}
	for _, c := range v {
		if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '-') {
			return false
		}
	}
	return true
}

var catalogueKinds = map[string]string{"Movie": "movie", "Series": "show", "MusicAlbum": "album", "Book": "book", "AudioBook": "audiobook", "MusicVideo": "music_video", "Video": "video"}

// CatalogueItems reads one library's top-level items. kind is not needed:
// every library type is listed the same way.
func (s *Server) CatalogueItems(ctx context.Context, library, kind string, progress func(fetched, total int)) ([]provider.CatalogueItem, error) {
	return s.items(ctx, library, false, progress)
}

// CatalogueEpisodes reads one series' episodes.
func (s *Server) CatalogueEpisodes(ctx context.Context, show string) ([]provider.CatalogueItem, error) {
	return s.items(ctx, show, true, nil)
}

// items pages through one library's items, or one series' episodes. The
// server has no snapshot isolation, so a changed total, a duplicate or a
// short final count rejects the whole snapshot instead of returning part.
func (s *Server) items(ctx context.Context, parent string, episodes bool, progress func(fetched, total int)) ([]provider.CatalogueItem, error) {
	if !ValidToken(parent) {
		return nil, errors.New("invalid provider parent identifier")
	}
	kinds, types, limit := catalogueKinds, "Movie,Series,MusicAlbum,Book,AudioBook,MusicVideo,Video", provider.CatalogueMaxItems
	if episodes {
		kinds, types, limit = map[string]string{"Episode": "episode"}, "Episode", provider.CatalogueMaxEpisodes
	}
	items := []provider.CatalogueItem{}
	seen := map[string]bool{}
	total := -1
	for start := 0; ; start += provider.CataloguePageSize {
		query := url.Values{
			"ParentId": {parent}, "Recursive": {"true"},
			"IncludeItemTypes": {types},
			"Fields":           {"SortName,Overview,DateCreated"}, "SortBy": {"SortName"}, "SortOrder": {"Ascending"},
			"EnableImageTypes": {"Primary"}, "ImageTypeLimit": {"1"}, "EnableUserData": {"false"},
			"StartIndex": {strconv.Itoa(start)}, "Limit": {strconv.Itoa(provider.CataloguePageSize)},
		}
		var page struct {
			Items *[]struct {
				ID              string `json:"Id"`
				Name            string
				SortName        string
				Type            string
				Overview        string
				DateCreated     string
				ProductionYear  *int64
				CommunityRating *float64
				RunTimeTicks    *int64
				ImageTags       map[string]string
				SeriesID        string `json:"SeriesId"`
				IndexNumber     *int64
				ParentIndex     *int64 `json:"ParentIndexNumber"`
			}
			TotalRecordCount *int64
		}
		if err := s.Request(ctx, http.MethodGet, "/Items?"+query.Encode(), nil, &page); err != nil {
			return nil, err
		}
		if page.Items == nil || page.TotalRecordCount == nil || *page.TotalRecordCount < 0 || *page.TotalRecordCount > int64(limit) {
			return nil, errors.New("provider returned an invalid or oversized item page")
		}
		if total >= 0 && int(*page.TotalRecordCount) != total {
			return nil, errors.New("library changed during synchronization")
		}
		total = int(*page.TotalRecordCount)
		for _, row := range *page.Items {
			kind, ok := kinds[row.Type]
			title := provider.TruncateRunes(row.Name, 512)
			if !ok || !ValidToken(row.ID) || seen[row.ID] || title == "" || episodes && row.SeriesID != parent {
				return nil, errors.New("provider returned an invalid or duplicate item")
			}
			seen[row.ID] = true
			item := provider.CatalogueItem{ID: row.ID, Title: title, SortTitle: provider.TruncateRunes(row.SortName, 512), Type: kind, Summary: provider.TruncateRunes(row.Overview, 8000)}
			if item.SortTitle == "" {
				item.SortTitle = title
			}
			if row.ProductionYear != nil && *row.ProductionYear > 0 && *row.ProductionYear < 10000 {
				item.Year = row.ProductionYear
			}
			if row.CommunityRating != nil && !math.IsNaN(*row.CommunityRating) && *row.CommunityRating >= 0 && *row.CommunityRating <= 10 {
				item.Rating = row.CommunityRating
			}
			if row.RunTimeTicks != nil && *row.RunTimeTicks >= 0 {
				ms := *row.RunTimeTicks / 10000
				item.DurationMS = &ms
			}
			if added, err := time.Parse(time.RFC3339Nano, row.DateCreated); err == nil {
				item.AddedAt = provider.Timestamp(added)
			}
			if tag := row.ImageTags["Primary"]; ValidToken(tag) {
				item.ImageTag = tag
			}
			if episodes {
				if row.ParentIndex != nil && *row.ParentIndex >= 0 && *row.ParentIndex <= 100000 {
					item.Season = row.ParentIndex
				}
				if row.IndexNumber != nil && *row.IndexNumber >= 0 && *row.IndexNumber <= 100000 {
					item.Episode = row.IndexNumber
				}
			}
			items = append(items, item)
		}
		if progress != nil {
			progress(len(items), total)
		}
		if len(items) > total {
			return nil, errors.New("provider returned more items than its reported total")
		}
		if len(items) == total {
			return items, nil
		}
		if len(*page.Items) == 0 {
			return nil, errors.New("provider item pages ended before the reported total")
		}
	}
}

// CatalogueImage fetches one bounded item poster.
func (s *Server) CatalogueImage(ctx context.Context, item, tag string) (string, []byte, error) {
	if !ValidToken(item) || !ValidToken(tag) {
		return "", nil, provider.ErrCatalogueUnsupported
	}
	target := s.base + "/Items/" + item + "/Images/Primary?" + url.Values{"maxWidth": {"400"}, "quality": {"90"}, "tag": {tag}}.Encode()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
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
