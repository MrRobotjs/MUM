package main

import (
	"app/server/providers/provider"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"time"
	"unicode/utf8"
)

// Library item catalogue: a durable, per-library copy of a provider's top-level
// items. Jellyfin/Emby and Plex movie/show sections are supported; Plex
// collections are saved alongside (library_collections.go). A sync reads the complete
// provider snapshot outside the writer, then commits it in one short transaction
// against the catalogue revision and server configuration it started from.

const (
	catalogueMaxItems = provider.CatalogueMaxItems
	// One series is capped well below a library.
	catalogueMaxEpisodes = provider.CatalogueMaxEpisodes
	cataloguePageSize    = provider.CataloguePageSize
	catalogueImageTTL    = 10 * time.Minute
	catalogueImageMax    = provider.CatalogueImageMax
)

var errCatalogueUnsupported = provider.ErrCatalogueUnsupported

// Catalogue support comes from what each service's module implements.
func catalogueSupported(kind string) bool {
	_, ok := moduleRules(kind).(catalogueReader)
	return ok
}
func catalogueLibrarySupported(kind, libraryKind, external string) bool {
	if rule, ok := moduleRules(kind).(catalogueLibraryRule); ok {
		return rule.CatalogueLibrarySupported(libraryKind, external)
	}
	return catalogueSupported(kind)
}

func truncateRunes(v string, max int) string { return provider.TruncateRunes(v, max) }

// The catalogue reads below dispatch to the server's module.

// catalogueItems reads one library's complete item snapshot.
func (p *serverConnection) catalogueItems(ctx context.Context, library, kind string, progress func(fetched, total int)) ([]catalogueItem, error) {
	m, ok := p.module().(catalogueReader)
	if !ok {
		return nil, errCatalogueUnsupported
	}
	return m.CatalogueItems(ctx, library, kind, progress)
}

// catalogueCollections reads one library's complete collection snapshot.
func (p *serverConnection) catalogueCollections(ctx context.Context, library, kind string) ([]catalogueCollection, error) {
	m, ok := p.module().(collectionReader)
	if !ok {
		return nil, errCatalogueUnsupported
	}
	return m.CatalogueCollections(ctx, library, kind)
}

// catalogueImage fetches one bounded item poster.
func (p *serverConnection) catalogueImage(ctx context.Context, item, tag string) (string, []byte, error) {
	m, ok := p.module().(catalogueImageReader)
	if !ok {
		return "", nil, errCatalogueUnsupported
	}
	return m.CatalogueImage(ctx, item, tag)
}

// collectionImage fetches one bounded collection poster.
func (p *serverConnection) collectionImage(ctx context.Context, collection, poster string) (string, []byte, error) {
	m, ok := p.module().(collectionImageReader)
	if !ok {
		return "", nil, errCatalogueUnsupported
	}
	return m.CollectionImage(ctx, collection, poster)
}

// Image URLs are signed for one session and item with a short expiry and a
// per-process key; every fetch re-authorizes the session and its permission.
// The purpose separates item and collection links, whose row IDs overlap.
const (
	itemImagePurpose       = "catalogue-image"
	collectionImagePurpose = "collection-image"
)

func (a *App) signCatalogueImage(purpose, session string, id int64, expires int64) string {
	mac := hmac.New(sha256.New, a.imageKey)
	fmt.Fprintf(mac, "%s|%s|%d|%d", purpose, session, id, expires)
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}
func (a *App) signedImageURL(purpose, route, session string, id int64, now time.Time) string {
	expires := now.Add(catalogueImageTTL).Unix()
	return fmt.Sprintf("%s/%d?%s", route, id, url.Values{"s": {session}, "e": {strconv.FormatInt(expires, 10)}, "g": {a.signCatalogueImage(purpose, session, id, expires)}}.Encode())
}
func (a *App) catalogueImageURL(session string, item int64, now time.Time) string {
	return a.signedImageURL(itemImagePurpose, "/api/media/images", session, item, now)
}

type catalogueProgress struct {
	Started  string
	ActorID  int64
	Actor    string
	Fetched  int
	Total    int
	Finished bool
	// Phase is "shows" while the item list is read and "episodes" while a
	// "TV Shows + Episodes" run works through the library's shows.
	Phase                              string
	ShowsDone, ShowsTotal, ShowsFailed int
}

func (a *App) catalogueProgressUpdate(library int64, update func(*catalogueProgress)) {
	a.catalogueMu.Lock()
	defer a.catalogueMu.Unlock()
	if run := a.catalogueRuns[library]; run != nil {
		update(run)
	}
}

type catalogueLibrary struct {
	ID, Server, Revision, ConfigRevision int64
	External, Name, Kind, Provider       string
	Active                               bool
}

func loadCatalogueLibrary(ctx context.Context, tx *sql.Tx, library int64) (catalogueLibrary, error) {
	var l catalogueLibrary
	err := tx.QueryRowContext(ctx, `SELECT l.id,l.server_id,l.catalogue_revision,s.config_revision,l.external_id,l.name,coalesce(l.library_type,''),s.service_type,(s.is_active=1 AND coalesce(p.enabled,0)=1)
	 FROM media_libraries l JOIN media_servers s ON s.id=l.server_id LEFT JOIN provider_settings p ON p.provider_id=s.service_type WHERE l.id=? AND l.is_available=1`, library).Scan(&l.ID, &l.Server, &l.Revision, &l.ConfigRevision, &l.External, &l.Name, &l.Kind, &l.Provider, &l.Active)
	if errors.Is(err, sql.ErrNoRows) {
		return l, ErrNotFound
	}
	return l, err
}

// readCatalogueAuthority checks the caller's live session and administrator
// permission and returns the session ID used to sign image URLs.
func readCatalogueAuthority(ctx context.Context, tx *sql.Tx, actor, access string) (string, error) {
	if err := accountPreferenceAuthority(ctx, tx, actor, access); err != nil {
		return "", err
	}
	if err := requirePermission(ctx, tx, actor, "administrator"); err != nil {
		return "", err
	}
	var session string
	err := tx.QueryRowContext(ctx, "SELECT session_id FROM session_access_tokens WHERE token_hash=?", tokenHash(access)).Scan(&session)
	return session, err
}

func (a *App) syncLibraryCatalogue(w http.ResponseWriter, r *http.Request) {
	p, ok := a.principal(w, r, true)
	if !ok {
		return
	}
	id, ok := pathID(w, r, "library")
	if !ok {
		return
	}
	var input struct {
		Revision *int64 `json:"expected_catalogue_revision"`
	}
	if r.ContentLength != 0 {
		if !decodeStrictBody(w, r, &input) {
			return
		}
		if input.Revision == nil || *input.Revision < 1 {
			fail(w, 400, "INVALID_REVISION", "Use a current catalogue revision")
			return
		}
	}
	syncEpisodes := false
	switch r.URL.Query().Get("sync_episodes") {
	case "", "false":
	case "true":
		syncEpisodes = true
	default:
		fail(w, 400, "INVALID_SYNC_EPISODES", "sync_episodes must be true or false")
		return
	}
	access := bearer(r)
	var library catalogueLibrary
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
		if library, err = loadCatalogueLibrary(r.Context(), tx, id); err != nil {
			return err
		}
		if err = tx.QueryRowContext(r.Context(), "SELECT url,coalesce(api_key,'') FROM media_servers WHERE id=?", library.Server).Scan(&baseURL, &apiKey); err != nil {
			return err
		}
		return tx.Commit()
	}()
	if err != nil {
		domainError(w, err)
		return
	}
	if !catalogueLibrarySupported(library.Provider, library.Kind, library.External) {
		fail(w, 409, "CATALOGUE_UNSUPPORTED", "Item catalogues support Jellyfin, Emby and Plex movie/show libraries")
		return
	}
	if syncEpisodes && !childCatalogueSupported(library.Provider, episodeChildren) && !childCatalogueSupported(library.Provider, trackChildren) {
		childDomainError(w, episodeChildren, errCatalogueUnsupported)
		return
	}
	if !library.Active || input.Revision != nil && *input.Revision != library.Revision {
		domainError(w, ErrConflict)
		return
	}
	a.catalogueMu.Lock()
	if a.catalogueClosing {
		a.catalogueMu.Unlock()
		fail(w, 503, "SHUTTING_DOWN", "MUM is shutting down")
		return
	}
	if a.catalogueRuns[id] != nil || len(a.catalogueRuns)+len(a.episodeRuns) >= 2 {
		a.catalogueMu.Unlock()
		fail(w, 409, "CATALOGUE_SYNC_BUSY", "A catalogue synchronization is already running")
		return
	}
	a.catalogueRuns[id] = &catalogueProgress{Started: utcTimestamp(time.Now()), ActorID: p.ID, Actor: p.Username, Phase: "shows"}
	a.catalogueMu.Unlock()
	// An episode run takes the library's progress entry over and removes it
	// itself when it finishes.
	handedOff := false
	defer func() {
		if handedOff {
			return
		}
		a.catalogueMu.Lock()
		delete(a.catalogueRuns, id)
		a.catalogueMu.Unlock()
	}()
	provider, err := newServerConnection(ProviderConfig{library.Provider, baseURL, apiKey}, a.ProviderHTTP)
	if err != nil {
		domainError(w, ErrConflict)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Minute)
	defer cancel()

	progress := func(fetched, total int) {
		a.catalogueProgressUpdate(id, func(run *catalogueProgress) { run.Fetched, run.Total = fetched, total })
	}
	var items []catalogueItem
	var collections []catalogueCollection
	items, err = provider.catalogueItems(ctx, library.External, library.Kind, progress)
	if err == nil && collectionsSupported(library.Provider, library.Kind, library.External) {
		// Collections are part of the same complete snapshot: if they cannot
		// be read, neither list is saved.
		collections, err = provider.catalogueCollections(ctx, library.External, library.Kind)
	}
	if err != nil {
		fail(w, 502, "CATALOGUE_SYNC_FAILED", "Provider catalogue synchronization failed; previous catalogue retained")
		return
	}
	added, updated, removed := 0, 0, 0
	now := utcTimestamp(time.Now())
	err = a.store.write(ctx, func(tx *sql.Tx) error {
		if _, err := readCatalogueAuthority(ctx, tx, p.UUID, access); err != nil {
			return err
		}
		current, err := loadCatalogueLibrary(ctx, tx, id)
		if err != nil {
			return err
		}
		if !current.Active || current.Revision != library.Revision || current.ConfigRevision != library.ConfigRevision || current.External != library.External || current.Kind != library.Kind {
			return ErrConflict
		}
		existing := map[string]int64{}
		rows, err := tx.QueryContext(ctx, "SELECT id,external_id FROM media_items WHERE library_id=? AND parent_id IS NULL", id)
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
		if added, updated, err = upsertCatalogueItems(ctx, tx, id, current.Server, "", items, existing, now); err != nil {
			return err
		}
		for external, row := range existing {
			// A removed series takes its cached episodes with it.
			if _, err := tx.ExecContext(ctx, "DELETE FROM media_items WHERE library_id=? AND parent_id=?", id, external); err != nil {
				return err
			}
			if _, err := tx.ExecContext(ctx, "DELETE FROM media_items WHERE id=?", row); err != nil {
				return err
			}
			removed++
		}
		if collections != nil {
			if err := replaceCatalogueCollections(ctx, tx, id, collections, now); err != nil {
				return err
			}
		}
		if _, err := tx.ExecContext(ctx, "UPDATE media_libraries SET catalogue_revision=catalogue_revision+1,catalogue_synced_at=?,catalogue_item_count=? WHERE id=?", now, len(items), id); err != nil {
			return err
		}
		details, _ := json.Marshal(map[string]any{"library_id": id, "source_revision": library.Revision, "added": added, "updated": updated, "removed": removed, "total": len(items), "collections": len(collections)})
		_, err = tx.ExecContext(ctx, "INSERT INTO audit_events(actor_uuid,action,details,occurred_at) VALUES(?,'library.catalogue.sync',?,?)", p.UUID, string(details), now)
		return err
	})
	if err != nil {
		if errors.Is(err, ErrConflict) || errors.Is(err, ErrForbidden) || errors.Is(err, ErrNotFound) {
			domainError(w, err)
		} else {
			fail(w, 500, "CATALOGUE_COMMIT_FAILED", "The catalogue could not be saved; previous catalogue retained")
		}
		return
	}
	message := "No changes detected"
	if added+updated+removed > 0 {
		message = fmt.Sprintf("%d added, %d updated, %d removed", added, updated, removed)
	}
	response := map[string]any{"success": true, "library_id": id, "source_revision": library.Revision, "revision": library.Revision + 1, "synced_at": now, "message": message,
		"result": map[string]int{"added": added, "updated": updated, "removed": removed, "total": len(items)}}
	if syncEpisodes {
		// The shows are saved; their episodes follow in the background, show
		// by show, with progress on the library's sync status.
		episodes := map[string]any{"started": false, "shows": 0}
		if shows, err := a.catalogueShows(context.WithoutCancel(r.Context()), id); err != nil {
			a.logger.Warn("Library episode synchronization could not start", "library_id", id, "error", err)
		} else if a.startLibraryEpisodes(id, p.UUID, access, library, provider, shows) {
			handedOff = true
			episodes = map[string]any{"started": true, "shows": len(shows)}
		}
		response["episodes"] = episodes
	}
	respond(w, 200, response)
}

// catalogueShows lists a library's saved shows, in title order, for an episode run.
func (a *App) catalogueShows(ctx context.Context, library int64) ([]catalogueShow, error) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	rows, err := a.store.reader.QueryContext(ctx, "SELECT id,external_id,episode_revision,item_type FROM media_items WHERE library_id=? AND parent_id IS NULL AND item_type IN ('show','album') ORDER BY sort_title COLLATE NOCASE,id", library)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	shows := []catalogueShow{}
	for rows.Next() {
		var show catalogueShow
		if err := rows.Scan(&show.ID, &show.External, &show.Revision, &show.Kind); err != nil {
			return nil, err
		}
		shows = append(shows, show)
	}
	return shows, rows.Err()
}

// libraryEpisodeRunLimit bounds one library-wide episode run; each show's
// read is bounded separately (syncShowEpisodes).
const libraryEpisodeRunLimit = 2 * time.Hour

// startLibraryEpisodes hands the library's progress entry to a tracked
// background run that saves each show's episodes in turn. It reports false,
// leaving the entry with the caller, while MUM is shutting down.
func (a *App) startLibraryEpisodes(id int64, actor, access string, library catalogueLibrary, provider *serverConnection, shows []catalogueShow) bool {
	a.catalogueMu.Lock()
	defer a.catalogueMu.Unlock()
	if a.catalogueClosing || a.catalogueRuns[id] == nil {
		return false
	}
	run := a.catalogueRuns[id]
	run.Phase, run.ShowsTotal = "episodes", len(shows)
	delete(a.episodeOutcomes, id)
	a.catalogueWG.Add(1)
	go func() {
		defer a.catalogueWG.Done()
		a.runLibraryEpisodes(id, actor, access, library, provider, shows)
	}()
	return true
}

// runLibraryEpisodes saves each show's episodes, one short transaction per
// show, so a stop keeps every show finished so far. A show that cannot be read
// or saved keeps its previous episodes and the run moves on; a changed
// library or server, lost authority, shutdown or the time limit stops the
// run. The outcome is kept for the library's sync status and audited once.
func (a *App) runLibraryEpisodes(id int64, actor, access string, library catalogueLibrary, provider *serverConnection, shows []catalogueShow) {
	ctx, cancel := context.WithTimeout(a.catalogueCtx, libraryEpisodeRunLimit)
	defer cancel()
	synced, failed, skipped, added, updated, removed := 0, 0, 0, 0, 0, 0
	stopped := ""
	for i, show := range shows {
		if ctx.Err() != nil {
			break
		}
		c, _ := childrenOf(show.Kind)
		if !childCatalogueSupported(library.Provider, c) {
			skipped++
			a.catalogueProgressUpdate(id, func(run *catalogueProgress) { run.ShowsDone = i + 1 })
			continue
		}
		result, err := a.syncChildren(ctx, c, actor, access, library, provider, show, false)
		switch {
		case err == nil:
			synced++
			added, updated, removed = added+result.Added, updated+result.Updated, removed+result.Removed
		case ctx.Err() != nil:
		case errors.Is(err, errCatalogueLibraryChanged):
			stopped = "library_changed"
		case errors.Is(err, ErrForbidden):
			stopped = "forbidden"
		case errors.Is(err, ErrNotFound) || errors.Is(err, errWrongParent):
			// The show left the library after the run began.
			skipped++
		default:
			failed++
			a.logger.Warn("Show episodes not synchronized; previous episodes retained", "library_id", id, "item_id", show.ID, "error", err)
		}
		a.catalogueProgressUpdate(id, func(run *catalogueProgress) { run.ShowsDone, run.ShowsFailed = i+1, failed })
		if stopped != "" {
			break
		}
	}
	if stopped == "" && ctx.Err() != nil {
		stopped = "timeout"
		if a.catalogueCtx.Err() != nil {
			stopped = "shutdown"
		}
	}
	finished := utcTimestamp(time.Now())
	// A music library's run is recorded as a track run.
	summary := "library.episodes.sync_all"
	if len(shows) > 0 && shows[0].Kind == trackChildren.Parent {
		summary = "library.tracks.sync_all"
	}
	outcome := map[string]any{"finished_at": finished, "shows_total": len(shows), "shows_synced": synced, "shows_failed": failed, "shows_skipped": skipped,
		"added": added, "updated": updated, "removed": removed, "stopped": nil}
	if stopped != "" {
		outcome["stopped"] = stopped
	}
	// The summary is recorded even during shutdown: the store closes only
	// after this run returns.
	auditCtx, auditCancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer auditCancel()
	details, _ := json.Marshal(map[string]any{"library_id": id, "shows_total": len(shows), "shows_synced": synced, "shows_failed": failed, "shows_skipped": skipped, "added": added, "updated": updated, "removed": removed, "stopped": outcome["stopped"]})
	if err := a.store.write(auditCtx, func(tx *sql.Tx) error {
		_, err := tx.ExecContext(auditCtx, "INSERT INTO audit_events(actor_uuid,action,details,occurred_at) VALUES(?,?,?,?)", actor, summary, string(details), finished)
		return err
	}); err != nil {
		a.logger.Error("Library episode synchronization summary not recorded", "library_id", id, "error", err)
	}
	a.logger.Info("Library episode synchronization finished", "library_id", id, "shows", len(shows), "synced", synced, "failed", failed, "skipped", skipped, "stopped", stopped)
	a.catalogueMu.Lock()
	delete(a.catalogueRuns, id)
	a.episodeOutcomes[id] = outcome
	a.catalogueMu.Unlock()
}

// StopCatalogue refuses new catalogue runs and cancels library episode runs.
func (a *App) StopCatalogue() {
	a.catalogueMu.Lock()
	a.catalogueClosing = true
	a.catalogueMu.Unlock()
	a.catalogueCancel()
}

// CloseCatalogue stops and waits for library episode runs; call it before
// closing the Store.
func (a *App) CloseCatalogue() { a.StopCatalogue(); a.catalogueWG.Wait() }

func (a *App) purgeLibraryCatalogue(w http.ResponseWriter, r *http.Request) {
	p, ok := a.principal(w, r, true)
	if !ok {
		return
	}
	id, ok := pathID(w, r, "library")
	if !ok {
		return
	}
	var input struct {
		Revision *int64 `json:"expected_catalogue_revision"`
	}
	if r.ContentLength != 0 {
		if !decodeStrictBody(w, r, &input) {
			return
		}
		if input.Revision == nil || *input.Revision < 1 {
			fail(w, 400, "INVALID_REVISION", "Use a current catalogue revision")
			return
		}
	}
	a.catalogueMu.Lock()
	busy := a.catalogueRuns[id] != nil
	a.catalogueMu.Unlock()
	if busy {
		fail(w, 409, "CATALOGUE_SYNC_BUSY", "A catalogue synchronization is running")
		return
	}
	var deleted int64
	var revision int64
	access := bearer(r)
	err := a.store.write(r.Context(), func(tx *sql.Tx) error {
		if _, err := readCatalogueAuthority(r.Context(), tx, p.UUID, access); err != nil {
			return err
		}
		library, err := loadCatalogueLibrary(r.Context(), tx, id)
		if err != nil {
			return err
		}
		if input.Revision != nil && *input.Revision != library.Revision {
			return ErrConflict
		}
		result, err := tx.ExecContext(r.Context(), "DELETE FROM media_items WHERE library_id=?", id)
		if err != nil {
			return err
		}
		if deleted, err = result.RowsAffected(); err != nil {
			return err
		}
		if _, err = tx.ExecContext(r.Context(), "DELETE FROM media_collections WHERE library_id=?", id); err != nil {
			return err
		}
		if _, err = tx.ExecContext(r.Context(), "UPDATE media_libraries SET catalogue_revision=catalogue_revision+1,catalogue_synced_at=NULL,catalogue_item_count=NULL WHERE id=?", id); err != nil {
			return err
		}
		revision = library.Revision + 1
		details, _ := json.Marshal(map[string]any{"library_id": id, "source_revision": library.Revision, "deleted": deleted})
		_, err = tx.ExecContext(r.Context(), "INSERT INTO audit_events(actor_uuid,action,details,occurred_at) VALUES(?,'library.catalogue.purge',?,?)", p.UUID, string(details), utcTimestamp(time.Now()))
		return err
	})
	if err != nil {
		domainError(w, err)
		return
	}
	respond(w, 200, map[string]any{"success": true, "library_id": id, "deleted_count": deleted, "revision": revision})
}

func (a *App) librarySyncStatus(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.principal(w, r, true); !ok {
		return
	}
	id, ok := pathID(w, r, "library")
	if !ok {
		return
	}
	a.catalogueMu.Lock()
	run := a.catalogueRuns[id]
	var state catalogueProgress
	if run != nil {
		state = *run
	}
	var lastEpisodes any
	if outcome := a.episodeOutcomes[id]; outcome != nil {
		lastEpisodes = outcome
	}
	a.catalogueMu.Unlock()
	status := map[string]any{"is_syncing": run != nil, "library_id": id, "started_at": nil, "started_by": nil, "started_by_username": nil,
		"progress":         map[string]any{"phase": nil, "current_page": 0, "total_pages": 0, "total_items": 0, "total_fetched": 0, "shows_current": 0, "shows_total": 0, "shows_failed": 0, "message": nil},
		"last_episode_run": lastEpisodes}
	if run != nil {
		pages := (state.Total + cataloguePageSize - 1) / cataloguePageSize
		status["started_at"], status["started_by"], status["started_by_username"] = state.Started, state.ActorID, state.Actor
		progress := map[string]any{"phase": state.Phase, "current_page": (state.Fetched + cataloguePageSize - 1) / cataloguePageSize, "total_pages": pages, "total_items": state.Total, "total_fetched": state.Fetched,
			"shows_current": state.ShowsDone, "shows_total": state.ShowsTotal, "shows_failed": state.ShowsFailed, "message": "Reading provider items; nothing is saved until the complete snapshot is validated"}
		if state.Phase == "episodes" {
			// Each show is saved as soon as its episodes are read.
			progress["message"] = nil
		}
		status["progress"] = progress
	}
	respond(w, 200, status)
}

var catalogueSorts = map[string]string{
	"title_asc": "i.sort_title COLLATE NOCASE ASC,i.id ASC", "title_desc": "i.sort_title COLLATE NOCASE DESC,i.id DESC",
	"year_desc": "i.year IS NULL,i.year DESC,i.id DESC", "year_asc": "i.year IS NULL,i.year ASC,i.id ASC",
	"added_desc": "i.added_at IS NULL,i.added_at DESC,i.id DESC", "rating_desc": "i.rating IS NULL,i.rating DESC,i.id DESC",
	"total_streams_desc": "stream_count DESC,i.sort_title COLLATE NOCASE ASC,i.id ASC", "total_streams_asc": "stream_count ASC,i.sort_title COLLATE NOCASE ASC,i.id ASC",
}

// itemStreamCount counts the retained plays of the top-level item i on its
// server: a movie's own plays, a series' episode plays and an album's track
// plays (attributed through the play's parent item, as library activity is).
// Each half uses one history index.
const itemStreamCount = `((SELECT count(*) FROM media_activity_history h WHERE h.server_id=i.server_id AND h.parent_item_id=i.external_id)
 +(SELECT count(*) FROM media_activity_history h WHERE h.server_id=i.server_id AND h.parent_item_id IS NULL AND h.item_id=i.external_id))`

type catalogueItemRow struct {
	ID         int64    `json:"id"`
	External   string   `json:"external_id"`
	Title      string   `json:"title"`
	SortTitle  string   `json:"sort_title"`
	Type       string   `json:"item_type"`
	Year       *int64   `json:"year,omitempty"`
	Rating     *float64 `json:"rating,omitempty"`
	DurationMS *int64   `json:"duration,omitempty"`
	Summary    string   `json:"summary,omitempty"`
	Thumb      string   `json:"thumb,omitempty"`
	AddedAt    string   `json:"added_at,omitempty"`
	LastSynced string   `json:"last_synced"`
	// StreamCount is the item's retained plays (itemStreamCount).
	StreamCount int64 `json:"stream_count"`
}

func scanCatalogueItem(row rowScanner, summary bool) (catalogueItemRow, bool, error) {
	var item catalogueItemRow
	var year sql.NullInt64
	var rating sql.NullFloat64
	var duration sql.NullInt64
	var tag, text sql.NullString
	err := row.Scan(&item.ID, &item.External, &item.Title, &item.SortTitle, &item.Type, &year, &rating, &duration, &text, &tag, &item.AddedAt, &item.LastSynced, &item.StreamCount)
	if year.Valid {
		item.Year = &year.Int64
	}
	if rating.Valid {
		item.Rating = &rating.Float64
	}
	if duration.Valid {
		item.DurationMS = &duration.Int64
	}
	if summary {
		item.Summary = text.String
	}
	return item, tag.Valid && tag.String != "", err
}

const catalogueItemColumns = "i.id,i.external_id,i.title,coalesce(i.sort_title,i.title),i.item_type,i.year,i.rating,i.duration,i.summary,i.thumb_path,coalesce(i.added_at,''),coalesce(i.last_synced,'')," + itemStreamCount + " AS stream_count"

func (a *App) libraryCatalogueItems(w http.ResponseWriter, r *http.Request) {
	p, ok := a.principal(w, r, true)
	if !ok {
		return
	}
	id, ok := pathID(w, r, "library")
	if !ok {
		return
	}
	query := r.URL.Query()
	page, size := 1, 24
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
	order := catalogueSorts["title_asc"]
	if raw := query.Get("sort_by"); raw != "" {
		if order, ok = catalogueSorts[raw]; !ok {
			fail(w, 400, "SORT_UNAVAILABLE", "This sort order is not available for the item catalogue")
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
	library, err := loadCatalogueLibrary(r.Context(), tx, id)
	if err != nil {
		domainError(w, err)
		return
	}
	where, args := " WHERE i.library_id=? AND i.parent_id IS NULL", []any{id}
	if search != "" {
		where += " AND instr(lower(i.title),lower(?))>0"
		args = append(args, search)
	}
	var total int
	if err := tx.QueryRowContext(r.Context(), "SELECT count(*) FROM media_items i"+where, args...).Scan(&total); err != nil {
		domainError(w, err)
		return
	}
	rows, err := tx.QueryContext(r.Context(), "SELECT "+catalogueItemColumns+" FROM media_items i"+where+" ORDER BY "+order+" LIMIT ? OFFSET ?", append(args, size, (page-1)*size)...)
	if err != nil {
		domainError(w, err)
		return
	}
	defer rows.Close()
	now := time.Now()
	items := []catalogueItemRow{}
	for rows.Next() {
		item, image, err := scanCatalogueItem(rows, false)
		if err != nil {
			domainError(w, err)
			return
		}
		if image && library.Active {
			item.Thumb = a.catalogueImageURL(session, item.ID, now)
		}
		items = append(items, item)
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
	_ = json.NewEncoder(w).Encode(map[string]any{"data": items, "meta": map[string]any{
		"catalogue_revision": library.Revision, "catalogue_supported": catalogueLibrarySupported(library.Provider, library.Kind, library.External),
		"pagination": map[string]int{"page": page, "page_size": size, "total_items": total, "total_pages": pages}}})
}

func (a *App) libraryCatalogueItem(w http.ResponseWriter, r *http.Request) {
	p, ok := a.principal(w, r, true)
	if !ok {
		return
	}
	id, ok := pathID(w, r, "library")
	if !ok {
		return
	}
	itemID, ok := pathID(w, r, "item")
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
	library, err := loadCatalogueLibrary(r.Context(), tx, id)
	if err != nil {
		domainError(w, err)
		return
	}
	item, image, err := scanCatalogueItem(tx.QueryRowContext(r.Context(), "SELECT "+catalogueItemColumns+" FROM media_items i WHERE i.id=? AND i.library_id=? AND i.parent_id IS NULL", itemID, id), true)
	if errors.Is(err, sql.ErrNoRows) {
		domainError(w, ErrNotFound)
		return
	}
	if err != nil {
		domainError(w, err)
		return
	}
	if image && library.Active {
		item.Thumb = a.catalogueImageURL(session, item.ID, time.Now())
	}
	var episodeRevision int64
	var episodesSynced sql.NullString
	var episodeCount sql.NullInt64
	if err := tx.QueryRowContext(r.Context(), "SELECT episode_revision,episodes_synced_at,episode_count FROM media_items WHERE id=?", item.ID).Scan(&episodeRevision, &episodesSynced, &episodeCount); err != nil {
		domainError(w, err)
		return
	}
	libraryInfo, err := catalogueLibraryInfo(r.Context(), tx, library)
	if err != nil {
		domainError(w, err)
		return
	}
	respond(w, 200, map[string]any{"id": item.ID, "external_id": item.External, "title": item.Title, "sort_title": item.SortTitle, "item_type": item.Type,
		"year": item.Year, "rating": item.Rating, "duration": item.DurationMS, "summary": item.Summary, "thumb": item.Thumb, "added_at": item.AddedAt, "last_synced": item.LastSynced, "stream_count": item.StreamCount,
		"catalogue_revision": library.Revision, "catalogue_supported": catalogueLibrarySupported(library.Provider, library.Kind, library.External),
		"episode_catalogue_supported": childCatalogueSupported(library.Provider, episodeChildren) && item.Type == episodeChildren.Parent,
		"track_catalogue_supported":   childCatalogueSupported(library.Provider, trackChildren) && item.Type == trackChildren.Parent,
		"episode_revision":            episodeRevision, "episodes_synced_at": nullableText(episodesSynced.String), "episode_count": nullableCount(episodeCount),
		"library": libraryInfo})
}

// catalogueLibraryInfo is the library and server summary item and episode
// pages show.
func catalogueLibraryInfo(ctx context.Context, tx *sql.Tx, library catalogueLibrary) (map[string]any, error) {
	var nickname, serverName string
	if err := tx.QueryRowContext(ctx, "SELECT server_nickname,coalesce(server_name,'') FROM media_servers WHERE id=?", library.Server).Scan(&nickname, &serverName); err != nil {
		return nil, err
	}
	return map[string]any{"id": library.ID, "name": library.Name, "library_type": library.Kind, "server_id": library.Server,
		"server": map[string]any{"id": library.Server, "server_nickname": nickname, "server_name": serverName, "service_type": library.Provider}}, nil
}

type catalogueImageSource struct {
	Actor, Provider, URL, APIKey, External, Tag, Kind, LibraryExternal string
	Library, Server, ConfigRevision                                    int64
	ActivityMappingRevision                                            int64
}

// Each call opens a fresh snapshot. Never retain it during provider I/O: the
// delivery check must see revocations and source changes committed meanwhile.
func (a *App) readCatalogueImageSource(ctx context.Context, session string, item int64) (catalogueImageSource, error) {
	var source catalogueImageSource
	tx, err := a.store.reader.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return source, err
	}
	defer tx.Rollback()
	if err := tx.QueryRowContext(ctx, "SELECT user_uuid FROM app_sessions WHERE id=? AND refresh_expires_at>?", session, utcTimestamp(time.Now())).Scan(&source.Actor); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return source, ErrForbidden
		}
		return source, err
	}
	if err := requirePermission(ctx, tx, source.Actor, "administrator"); err != nil {
		return source, err
	}
	err = tx.QueryRowContext(ctx, `SELECT s.service_type,s.url,coalesce(s.api_key,''),i.external_id,coalesce(i.thumb_path,''),l.id,s.id,s.config_revision,coalesce(l.library_type,''),l.external_id
	 FROM media_items i JOIN media_libraries l ON l.id=i.library_id JOIN media_servers s ON s.id=l.server_id JOIN provider_settings p ON p.provider_id=s.service_type
	 WHERE i.id=? AND l.is_available=1 AND s.is_active=1 AND p.enabled=1`, item).Scan(
		&source.Provider, &source.URL, &source.APIKey, &source.External, &source.Tag, &source.Library, &source.Server, &source.ConfigRevision, &source.Kind, &source.LibraryExternal)
	if errors.Is(err, sql.ErrNoRows) || err == nil && (source.Tag == "" || !catalogueLibrarySupported(source.Provider, source.Kind, source.LibraryExternal)) {
		return source, ErrNotFound
	}
	return source, err
}

// catalogueImageProxy serves a signed item poster URL.
func (a *App) catalogueImageProxy(w http.ResponseWriter, r *http.Request) {
	a.serveSignedImage(w, r, "item", itemImagePurpose, a.readCatalogueImageSource, func(ctx context.Context, p *serverConnection, s catalogueImageSource) (string, []byte, error) {
		return p.catalogueImage(ctx, s.External, s.Tag)
	})
}

// serveSignedImage serves a signed poster URL. The URL proves only that this
// server issued it recently for one session and row; the session, its
// administrator permission and the row's library/server state are rechecked
// on every fetch before the provider is contacted, and again before delivery.
func (a *App) serveSignedImage(w http.ResponseWriter, r *http.Request, param, purpose string,
	read func(context.Context, string, int64) (catalogueImageSource, error),
	fetch func(context.Context, *serverConnection, catalogueImageSource) (string, []byte, error)) {
	// A cached success would bypass authorization on subsequent image fetches.
	w.Header().Set("Cache-Control", "private, no-store")
	itemID, err := strconv.ParseInt(r.PathValue(param), 10, 64)
	query := r.URL.Query()
	expires, expErr := strconv.ParseInt(query.Get("e"), 10, 64)
	session, signature := query.Get("s"), query.Get("g")
	now := time.Now()
	if err != nil || itemID <= 0 || expErr != nil || session == "" || len(session) > 128 || expires < now.Unix() || expires > now.Add(catalogueImageTTL+time.Minute).Unix() ||
		!hmac.Equal([]byte(signature), []byte(a.signCatalogueImage(purpose, session, itemID, expires))) {
		fail(w, 403, "IMAGE_LINK_INVALID", "This image link is invalid or expired")
		return
	}
	source, err := read(r.Context(), session, itemID)
	if err != nil {
		if errors.Is(err, ErrForbidden) {
			fail(w, 403, "IMAGE_LINK_INVALID", "This image link is invalid or expired")
		} else {
			domainError(w, err)
		}
		return
	}
	select {
	case a.imageSlots <- struct{}{}:
		defer func() { <-a.imageSlots }()
	default:
		w.Header().Set("Retry-After", "1")
		fail(w, 503, "IMAGE_PROXY_BUSY", "Too many image requests are in progress")
		return
	}
	client, err := newServerConnection(ProviderConfig{source.Provider, source.URL, source.APIKey}, a.ProviderHTTP)
	if err != nil {
		domainError(w, ErrConflict)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	kind, body, err := fetch(ctx, client, source)
	if err != nil {
		var avatarError *plexAvatarError
		if errors.As(err, &avatarError) {
			a.logger.Warn("Plex avatar fetch failed", "server_id", source.Server, "code", avatarError.Code, "upstream_status", avatarError.Status, "redirect_domain", avatarError.Domain, "content_type", avatarError.ContentType)
			fail(w, 502, avatarError.Code, "The Plex avatar could not be retrieved")
			return
		}
		fail(w, 502, "IMAGE_UNAVAILABLE", "The provider image could not be retrieved")
		return
	}
	current, err := read(ctx, session, itemID)
	if err != nil {
		if errors.Is(err, ErrForbidden) {
			fail(w, 403, "IMAGE_LINK_INVALID", "This image link is invalid or expired")
		} else {
			domainError(w, err)
		}
		return
	}
	if expires < time.Now().Unix() {
		fail(w, 403, "IMAGE_LINK_INVALID", "This image link is invalid or expired")
		return
	}
	if current != source {
		domainError(w, ErrConflict)
		return
	}
	w.Header().Set("Content-Type", kind)
	w.Header().Set("Content-Length", strconv.Itoa(len(body)))
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Security-Policy", "default-src 'none'")
	w.WriteHeader(200)
	_, _ = w.Write(body)
}

// upsertCatalogueItems writes one validated snapshot under parent ("" for
// top-level items, else a series ID). Entries found in existing (external ID to
// row ID) are removed from it, leaving the rows the snapshot no longer contains.
// A row with the same external ID under a different parent is never
// overwritten; the whole commit is refused instead.
func upsertCatalogueItems(ctx context.Context, tx *sql.Tx, library, server int64, parent string, items []catalogueItem, existing map[string]int64, now string) (added, updated int, err error) {
	upsert, err := tx.PrepareContext(ctx, `INSERT INTO media_items(library_id,server_id,external_id,parent_id,title,sort_title,item_type,summary,year,rating,duration,season_number,episode_number,thumb_path,added_at,updated_at,last_synced)
	 VALUES(?,?,?,nullif(?,''),?,?,?,nullif(?,''),?,?,?,?,?,nullif(?,''),nullif(?,''),?,?)
	 ON CONFLICT(library_id,external_id) DO UPDATE SET title=excluded.title,sort_title=excluded.sort_title,item_type=excluded.item_type,summary=excluded.summary,year=excluded.year,rating=excluded.rating,duration=excluded.duration,season_number=excluded.season_number,episode_number=excluded.episode_number,thumb_path=excluded.thumb_path,added_at=excluded.added_at,updated_at=excluded.updated_at,last_synced=excluded.last_synced
	 WHERE media_items.parent_id IS excluded.parent_id AND (media_items.title IS NOT excluded.title OR media_items.sort_title IS NOT excluded.sort_title OR media_items.item_type IS NOT excluded.item_type OR media_items.summary IS NOT excluded.summary OR media_items.year IS NOT excluded.year OR media_items.rating IS NOT excluded.rating OR media_items.duration IS NOT excluded.duration OR media_items.season_number IS NOT excluded.season_number OR media_items.episode_number IS NOT excluded.episode_number OR media_items.thumb_path IS NOT excluded.thumb_path OR media_items.added_at IS NOT excluded.added_at)`)
	if err != nil {
		return 0, 0, err
	}
	defer upsert.Close()
	for _, item := range items {
		result, err := upsert.ExecContext(ctx, library, server, item.ID, parent, item.Title, item.SortTitle, item.Type, item.Summary, item.Year, item.Rating, item.DurationMS, item.Season, item.Episode, item.ImageTag, item.AddedAt, now, now)
		if err != nil {
			return 0, 0, err
		}
		changed, err := result.RowsAffected()
		if err != nil {
			return 0, 0, err
		}
		if _, ok := existing[item.ID]; ok {
			delete(existing, item.ID)
			if changed > 0 {
				updated++
			}
		} else if changed == 0 {
			return 0, 0, ErrConflict
		} else {
			added++
		}
	}
	return added, updated, nil
}
