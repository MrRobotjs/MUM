package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

// Child catalogues: a series' episodes or an album's tracks, stored as
// media_items under the parent's external ID. Sync follows the library
// catalogue rules: a complete, validated provider snapshot is read outside the
// writer and committed in one transaction against the parent's child revision
// (the episode_revision column) and the server configuration it started from.

// childCatalogue is one kind of child list: which parent item type has it,
// its plural noun (also its route segment and list key) and the refusal for
// any other parent.
type childCatalogue struct {
	Parent, Noun, Code, Message string
}

var (
	episodeChildren = childCatalogue{Parent: "show", Noun: "episodes", Code: "NOT_A_SERIES", Message: "Episodes exist only for series"}
	trackChildren   = childCatalogue{Parent: "album", Noun: "tracks", Code: "NOT_AN_ALBUM", Message: "Tracks exist only for albums"}
)

// childrenOf returns the child list a parent item type has.
func childrenOf(itemType string) (childCatalogue, bool) {
	switch itemType {
	case episodeChildren.Parent:
		return episodeChildren, true
	case trackChildren.Parent:
		return trackChildren, true
	}
	return childCatalogue{}, false
}

// childCatalogueSupported reports whether a service's module reads this
// child list.
func childCatalogueSupported(provider string, c childCatalogue) bool {
	switch c.Noun {
	case "episodes":
		_, ok := moduleRules(provider).(episodeReader)
		return ok
	case "tracks":
		_, ok := moduleRules(provider).(trackReader)
		return ok
	}
	return false
}

// catalogueChildren reads one parent's complete child snapshot.
func (p *serverConnection) catalogueChildren(ctx context.Context, c childCatalogue, parent string) ([]catalogueItem, error) {
	switch c.Noun {
	case "episodes":
		if m, ok := p.module().(episodeReader); ok {
			return m.CatalogueEpisodes(ctx, parent)
		}
	case "tracks":
		if m, ok := p.module().(trackReader); ok {
			return m.CatalogueTracks(ctx, parent)
		}
	}
	return nil, errCatalogueUnsupported
}

type catalogueShow struct {
	ID, Revision int64
	External     string
	// Kind is the parent's item type ("show" or "album").
	Kind string
}

func loadCatalogueParent(ctx context.Context, tx *sql.Tx, c childCatalogue, library, item int64) (catalogueShow, error) {
	var s catalogueShow
	err := tx.QueryRowContext(ctx, "SELECT id,external_id,item_type,episode_revision FROM media_items WHERE id=? AND library_id=? AND parent_id IS NULL", item, library).Scan(&s.ID, &s.External, &s.Kind, &s.Revision)
	if errors.Is(err, sql.ErrNoRows) {
		return s, ErrNotFound
	}
	if err == nil && s.Kind != c.Parent {
		return s, errWrongParent
	}
	return s, err
}

var errWrongParent = errors.New("item does not have this kind of child")

func childDomainError(w http.ResponseWriter, c childCatalogue, err error) {
	if errors.Is(err, errCatalogueUnsupported) {
		fail(w, 409, "CATALOGUE_UNSUPPORTED", fmt.Sprintf("%s%s catalogues are available for Jellyfin, Emby and Plex", strings.ToUpper(c.Noun[:1]), c.Noun[1:len(c.Noun)-1]))
		return
	}
	if errors.Is(err, errWrongParent) {
		fail(w, 409, c.Code, c.Message)
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

func (a *App) syncChildCatalogue(w http.ResponseWriter, r *http.Request, c childCatalogue) {
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
		if show, err = loadCatalogueParent(r.Context(), tx, c, libraryID, itemID); err != nil {
			return err
		}
		if err = tx.QueryRowContext(r.Context(), "SELECT url,coalesce(api_key,'') FROM media_servers WHERE id=?", library.Server).Scan(&baseURL, &apiKey); err != nil {
			return err
		}
		return tx.Commit()
	}()
	if err != nil {
		childDomainError(w, c, err)
		return
	}
	if !childCatalogueSupported(library.Provider, c) {
		childDomainError(w, c, errCatalogueUnsupported)
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
	result, err := a.syncChildren(r.Context(), c, p.UUID, access, library, provider, show, true)
	if err != nil {
		switch {
		case errors.Is(err, errEpisodeRead):
			fail(w, 502, "EPISODE_SYNC_FAILED", "Provider synchronization failed; previous "+c.Noun+" retained")
		case errors.Is(err, ErrConflict) || errors.Is(err, ErrForbidden) || errors.Is(err, ErrNotFound) || errors.Is(err, errWrongParent):
			childDomainError(w, c, err)
		default:
			fail(w, 500, "EPISODE_COMMIT_FAILED", "The "+c.Noun+" could not be saved; previous "+c.Noun+" retained")
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
func (a *App) syncChildren(ctx context.Context, c childCatalogue, actor, access string, library catalogueLibrary, provider *serverConnection, show catalogueShow, audit bool) (episodeSyncResult, error) {
	var result episodeSyncResult
	read, cancel := context.WithTimeout(ctx, time.Minute)
	defer cancel()
	episodes, err := provider.catalogueChildren(read, c, show.External)
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
		currentShow, err := loadCatalogueParent(ctx, tx, c, library.ID, show.ID)
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
		_, err = tx.ExecContext(ctx, "INSERT INTO audit_events(actor_uuid,action,details,occurred_at) VALUES(?,?,?,?)", actor, "library."+c.Noun+".sync", string(details), result.SyncedAt)
		return err
	})
	return result, err
}

func (a *App) purgeChildCatalogue(w http.ResponseWriter, r *http.Request, c childCatalogue) {
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
		if !childCatalogueSupported(library.Provider, c) {
			return errCatalogueUnsupported
		}

		show, err := loadCatalogueParent(r.Context(), tx, c, libraryID, itemID)
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
		_, err = tx.ExecContext(r.Context(), "INSERT INTO audit_events(actor_uuid,action,details,occurred_at) VALUES(?,?,?,?)", p.UUID, "library."+c.Noun+".purge", string(details), utcTimestamp(time.Now()))
		return err
	})
	if err != nil {
		childDomainError(w, c, err)
		return
	}
	respond(w, 200, map[string]any{"success": true, "library_id": libraryID, "item_id": itemID, "deleted_count": deleted, "revision": revision})
}

// catalogueEpisodeItem returns one saved episode of a show for its page,
// with the show it belongs to.
func (a *App) catalogueEpisodeItem(w http.ResponseWriter, r *http.Request) {
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
	episodeID, ok := pathID(w, r, "episode")
	if !ok {
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
	show, err := loadCatalogueParent(r.Context(), tx, episodeChildren, libraryID, itemID)
	if err != nil {
		childDomainError(w, episodeChildren, err)
		return
	}
	var showTitle string
	if err := tx.QueryRowContext(r.Context(), "SELECT title FROM media_items WHERE id=?", show.ID).Scan(&showTitle); err != nil {
		domainError(w, err)
		return
	}
	var id, streams int64
	var external, title, sortTitle, added, synced string
	var season, number, year, duration sql.NullInt64
	var rating sql.NullFloat64
	var summary, tag sql.NullString
	err = tx.QueryRowContext(r.Context(), "SELECT i.id,i.external_id,i.title,coalesce(i.sort_title,i.title),i.season_number,i.episode_number,i.year,i.rating,i.duration,i.summary,i.thumb_path,coalesce(i.added_at,''),coalesce(i.last_synced,''),"+episodeStreamCount+
		" FROM media_items i WHERE i.id=? AND i.library_id=? AND i.parent_id=?", episodeID, libraryID, show.External).
		Scan(&id, &external, &title, &sortTitle, &season, &number, &year, &rating, &duration, &summary, &tag, &added, &synced, &streams)
	if errors.Is(err, sql.ErrNoRows) {
		domainError(w, ErrNotFound)
		return
	}
	if err != nil {
		domainError(w, err)
		return
	}
	libraryInfo, err := catalogueLibraryInfo(r.Context(), tx, library)
	if err != nil {
		domainError(w, err)
		return
	}
	episode := map[string]any{"id": id, "external_id": external, "title": title, "sort_title": sortTitle, "item_type": "episode",
		"season_number": nullableCount(season), "episode_number": nullableCount(number), "year": nullableCount(year), "rating": nil, "duration": nullableCount(duration),
		"summary": summary.String, "thumb": "", "added_at": added, "last_synced": synced, "stream_count": streams,
		"show": map[string]any{"id": show.ID, "title": showTitle}, "library": libraryInfo}
	if rating.Valid {
		episode["rating"] = rating.Float64
	}
	if tag.Valid && tag.String != "" && library.Active {
		episode["thumb"] = a.catalogueImageURL(session, id, time.Now())
	}
	respond(w, 200, episode)
}

var episodeSorts = map[string]string{
	"season_episode_asc":  "i.season_number IS NULL,i.season_number ASC,i.episode_number IS NULL,i.episode_number ASC,i.item_type='music_video',i.id ASC",
	"season_episode_desc": "i.season_number IS NULL,i.season_number DESC,i.episode_number IS NULL,i.episode_number DESC,i.item_type='music_video',i.id DESC",
	"title_asc":           "i.sort_title COLLATE NOCASE ASC,i.id ASC", "title_desc": "i.sort_title COLLATE NOCASE DESC,i.id DESC",
	"year_desc": "i.year IS NULL,i.year DESC,i.id DESC", "year_asc": "i.year IS NULL,i.year ASC,i.id ASC",
	"added_at_desc": "i.added_at IS NULL,i.added_at DESC,i.id DESC", "added_at_asc": "i.added_at IS NULL,i.added_at ASC,i.id ASC",
	"total_streams_desc": "stream_count DESC,i.season_number IS NULL,i.season_number ASC,i.episode_number IS NULL,i.episode_number ASC,i.id ASC",
	"total_streams_asc":  "stream_count ASC,i.season_number IS NULL,i.season_number ASC,i.episode_number IS NULL,i.episode_number ASC,i.id ASC",
}

// episodeStreamCount counts the retained plays of episode i on its server.
const episodeStreamCount = "(SELECT count(*) FROM media_activity_history h WHERE h.server_id=i.server_id AND h.item_id=i.external_id)"

func (a *App) listChildCatalogue(w http.ResponseWriter, r *http.Request, c childCatalogue) {
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
	show, err := loadCatalogueParent(r.Context(), tx, c, libraryID, itemID)
	if err != nil {
		childDomainError(w, c, err)
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
	rows, err := tx.QueryContext(r.Context(), "SELECT i.id,i.title,i.item_type,i.season_number,i.episode_number,i.year,i.rating,i.duration,coalesce(i.thumb_path,''),coalesce(i.added_at,''),"+episodeStreamCount+" AS stream_count FROM media_items i"+where+" ORDER BY "+order+" LIMIT ? OFFSET ?", append(args, size, (page-1)*size)...)
	if err != nil {
		domainError(w, err)
		return
	}
	defer rows.Close()
	now := time.Now()
	episodes := []map[string]any{}
	for rows.Next() {
		var id, streams int64
		var title, kind, tag, added string
		var season, number, year, duration sql.NullInt64
		var rating sql.NullFloat64
		if err := rows.Scan(&id, &title, &kind, &season, &number, &year, &rating, &duration, &tag, &added, &streams); err != nil {
			domainError(w, err)
			return
		}
		row := map[string]any{"id": id, "title": title, "item_type": kind, "season_number": nullableCount(season), "episode_number": nullableCount(number), "year": nullableCount(year), "rating": nil, "duration": nullableCount(duration), "added_at": nullableText(added), "stream_count": streams}
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
		"data": map[string]any{c.Noun: episodes, "episode_revision": show.Revision, "episodes_synced_at": nullableText(synced.String)},
		"meta": map[string]any{"pagination": map[string]int{"page": page, "page_size": size, "total_items": total, "total_pages": pages}}})
}
