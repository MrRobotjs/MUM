package main

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"app/server/providers/provider"
)

// A library's Media Info tab: every item that is one file (movies and videos,
// a TV library's episodes, a music library's tracks) with the file details the
// last library sync saved, its plays and when it was last played. Plays count
// MUM's recordings and the server's imported history of that exact item.

const mediaInfoPlays = `((SELECT count(*) FROM media_activity_history h WHERE h.server_id=i.server_id AND h.item_id=i.external_id)
 +(SELECT count(*) FROM history_imports x WHERE x.server_id=i.server_id AND x.item_id=i.external_id))`
const mediaInfoLastPlayed = `max(coalesce((SELECT max(julianday(h.first_seen_at)) FROM media_activity_history h WHERE h.server_id=i.server_id AND h.item_id=i.external_id),0),
 coalesce((SELECT max(julianday(x.viewed_at)) FROM history_imports x WHERE x.server_id=i.server_id AND x.item_id=i.external_id),0))`

func mediaInfoField(name string) string { return "json_extract(i.media_info,'$." + name + "')" }

// mediaInfoSorts are the sortable columns; text sorts ignore case, the
// resolution sorts by its height and the frame rate by its number.
var mediaInfoSorts = map[string]string{
	"added":            "i.added_at",
	"title":            "coalesce(p.sort_title,p.title,i.sort_title,i.title) COLLATE NOCASE",
	"container":        mediaInfoField("container") + " COLLATE NOCASE",
	"bitrate":          mediaInfoField("bitrate_kbps"),
	"video_codec":      mediaInfoField("video_codec") + " COLLATE NOCASE",
	"video_resolution": "CASE " + mediaInfoField("video_resolution") + " WHEN 'SD' THEN 480 WHEN '4K' THEN 2160 ELSE CAST(rtrim(" + mediaInfoField("video_resolution") + ",'p') AS INTEGER) END",
	"video_frame_rate": "CAST(rtrim(" + mediaInfoField("video_frame_rate") + ",'p') AS INTEGER)",
	"audio_codec":      mediaInfoField("audio_codec") + " COLLATE NOCASE",
	"audio_channels":   mediaInfoField("audio_channels"),
	"size":             mediaInfoField("size_bytes"),
	"last_played":      "nullif(" + mediaInfoLastPlayed + ",0)",
	"plays":            mediaInfoPlays,
}

type mediaInfoRow struct {
	ID          int64                    `json:"id"`
	Type        string                   `json:"item_type"`
	Title       string                   `json:"title"`
	ParentID    *int64                   `json:"parent_id"`
	ParentTitle *string                  `json:"parent_title,omitempty"`
	Season      *int64                   `json:"season_number,omitempty"`
	Episode     *int64                   `json:"episode_number,omitempty"`
	Year        *int64                   `json:"year,omitempty"`
	AddedAt     *string                  `json:"added_at"`
	Media       *provider.CatalogueMedia `json:"media_info"`
	Plays       int64                    `json:"plays"`
	LastPlayed  *string                  `json:"last_played_at"`
}

func (a *App) libraryMediaInfo(w http.ResponseWriter, r *http.Request) {
	p, ok := a.principal(w, r, true)
	if !ok {
		return
	}
	id, ok := pathID(w, r, "library")
	if !ok {
		return
	}
	query := r.URL.Query()
	page, size := 1, 25
	if raw := query.Get("page"); raw != "" {
		n, err := strconv.Atoi(raw)
		if err != nil || n < 1 || n > 100000 {
			fail(w, 400, "INVALID_PAGE", "Invalid page")
			return
		}
		page = n
	}
	if raw := query.Get("page_size"); raw != "" {
		n, err := strconv.Atoi(raw)
		if err != nil || n < 1 || n > 100 {
			fail(w, 400, "INVALID_PAGE_SIZE", "Use a page size from 1 to 100")
			return
		}
		size = n
	}
	sortKey, direction := "title", "ASC"
	if raw := query.Get("sort"); raw != "" {
		if _, ok := mediaInfoSorts[raw]; !ok {
			fail(w, 400, "SORT_UNAVAILABLE", "This column can't be sorted")
			return
		}
		sortKey = raw
	}
	switch query.Get("order") {
	case "", "asc":
	case "desc":
		direction = "DESC"
	default:
		fail(w, 400, "INVALID_ORDER", "Use asc or desc")
		return
	}
	search := query.Get("search")
	if utf8.RuneCountInString(search) > 200 {
		fail(w, 400, "INVALID_SEARCH", "Search is too long")
		return
	}
	tx, err := a.store.reader.BeginTx(r.Context(), &sql.TxOptions{ReadOnly: true})
	if err != nil {
		domainError(w, err)
		return
	}
	defer tx.Rollback()
	if _, err := readCatalogueAuthority(r.Context(), tx, p.UUID, bearer(r)); err != nil {
		domainError(w, err)
		return
	}
	if _, err := loadCatalogueLibrary(r.Context(), tx, id); err != nil {
		domainError(w, err)
		return
	}
	// An episode or track belongs to its show or album in the same library.
	from := ` FROM media_items i LEFT JOIN media_items p ON i.parent_id IS NOT NULL AND p.library_id=i.library_id AND p.external_id=i.parent_id AND p.parent_id IS NULL
	 WHERE i.library_id=? AND i.item_type IN ('movie','video','episode','track','music_video')`
	args := []any{id}
	// Search matches any text column, ignoring case: "mp4" finds MP4 files and
	// "hevc" finds HEVC video as well as titles containing the words.
	if search != "" {
		columns := []string{"i.title", "p.title", mediaInfoField("container"), mediaInfoField("video_codec"), mediaInfoField("video_resolution"), mediaInfoField("video_frame_rate"), mediaInfoField("audio_codec")}
		match := make([]string, len(columns))
		for n, column := range columns {
			match[n] = "instr(lower(coalesce(" + column + ",'')),lower(?))>0"
			args = append(args, search)
		}
		from += " AND (" + strings.Join(match, " OR ") + ")"
	}
	var total int
	if err := tx.QueryRowContext(r.Context(), "SELECT count(*)"+from, args...).Scan(&total); err != nil {
		domainError(w, err)
		return
	}
	order := mediaInfoSorts[sortKey]
	// Missing values sort last either way; ties keep a show's episodes in order.
	orderBy := " ORDER BY (" + order + ") IS NULL,(" + order + ") " + direction + ",coalesce(p.sort_title,p.title,i.sort_title,i.title) COLLATE NOCASE,i.season_number,i.episode_number,i.id"
	rows, err := tx.QueryContext(r.Context(), "SELECT i.id,i.item_type,i.title,p.id,p.title,i.season_number,i.episode_number,i.year,i.added_at,i.media_info,"+mediaInfoPlays+",nullif("+mediaInfoLastPlayed+",0)"+
		from+orderBy+" LIMIT ? OFFSET ?", append(args, size, (page-1)*size)...)
	if err != nil {
		domainError(w, err)
		return
	}
	defer rows.Close()
	items := []mediaInfoRow{}
	for rows.Next() {
		var row mediaInfoRow
		var parentID, season, episode, year sql.NullInt64
		var parentTitle, added, media sql.NullString
		var last sql.NullFloat64
		if err := rows.Scan(&row.ID, &row.Type, &row.Title, &parentID, &parentTitle, &season, &episode, &year, &added, &media, &row.Plays, &last); err != nil {
			domainError(w, err)
			return
		}
		if parentID.Valid {
			row.ParentID = &parentID.Int64
		}
		if parentTitle.Valid {
			row.ParentTitle = &parentTitle.String
		}
		if season.Valid {
			row.Season = &season.Int64
		}
		if episode.Valid {
			row.Episode = &episode.Int64
		}
		if year.Valid {
			row.Year = &year.Int64
		}
		if added.Valid && added.String != "" {
			row.AddedAt = &added.String
		}
		if media.Valid {
			var m provider.CatalogueMedia
			if json.Unmarshal([]byte(media.String), &m) != nil {
				domainError(w, ErrConflict)
				return
			}
			row.Media = m.Clean()
		}
		if last.Valid && last.Float64 > 0 {
			// Julian day 2440587.5 is the Unix epoch.
			at := utcTimestamp(time.UnixMilli(int64((last.Float64 - 2440587.5) * 86400000)).UTC())
			row.LastPlayed = &at
		}
		items = append(items, row)
	}
	if err := rows.Err(); err != nil {
		domainError(w, err)
		return
	}
	pages := max((total+size-1)/size, 1)
	respond(w, 200, map[string]any{"items": items, "pagination": map[string]int{"page": page, "page_size": size, "total_items": total, "total_pages": pages}})
}
