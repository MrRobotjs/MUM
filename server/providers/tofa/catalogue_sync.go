package tofa

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"strings"
	"time"

	"app/server/providers/provider"
)

var errCatalogueChanged = errors.New("Tofa catalogue changed during synchronization")

const catalogueSnapshotAttempts = 3

func (s *Server) CatalogueLibrarySupported(kind, library string) bool {
	return uuid.MatchString(library) && (kind == "movie" || kind == "show" || kind == "mixed" || kind == "other")
}

func (s *Server) catalogueFence(ctx context.Context, library string) (int, int64, error) {
	var profiles []struct {
		Primary   *bool           `json:"is_primary"`
		Kids      *bool           `json:"is_kids"`
		Libraries json.RawMessage `json:"library_ids"`
		Rating    json.RawMessage `json:"max_content_rating"`
	}
	if err := s.get(ctx, "/api/v1/profiles", &profiles); err != nil {
		return 0, 0, err
	}
	primary := 0
	for _, p := range profiles {
		if p.Primary == nil {
			return 0, 0, errors.New("invalid Tofa profiles")
		}
		if *p.Primary {
			primary++
			if p.Kids == nil || *p.Kids || string(p.Libraries) != "null" || string(p.Rating) != "null" {
				return 0, 0, errors.New("Tofa primary profile is restricted or incomplete")
			}
		}
	}
	if primary != 1 {
		return 0, 0, errors.New("Tofa primary profile unavailable")
	}
	var libraries []struct {
		ID    string `json:"id"`
		Stats *struct {
			Count *int `json:"item_count"`
		} `json:"stats"`
	}
	if err := s.get(ctx, "/api/v1/libraries?all=true&stats=true", &libraries); err != nil {
		return 0, 0, err
	}
	count := -1
	for _, l := range libraries {
		if strings.EqualFold(l.ID, library) {
			if count != -1 || l.Stats == nil || l.Stats.Count == nil || *l.Stats.Count < 0 || *l.Stats.Count > provider.CatalogueMaxItems {
				return 0, 0, errors.New("invalid Tofa library statistics")
			}
			count = *l.Stats.Count
		}
	}
	if count < 0 {
		return 0, 0, errors.New("Tofa library statistics unavailable")
	}
	var changes struct {
		Revision *int64 `json:"latest_revision"`
	}
	if err := s.get(ctx, "/api/v1/media/changes?limit=1", &changes); err != nil {
		return 0, 0, err
	}
	if changes.Revision == nil || *changes.Revision < 0 {
		return 0, 0, errors.New("Tofa catalogue revision unavailable")
	}
	return count, *changes.Revision, nil
}

func (s *Server) CatalogueItems(ctx context.Context, library, kind string, progress func(int, int)) ([]provider.CatalogueItem, error) {
	for attempt := 0; attempt < catalogueSnapshotAttempts; attempt++ {
		items, err := s.catalogueItemsOnce(ctx, library, kind, progress)
		if !errors.Is(err, errCatalogueChanged) || ctx.Err() != nil || attempt == catalogueSnapshotAttempts-1 {
			return items, err
		}
	}
	return nil, errCatalogueChanged
}

func (s *Server) catalogueItemsOnce(ctx context.Context, library, kind string, progress func(int, int)) ([]provider.CatalogueItem, error) {
	if !s.CatalogueLibrarySupported(kind, library) {
		return nil, provider.ErrCatalogueUnsupported
	}
	count, revision, err := s.catalogueFence(ctx, library)
	if err != nil {
		return nil, err
	}
	rows := make([]provider.CatalogueItem, 0, count)
	seen := make(map[string]bool, count)
	perPage := provider.CataloguePageSize
	pages := 1
	listedTotal := -1
	mergedKeys := make(map[string]bool)
	for page := 1; page <= pages; page++ {
		q := url.Values{"library_id": {library}, "page": {fmt.Sprint(page)}, "per_page": {fmt.Sprint(perPage)}, "fold_sets": {"false"}}
		var raw json.RawMessage
		if err := s.get(ctx, "/api/v1/media?"+q.Encode(), &raw); err != nil {
			return nil, err
		}
		batch, err := decodeMediaPage(raw)
		if err != nil {
			return nil, err
		}
		if batch.Total > count || (listedTotal >= 0 && batch.Total != listedTotal) {
			return nil, errors.New("Tofa library count mismatch")
		}
		listedTotal = batch.Total
		expectedPages := (listedTotal + batch.PerPage - 1) / batch.PerPage
		if batch.Page != page || batch.TotalPages != expectedPages || (page > 1 && batch.PerPage != perPage) || len(batch.Items) != min(batch.PerPage, listedTotal-len(rows)) {
			return nil, errors.New("incomplete Tofa catalogue page")
		}
		perPage = batch.PerPage
		pages = expectedPages
		for _, item := range batch.Items {
			id := strings.ToLower(item.ID)
			if !strings.EqualFold(item.LibraryID, library) || seen[id] || !provider.ValidText(item.Title, 512) {
				return nil, errors.New("invalid Tofa catalogue item")
			}
			seen[id] = true
			if item.TMDBID != nil && *item.TMDBID > 0 {
				mergedKeys[fmt.Sprintf("%s:%d", item.MediaType, *item.TMDBID)] = true
			}
			typ := item.MediaType
			switch typ {
			case "tv":
				typ = "show"
			case "other":
				typ = "video"
			}
			row := provider.CatalogueItem{ID: id, Title: item.Title, SortTitle: item.Title, Type: typ}
			if item.Overview != nil {
				row.Summary = provider.TruncateRunes(*item.Overview, 4096)
			}
			if item.ReleaseDate != nil {
				if date, e := time.Parse("2006-01-02", *item.ReleaseDate); e == nil {
					y := int64(date.Year())
					row.Year = &y
				}
			}
			if item.Rating != nil && *item.Rating >= 0 && *item.Rating <= 10 {
				row.Rating = item.Rating
			}
			if item.RuntimeMinutes != nil && *item.RuntimeMinutes >= 0 && *item.RuntimeMinutes <= 1000000 {
				ms := *item.RuntimeMinutes * 60000
				row.DurationMS = &ms
			}
			if item.PosterPath != nil && *item.PosterPath != "" {
				row.ImageTag = "poster"
			}
			rows = append(rows, row)
		}
		if progress != nil {
			progress(len(rows), count)
		}
	}
	if len(rows) != listedTotal {
		return nil, errors.New("incomplete Tofa catalogue")
	}
	if listedTotal != count {
		if err := s.verifyMergedCatalogue(ctx, library, count, seen, mergedKeys); err != nil {
			return nil, err
		}
	}
	afterCount, afterRevision, err := s.catalogueFence(ctx, library)
	if err != nil {
		return nil, err
	}
	if afterCount != count || afterRevision != revision {
		return nil, errCatalogueChanged
	}
	return rows, nil
}

// verifyMergedCatalogue checks that every record omitted by Tofa's browse
// response is an alternate version of an included title. A count mismatch by
// itself is never enough to accept a destructive snapshot.
func (s *Server) verifyMergedCatalogue(ctx context.Context, library string, count int, seen map[string]bool, keys map[string]bool) error {
	mismatch := func() error { return errors.New("Tofa library count mismatch") }
	var libraries []struct {
		ID    string `json:"id"`
		Merge *bool  `json:"merge_versions"`
	}
	if err := s.get(ctx, "/api/v1/libraries?all=true&stats=true", &libraries); err != nil {
		return err
	}
	enabled := false
	for _, lib := range libraries {
		if strings.EqualFold(lib.ID, library) {
			if lib.Merge == nil || !*lib.Merge {
				return mismatch()
			}
			enabled = true
		}
	}
	if !enabled {
		return mismatch()
	}
	all := make(map[string]bool, len(seen))
	for id := range seen {
		all[id] = true
	}
	after := ""
	cursors := map[string]bool{}
	fileCount := 0
	for {
		q := url.Values{"library_id": {library}, "limit": {"1000"}}
		if after != "" {
			q.Set("after", after)
		}
		var page struct {
			Items *[]struct {
				MediaID string `json:"media_id"`
			} `json:"items"`
			Next json.RawMessage `json:"next_after"`
		}
		if err := s.get(ctx, "/api/v1/media/files?"+q.Encode(), &page); err != nil {
			return err
		}
		if page.Items == nil || len(*page.Items) > 1000 || len(page.Next) == 0 {
			return mismatch()
		}
		fileCount += len(*page.Items)
		if fileCount > 1000000 {
			return mismatch()
		}
		for _, item := range *page.Items {
			if !uuid.MatchString(item.MediaID) {
				return mismatch()
			}
			all[strings.ToLower(item.MediaID)] = true
			if len(all) > count {
				return mismatch()
			}
		}
		if string(page.Next) == "null" {
			break
		}
		var next string
		if json.Unmarshal(page.Next, &next) != nil || !uuid.MatchString(next) || cursors[next] || len(*page.Items) == 0 {
			return mismatch()
		}
		cursors[next] = true
		after = next
	}
	if len(all) != count {
		return mismatch()
	}
	for id := range all {
		if seen[id] {
			continue
		}
		var detail struct {
			ID      string `json:"id"`
			Library string `json:"library_id"`
			Type    string `json:"media_type"`
			TMDB    *int64 `json:"tmdb_id"`
		}
		if err := s.get(ctx, "/api/v1/media/"+id, &detail); err != nil {
			return err
		}
		if !strings.EqualFold(detail.ID, id) || !strings.EqualFold(detail.Library, library) || detail.TMDB == nil || *detail.TMDB <= 0 || !keys[fmt.Sprintf("%s:%d", detail.Type, *detail.TMDB)] {
			return mismatch()
		}
	}
	return nil
}
