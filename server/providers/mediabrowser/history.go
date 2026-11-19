package mediabrowser

import (
	"context"
	"errors"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"app/server/providers/provider"
)

// ErrPlayHistory is any unusable activity log or item reply. The caller stops
// and keeps what it already stored; nothing is guessed from a bad page.
var ErrPlayHistory = errors.New("unusable play history")

// Jellyfin and Emby keep no per-play history, but their activity log has an
// entry each time a user stops playing an item (kept 30 days by default). Each
// such entry is one play: its ID makes repeat imports skip it, its time is
// when the play ended. The entry types are those the servers write
// (not yet checked against a real server).
var playbackStopped = map[string]bool{"VideoPlaybackStopped": true, "AudioPlaybackStopped": true, "playback.stop": true}

// PlayHistory reads one page of the activity log, newest first, and looks up
// the played items' titles and posters in one request. It only reads. An item
// that no longer exists keeps its play without a title or poster.
func (s *Server) PlayHistory(ctx context.Context, start, size int) (provider.HistoryPage, error) {
	if start < 0 || size < 1 || size > 1000 {
		return provider.HistoryPage{}, ErrPlayHistory
	}
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	var log struct {
		Items *[]struct {
			ID     *int64 `json:"Id"`
			Type   string
			ItemID string `json:"ItemId"`
			UserID string `json:"UserId"`
			Date   string
		}
		TotalRecordCount *int
	}
	query := url.Values{"StartIndex": {strconv.Itoa(start)}, "Limit": {strconv.Itoa(size)}}
	if err := s.Request(ctx, http.MethodGet, "/System/ActivityLog/Entries?"+query.Encode(), nil, &log); err != nil {
		if strings.Contains(err.Error(), "invalid JSON") {
			return provider.HistoryPage{}, ErrPlayHistory
		}
		return provider.HistoryPage{}, err
	}
	if log.Items == nil || log.TotalRecordCount == nil || *log.TotalRecordCount < 0 || len(*log.Items) > size {
		return provider.HistoryPage{}, ErrPlayHistory
	}
	page := provider.HistoryPage{Offset: start, Read: len(*log.Items), Total: *log.TotalRecordCount, Entries: []provider.HistoryEntry{}}
	seen := map[int64]bool{}
	var ids []string
	for _, row := range *log.Items {
		if row.ID == nil || seen[*row.ID] {
			return provider.HistoryPage{}, ErrPlayHistory
		}
		seen[*row.ID] = true
		if !playbackStopped[row.Type] || row.UserID == "" || row.ItemID == "" {
			continue
		}
		at, ok := activityDate(row.Date)
		if !ok || !ValidToken(row.ItemID) || !provider.ValidText(row.UserID, 64) {
			return provider.HistoryPage{}, ErrPlayHistory
		}
		page.Entries = append(page.Entries, provider.HistoryEntry{Key: "a" + strconv.FormatInt(*row.ID, 10), AccountID: row.UserID, ViewedAt: at, ItemID: row.ItemID})
		ids = append(ids, row.ItemID)
	}
	if len(ids) == 0 {
		return page, nil
	}
	items, err := s.historyItems(ctx, ids)
	if err != nil {
		return provider.HistoryPage{}, err
	}
	for i, entry := range page.Entries {
		if item, ok := items[entry.ItemID]; ok {
			item.Key, item.AccountID, item.ViewedAt, item.ItemID = entry.Key, entry.AccountID, entry.ViewedAt, entry.ItemID
			page.Entries[i] = item
		}
	}
	return page, nil
}

// activityDate reads an activity log time; one without a zone is UTC.
func activityDate(v string) (time.Time, bool) {
	if at, err := time.Parse(time.RFC3339Nano, v); err == nil {
		return at.UTC(), true
	}
	if at, err := time.Parse("2006-01-02T15:04:05.9999999", v); err == nil {
		return at, true
	}
	return time.Time{}, false
}

// historyItems describes the played items by ID: the title, the show of an
// episode, the album of a track, and the poster chosen as for live playback.
func (s *Server) historyItems(ctx context.Context, ids []string) (map[string]provider.HistoryEntry, error) {
	unique := map[string]bool{}
	var list []string
	for _, id := range ids {
		if !unique[id] {
			unique[id] = true
			list = append(list, id)
		}
	}
	out := map[string]provider.HistoryEntry{}
	for start := 0; start < len(list); start += historyLookupBatch {
		if err := s.historyItemBatch(ctx, list[start:min(start+historyLookupBatch, len(list))], unique, out); err != nil {
			return nil, err
		}
	}
	return out, nil
}

// historyLookupBatch bounds the IDs in one item lookup: 100 IDs keep the
// request line near 4 KiB, under the 8 KiB Jellyfin, Emby and common
// proxies accept.
const historyLookupBatch = 100

func (s *Server) historyItemBatch(ctx context.Context, list []string, unique map[string]bool, out map[string]provider.HistoryEntry) error {
	query := url.Values{"Ids": {strings.Join(list, ",")}, "Fields": {"SeriesPrimaryImageTag,AlbumPrimaryImageTag"}, "EnableUserData": {"false"}}
	var reply struct {
		Items *[]struct {
			ID                    string `json:"Id"`
			Name                  string
			Type                  string
			SeriesName            string
			SeriesID              string `json:"SeriesId"`
			SeriesPrimaryImageTag string
			Album                 string
			AlbumID               string `json:"AlbumId"`
			AlbumPrimaryImageTag  string
			ImageTags             map[string]string
		}
	}
	if err := s.Request(ctx, http.MethodGet, "/Items?"+query.Encode(), nil, &reply); err != nil {
		if strings.Contains(err.Error(), "invalid JSON") {
			return ErrPlayHistory
		}
		return err
	}
	if reply.Items == nil {
		return ErrPlayHistory
	}
	optional := func(value string) string {
		if value != "" && provider.ValidText(value, 1024) {
			return value
		}
		return ""
	}
	for _, row := range *reply.Items {
		if !unique[row.ID] {
			continue
		}
		entry := provider.HistoryEntry{Type: strings.ToLower(row.Type), Title: optional(row.Name), PosterItem: row.ID, PosterPath: row.ImageTags["Primary"]}
		switch row.Type {
		case "Episode":
			entry.GrandparentTitle = optional(row.SeriesName)
			if row.SeriesPrimaryImageTag != "" {
				entry.PosterItem, entry.PosterPath = row.SeriesID, row.SeriesPrimaryImageTag
			}
		case "Audio":
			entry.Type, entry.ParentTitle = "track", optional(row.Album)
			if row.AlbumPrimaryImageTag != "" {
				entry.PosterItem, entry.PosterPath = row.AlbumID, row.AlbumPrimaryImageTag
			}
		}
		if !provider.ValidText(entry.Type, 32) {
			entry.Type = ""
		}
		if !ValidToken(entry.PosterItem) || !ValidToken(entry.PosterPath) {
			entry.PosterItem, entry.PosterPath = "", ""
		}
		out[row.ID] = entry
	}
	return nil
}
