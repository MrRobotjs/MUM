package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"time"
	"unicode/utf8"
)

// Episode catalogues: one series' episodes, stored as media_items under the
// series' external ID. Sync follows the library catalogue rules: a complete,
// validated provider snapshot is read outside the writer and committed in one
// transaction against the series' episode revision and the server configuration
// it started from.

type catalogueShow struct {
	ID, Revision int64
	External     string
}

func loadCatalogueShow(ctx context.Context, tx *sql.Tx, library, item int64) (catalogueShow, error) {
	var s catalogueShow
	var kind string
	err := tx.QueryRowContext(ctx, "SELECT id,external_id,item_type,episode_revision FROM media_items WHERE id=? AND library_id=? AND parent_id IS NULL", item, library).Scan(&s.ID, &s.External, &kind, &s.Revision)
	if errors.Is(err, sql.ErrNoRows) {
		return s, ErrNotFound
	}
	if err == nil && kind != "show" {
		return s, errNotASeries
	}
	return s, err
}

var errNotASeries = errors.New("item is not a series")

func episodeDomainError(w http.ResponseWriter, err error) {
	if errors.Is(err, errCatalogueUnsupported) {
		fail(w, 409, "CATALOGUE_UNSUPPORTED", "Episode catalogues are available for Jellyfin, Emby and Plex")
		return
	}
	if errors.Is(err, errNotASeries) {
		fail(w, 409, "NOT_A_SERIES", "Episodes exist only for series")
		return
	}
	domainError(w, err)
}

func decodeEpisodeRevision(w http.ResponseWriter, r *http.Request) (*int64, bool) {
	var input struct {
		Revision *int64 `json:"expected_episode_revision"`
	}
	if r.ContentLength == 0 {
		return nil, true
	}
	if !decodeStrictBody(w, r, &input) {
		return nil, false
	}
	if input.Revision == nil || *input.Revision < 1 {
		fail(w, 400, "INVALID_REVISION", "Use a current episode revision")
		return nil, false
	}
	return input.Revision, true
}

func (a *App) syncEpisodeCatalogue(w http.ResponseWriter, r *http.Request) {
	p, ok := a.principal(w, r, true)
	if !ok {
		return
	}
	libraryID, ok := pathID(w, r, "library")
	if !ok {
		return
	}
	itemID, ok := pathID(w, r, "item")
	if !ok {
		return
	}
	expected, ok := decodeEpisodeRevision(w, r)
	if !ok {
		return
	}
	access := bearer(r)
	var library catalogueLibrary
	var show catalogueShow
	var apiKey, baseURL string
	err := func() error {
		tx, err := a.store.reader.BeginTx(r.Context(), &sql.TxOptions{ReadOnly: true})
		if err != nil {
			return err
		}
		defer tx.Rollback()
		if _, err = readCatalogueAuthority(r.Context(), tx, p.UUID, access); err != nil {
			return err
		}
		if library, err = loadCatalogueLibrary(r.Context(), tx, libraryID); err != nil {
			return err
		}
		if show, err = loadCatalogueShow(r.Context(), tx, libraryID, itemID); err != nil {
			return err
		}
		if err = tx.QueryRowContext(r.Context(), "SELECT url,coalesce(api_key,'') FROM media_servers WHERE id=?", library.Server).Scan(&baseURL, &apiKey); err != nil {
			return err
		}
		return tx.Commit()
	}()
	if err != nil {
		episodeDomainError(w, err)
		return
	}
	if !episodeCatalogueSupported(library.Provider) {
		episodeDomainError(w, errCatalogueUnsupported)
		return
	}
	if !library.Active || expected != nil && *expected != show.Revision {
		domainError(w, ErrConflict)
		return
	}
	a.catalogueMu.Lock()
	if a.catalogueRuns[libraryID] != nil {
		// The whole library is being synchronized, its episodes included.
		a.catalogueMu.Unlock()
		fail(w, 409, "CATALOGUE_SYNC_BUSY", "This library is synchronizing; try again when it finishes")
		return
	}
	if a.episodeRuns[itemID] || len(a.catalogueRuns)+len(a.episodeRuns) >= 2 {
		a.catalogueMu.Unlock()
		fail(w, 409, "CATALOGUE_SYNC_BUSY", "A catalogue synchronization is already running")
		return
	}
	a.episodeRuns[itemID] = true
	a.catalogueMu.Unlock()
	defer func() {
		a.catalogueMu.Lock()
		delete(a.episodeRuns, itemID)
		a.catalogueMu.Unlock()
	}()
	provider, err := newServerConnection(ProviderConfig{library.Provider, baseURL, apiKey}, a.ProviderHTTP)
	if err != nil {
		domainError(w, ErrConflict)
		return
	}
	result, err := a.syncShowEpisodes(r.Context(), p.UUID, access, library, provider, show, true)
	if err != nil {
		switch {
		case errors.Is(err, errEpisodeRead):
			fail(w, 502, "EPISODE_SYNC_FAILED", "Provider episode synchronization failed; previous episodes retained")
		case errors.Is(err, ErrConflict) || errors.Is(err, ErrForbidden) || errors.Is(err, ErrNotFound) || errors.Is(err, errNotASeries):
			episodeDomainError(w, err)
		default:
			fail(w, 500, "EPISODE_COMMIT_FAILED", "The episodes could not be saved; previous episodes retained")
		}
		return
	}
	message := "No changes detected"
	if result.Added+result.Updated+result.Removed > 0 {
		message = fmt.Sprintf("%d added, %d updated, %d removed", result.Added, result.Updated, result.Removed)
	}
	respond(w, 200, map[string]any{"success": true, "library_id": libraryID, "item_id": itemID, "source_revision": show.Revision, "revision": show.Revision + 1, "synced_at": result.SyncedAt, "message": message,
		"result": map[string]int{"added": result.Added, "updated": result.Updated, "removed": result.Removed, "total": result.Total}})
}

type episodeSyncResult struct {
	Added, Updated, Removed, Total int
	SyncedAt                       string
}

var (
	// errEpisodeRead: the provider's episode list could not be read completely.
	errEpisodeRead = errors.New("provider episode read failed")
	// errCatalogueLibraryChanged: the library or its server changed since the
	// sync began, so no further episodes of it are saved.
	errCatalogueLibraryChanged = fmt.Errorf("%w: library changed", ErrConflict)
)

// syncShowEpisodes saves one show's episodes: the provider's complete list is
// read outside the writer (at most a minute), then committed in one transaction
// that rechecks the caller's authority, the library's server configuration and
// the show's episode revision. Any failure leaves the saved episodes as they
// were. audit records the change; a library-wide run records one summary instead.
func (a *App) syncShowEpisodes(ctx context.Context, actor, access string, library catalogueLibrary, provider *serverConnection, show catalogueShow, audit bool) (episodeSyncResult, error) {
	var result episodeSyncResult
	read, cancel := context.WithTimeout(ctx, time.Minute)
	defer cancel()
	episodes, err := provider.catalogueEpisodes(read, show.External)
	if err != nil {
		return result, fmt.Errorf("%w: %w", errEpisodeRead, err)
	}
	result.Total = len(episodes)
	result.SyncedAt = utcTimestamp(time.Now())
	err = a.store.write(ctx, func(tx *sql.Tx) error {
		if _, err := readCatalogueAuthority(ctx, tx, actor, access); err != nil {
			return err
		}
		current, err := loadCatalogueLibrary(ctx, tx, library.ID)
		if err != nil {
			return err
		}
		if !current.Active || current.ConfigRevision != library.ConfigRevision || current.External != library.External {
			return errCatalogueLibraryChanged
		}
		currentShow, err := loadCatalogueShow(ctx, tx, library.ID, show.ID)
		if err != nil {
			return err
		}
		if currentShow.Revision != show.Revision || currentShow.External != show.External {
			return ErrConflict
		}
		existing := map[string]int64{}
		rows, err := tx.QueryContext(ctx, "SELECT id,external_id FROM media_items WHERE library_id=? AND parent_id=?", library.ID, show.External)
		if err != nil {
			return err
		}
		for rows.Next() {
			var row int64
			var external string
			if err := rows.Scan(&row, &external); err != nil {
				rows.Close()
				return err
			}
			existing[external] = row
		}
		if err := errors.Join(rows.Err(), rows.Close()); err != nil {
			return err
		}
		if result.Added, result.Updated, err = upsertCatalogueItems(ctx, tx, library.ID, current.Server, show.External, episodes, existing, result.SyncedAt); err != nil {
			return err
		}
		for _, row := range existing {
			if _, err := tx.ExecContext(ctx, "DELETE FROM media_items WHERE id=?", row); err != nil {
				return err
			}
			result.Removed++
		}
		if _, err := tx.ExecContext(ctx, "UPDATE media_items SET episode_revision=episode_revision+1,episodes_synced_at=?,episode_count=? WHERE id=?", result.SyncedAt, len(episodes), show.ID); err != nil {
			return err
		}
		if !audit {
			return nil
		}
		details, _ := json.Marshal(map[string]any{"library_id": library.ID, "item_id": show.ID, "source_revision": show.Revision, "added": result.Added, "updated": result.Updated, "removed": result.Removed, "total": len(episodes)})
		_, err = tx.ExecContext(ctx, "INSERT INTO audit_events(actor_uuid,action,details,occurred_at) VALUES(?,'library.episodes.sync',?,?)", actor, string(details), result.SyncedAt)
		return err
	})
	return result, err
}

func (a *App) purgeEpisodeCatalogue(w http.ResponseWriter, r *http.Request) {
	p, ok := a.principal(w, r, true)
	if !ok {
		return
	}
	libraryID, ok := pathID(w, r, "library")
	if !ok {
		return
	}
	itemID, ok := pathID(w, r, "item")
	if !ok {
		return
	}
	expected, ok := decodeEpisodeRevision(w, r)
	if !ok {
		return
	}
	a.catalogueMu.Lock()
	busy := a.episodeRuns[itemID] || a.catalogueRuns[libraryID] != nil
	a.catalogueMu.Unlock()
	if busy {
		fail(w, 409, "CATALOGUE_SYNC_BUSY", "An episode synchronization is running")
		return
	}
	var deleted, revision int64
	access := bearer(r)
	err := a.store.write(r.Context(), func(tx *sql.Tx) error {
		if _, err := readCatalogueAuthority(r.Context(), tx, p.UUID, access); err != nil {
			return err
		}
		library, err := loadCatalogueLibrary(r.Context(), tx, libraryID)
		if err != nil {
			return err
		}
		if !episodeCatalogueSupported(library.Provider) {
			return errCatalogueUnsupported
		}

		show, err := loadCatalogueShow(r.Context(), tx, libraryID, itemID)
		if err != nil {
			return err
		}
		if expected != nil && *expected != show.Revision {
			return ErrConflict
		}
		result, err := tx.ExecContext(r.Context(), "DELETE FROM media_items WHERE library_id=? AND parent_id=?", libraryID, show.External)
		if err != nil {
			return err
		}
		if deleted, err = result.RowsAffected(); err != nil {
			return err
		}
		if _, err = tx.ExecContext(r.Context(), "UPDATE media_items SET episode_revision=episode_revision+1,episodes_synced_at=NULL,episode_count=NULL WHERE id=?", itemID); err != nil {
			return err
		}
		revision = show.Revision + 1
		details, _ := json.Marshal(map[string]any{"library_id": libraryID, "item_id": itemID, "source_revision": show.Revision, "deleted": deleted})
		_, err = tx.ExecContext(r.Context(), "INSERT INTO audit_events(actor_uuid,action,details,occurred_at) VALUES(?,'library.episodes.purge',?,?)", p.UUID, string(details), utcTimestamp(time.Now()))
		return err
	})
	if err != nil {
		episodeDomainError(w, err)
		return
	}
	respond(w, 200, map[string]any{"success": true, "library_id": libraryID, "item_id": itemID, "deleted_count": deleted, "revision": revision})
}

var episodeSorts = map[string]string{
	"season_episode_asc":  "i.season_number IS NULL,i.season_number ASC,i.episode_number IS NULL,i.episode_number ASC,i.id ASC",
	"season_episode_desc": "i.season_number IS NULL,i.season_number DESC,i.episode_number IS NULL,i.episode_number DESC,i.id DESC",
	"title_asc":           "i.sort_title COLLATE NOCASE ASC,i.id ASC", "title_desc": "i.sort_title COLLATE NOCASE DESC,i.id DESC",
	"year_desc": "i.year IS NULL,i.year DESC,i.id DESC", "year_asc": "i.year IS NULL,i.year ASC,i.id ASC",
	"added_at_desc": "i.added_at IS NULL,i.added_at DESC,i.id DESC", "added_at_asc": "i.added_at IS NULL,i.added_at ASC,i.id ASC",
}

func (a *App) listEpisodeCatalogue(w http.ResponseWriter, r *http.Request) {
	p, ok := a.principal(w, r, true)
	if !ok {
		return
	}
	libraryID, ok := pathID(w, r, "library")
	if !ok {
		return
	}
	itemID, ok := pathID(w, r, "item")
	if !ok {
		return
	}
	query := r.URL.Query()
	page, size := 1, 24
	for key, target := range map[string]*int{"page": &page, "page_size": &size} {
		if raw := query.Get(key); raw != "" {
			n, err := strconv.Atoi(raw)
			if err != nil || n < 1 || key == "page" && n > 100000 || key == "page_size" && n > 100 {
				fail(w, 400, "INVALID_PAGE", "Use a positive page and a page size from 1 to 100")
				return
			}
			*target = n
		}
	}
	order := episodeSorts["season_episode_asc"]
	if raw := query.Get("sort_by"); raw != "" {
		if order, ok = episodeSorts[raw]; !ok {
			fail(w, 400, "SORT_UNAVAILABLE", "This sort order is not available for episodes")
			return
		}
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
	session, err := readCatalogueAuthority(r.Context(), tx, p.UUID, bearer(r))
	if err != nil {
		domainError(w, err)
		return
	}
	library, err := loadCatalogueLibrary(r.Context(), tx, libraryID)
	if err != nil {
		domainError(w, err)
		return
	}
	show, err := loadCatalogueShow(r.Context(), tx, libraryID, itemID)
	if err != nil {
		episodeDomainError(w, err)
		return
	}
	var synced sql.NullString
	if err := tx.QueryRowContext(r.Context(), "SELECT episodes_synced_at FROM media_items WHERE id=?", itemID).Scan(&synced); err != nil {
		domainError(w, err)
		return
	}
	where, args := " WHERE i.library_id=? AND i.parent_id=?", []any{libraryID, show.External}
	if search != "" {
		where += " AND instr(lower(i.title),lower(?))>0"
		args = append(args, search)
	}
	var total int
	if err := tx.QueryRowContext(r.Context(), "SELECT count(*) FROM media_items i"+where, args...).Scan(&total); err != nil {
		domainError(w, err)
		return
	}
	rows, err := tx.QueryContext(r.Context(), "SELECT i.id,i.title,i.season_number,i.episode_number,i.year,i.rating,i.duration,coalesce(i.thumb_path,''),coalesce(i.added_at,'') FROM media_items i"+where+" ORDER BY "+order+" LIMIT ? OFFSET ?", append(args, size, (page-1)*size)...)
	if err != nil {
		domainError(w, err)
		return
	}
	defer rows.Close()
	now := time.Now()
	episodes := []map[string]any{}
	for rows.Next() {
		var id int64
		var title, tag, added string
		var season, number, year, duration sql.NullInt64
		var rating sql.NullFloat64
		if err := rows.Scan(&id, &title, &season, &number, &year, &rating, &duration, &tag, &added); err != nil {
			domainError(w, err)
			return
		}
		row := map[string]any{"id": id, "title": title, "season_number": nullableCount(season), "episode_number": nullableCount(number), "year": nullableCount(year), "rating": nil, "duration": nullableCount(duration), "added_at": nullableText(added)}
		if rating.Valid {
			row["rating"] = rating.Float64
		}
		if tag != "" && library.Active {
			row["thumb"] = a.catalogueImageURL(session, id, now)
		}
		episodes = append(episodes, row)
	}
	if rows.Err() != nil {
		domainError(w, rows.Err())
		return
	}
	pages := (total + size - 1) / size
	if pages == 0 {
		pages = 1
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"data": map[string]any{"episodes": episodes, "episode_revision": show.Revision, "episodes_synced_at": nullableText(synced.String)},
		"meta": map[string]any{"pagination": map[string]int{"page": page, "page_size": size, "total_items": total, "total_pages": pages}}})
}
