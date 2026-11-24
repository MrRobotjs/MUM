package tofa

import (
	"app/server/providers/provider"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"sort"
	"strings"
)

type tofaShow struct {
	ID      string `json:"id"`
	Library string `json:"library_id"`
	Type    string `json:"media_type"`
	TMDB    *int64 `json:"tmdb_id"`
	Seasons *[]struct {
		ID       string `json:"id"`
		MediaID  string `json:"media_id"`
		Number   *int64 `json:"season_number"`
		Episodes *[]struct {
			ID       string  `json:"id"`
			SeasonID string  `json:"season_id"`
			Number   *int64  `json:"episode_number"`
			Title    *string `json:"title"`
			Still    *string `json:"still_path"`
			Overview *string `json:"overview"`
			Runtime  *int64  `json:"runtime_minutes"`
			Files    *[]struct {
				Available *bool `json:"available"`
			} `json:"files"`
		} `json:"episodes"`
	} `json:"seasons"`
}

func (s *Server) CatalogueEpisodes(ctx context.Context, show string) ([]provider.CatalogueItem, error) {
	for attempt := 0; attempt < catalogueSnapshotAttempts; attempt++ {
		items, err := s.catalogueEpisodesOnce(ctx, show)
		if !errors.Is(err, errCatalogueChanged) || ctx.Err() != nil || attempt == catalogueSnapshotAttempts-1 {
			return items, err
		}
	}
	return nil, errCatalogueChanged
}

func (s *Server) catalogueEpisodesOnce(ctx context.Context, show string) ([]provider.CatalogueItem, error) {
	if !uuid.MatchString(show) {
		return nil, errors.New("invalid Tofa show identifier")
	}
	read := func(id string) (tofaShow, error) {
		var d tofaShow
		err := s.get(ctx, "/api/v1/media/"+id, &d)
		if err != nil {
			return d, err
		}
		if !strings.EqualFold(d.ID, id) || !uuid.MatchString(d.Library) || d.Type != "tv" || d.Seasons == nil {
			return d, errors.New("invalid Tofa show snapshot")
		}
		return d, nil
	}
	primary, err := read(show)
	if err != nil {
		return nil, err
	}
	count, revision, err := s.catalogueFence(ctx, primary.Library)
	if err != nil {
		return nil, err
	}
	// Read the episode snapshot after the revision fence, not before it.
	libraryID := primary.Library
	primary, err = read(show)
	if err != nil {
		return nil, err
	}
	if !strings.EqualFold(primary.Library, libraryID) {
		return nil, errors.New("Tofa show library changed")
	}
	var libs []struct {
		ID    string `json:"id"`
		Merge *bool  `json:"merge_versions"`
	}
	if err = s.get(ctx, "/api/v1/libraries?all=true&stats=true", &libs); err != nil {
		return nil, err
	}
	merge := false
	found := false
	for _, lib := range libs {
		if strings.EqualFold(lib.ID, primary.Library) {
			if found || lib.Merge == nil {
				return nil, errors.New("invalid Tofa library settings")
			}
			merge = *lib.Merge
			found = true
		}
	}
	if !found {
		return nil, errors.New("Tofa library unavailable")
	}
	shows := []tofaShow{primary}
	if merge {
		if primary.TMDB == nil || *primary.TMDB <= 0 {
			return nil, errors.New("Tofa merged show identity unavailable")
		}
		ids := map[string]bool{strings.ToLower(show): true}
		unknown := map[string]bool{}
		after := ""
		cursors := map[string]bool{}
		fileCount := 0
		for {
			q := url.Values{"library_id": {primary.Library}, "limit": {"1000"}}
			if after != "" {
				q.Set("after", after)
			}
			var page struct {
				Items *[]struct {
					MediaID   string `json:"media_id"`
					MediaType string `json:"media_type"`
					TMDB      *int64 `json:"tmdb_id"`
				} `json:"items"`
				Next json.RawMessage `json:"next_after"`
			}
			if err = s.get(ctx, "/api/v1/media/files?"+q.Encode(), &page); err != nil {
				return nil, err
			}
			if page.Items == nil || len(*page.Items) > 1000 || len(page.Next) == 0 {
				return nil, errors.New("invalid Tofa file snapshot")
			}
			fileCount += len(*page.Items)
			if fileCount > 1000000 {
				return nil, errors.New("Tofa file snapshot too large")
			}
			for _, f := range *page.Items {
				if !uuid.MatchString(f.MediaID) {
					return nil, errors.New("invalid Tofa file snapshot")
				}
				if f.MediaType == "tv" && f.TMDB == nil {
					if !strings.EqualFold(f.MediaID, show) {
						unknown[strings.ToLower(f.MediaID)] = true
					}
				}
				if f.MediaType == "tv" && f.TMDB != nil && *f.TMDB == *primary.TMDB {
					ids[strings.ToLower(f.MediaID)] = true
				}
			}
			if string(page.Next) == "null" {
				break
			}
			var next string
			if json.Unmarshal(page.Next, &next) != nil || !uuid.MatchString(next) || cursors[next] || len(*page.Items) == 0 {
				return nil, errors.New("invalid Tofa file snapshot")
			}
			cursors[next] = true
			after = next
		}
		if len(unknown) > 0 {
			// A separately visible show is not an omitted version of this one.
			visible, err := s.CatalogueItems(ctx, primary.Library, "show", nil)
			if err != nil {
				return nil, err
			}
			for _, item := range visible {
				delete(unknown, strings.ToLower(item.ID))
			}
			for id := range unknown {
				var detail struct {
					ID      string `json:"id"`
					Library string `json:"library_id"`
					Type    string `json:"media_type"`
					TMDB    *int64 `json:"tmdb_id"`
				}
				if err := s.get(ctx, "/api/v1/media/"+id, &detail); err != nil {
					return nil, err
				}
				if !strings.EqualFold(detail.ID, id) || !strings.EqualFold(detail.Library, primary.Library) || detail.Type != "tv" || detail.TMDB == nil {
					return nil, errors.New("Tofa file show identity unavailable")
				}
				if *detail.TMDB == *primary.TMDB {
					ids[id] = true
				}
			}
		}
		var extra []string
		for id := range ids {
			if !strings.EqualFold(id, show) {
				extra = append(extra, id)
			}
		}
		sort.Strings(extra)
		for _, id := range extra {
			d, e := read(id)
			if e != nil {
				return nil, e
			}
			if !strings.EqualFold(d.Library, primary.Library) || d.TMDB == nil || *d.TMDB != *primary.TMDB {
				return nil, errors.New("invalid Tofa merged show")
			}
			shows = append(shows, d)
		}
	}
	result := []provider.CatalogueItem{}
	seenEpisodes := map[string]bool{}
	seenNumbers := map[string]bool{}
	for _, d := range shows {
		for _, season := range *d.Seasons {
			if !uuid.MatchString(season.ID) || !strings.EqualFold(season.MediaID, d.ID) || season.Number == nil || *season.Number < 0 || season.Episodes == nil {
				return nil, errors.New("invalid Tofa season snapshot")
			}
			for _, ep := range *season.Episodes {
				id := strings.ToLower(ep.ID)
				if !uuid.MatchString(id) || !strings.EqualFold(ep.SeasonID, season.ID) || ep.Number == nil || *ep.Number < 0 || ep.Files == nil || seenEpisodes[id] {
					return nil, errors.New("invalid Tofa episode snapshot")
				}
				seenEpisodes[id] = true
				available := false
				for _, f := range *ep.Files {
					if f.Available == nil {
						return nil, errors.New("invalid Tofa file availability")
					}
					available = available || *f.Available
				}
				if !available {
					continue
				}
				number := fmt.Sprintf("%d:%d", *season.Number, *ep.Number)
				if seenNumbers[number] {
					continue
				}
				seenNumbers[number] = true
				title := fmt.Sprintf("Episode %d", *ep.Number)
				if ep.Title != nil && provider.ValidText(*ep.Title, 512) {
					title = *ep.Title
				}
				row := provider.CatalogueItem{ID: id, Title: title, SortTitle: title, Type: "episode", Season: season.Number, Episode: ep.Number}
				if ep.Still != nil && episodeStillPath.MatchString(*ep.Still) {
					row.ImageTag = *ep.Still
				}
				if ep.Overview != nil {
					row.Summary = provider.TruncateRunes(*ep.Overview, 4096)
				}
				if ep.Runtime != nil && *ep.Runtime >= 0 && *ep.Runtime <= 1000000 {
					ms := *ep.Runtime * 60000
					row.DurationMS = &ms
				}
				result = append(result, row)
				if len(result) > provider.CatalogueMaxEpisodes {
					return nil, errors.New("Tofa episode snapshot too large")
				}
			}
		}
	}
	afterCount, afterRevision, err := s.catalogueFence(ctx, primary.Library)
	if err != nil {
		return nil, err
	}
	if afterCount != count || afterRevision != revision {
		return nil, errCatalogueChanged
	}
	return result, nil
}
