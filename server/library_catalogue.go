package main

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

// Library item catalogue: a durable, per-library copy of a provider's top-level
// items. Jellyfin/Emby and Plex movie/show sections are supported; Plex
// collections are saved alongside (library_collections.go). A sync reads the complete
// provider snapshot outside the writer, then commits it in one short transaction
// against the catalogue revision and server configuration it started from.

const (
	catalogueMaxItems = 50000
	// One series is capped well below a library.
	catalogueMaxEpisodes = 10000
	cataloguePageSize    = 200
	catalogueImageTTL    = 10 * time.Minute
	catalogueImageMax    = 8 << 20
)

var errCatalogueUnsupported = errors.New("item catalogue is not implemented for this provider")

var catalogueKinds = map[string]string{"Movie": "movie", "Series": "show", "MusicAlbum": "album", "Book": "book", "AudioBook": "audiobook", "MusicVideo": "music_video", "Video": "video"}

func catalogueSupported(provider string) bool {
	return episodeCatalogueSupported(provider) || provider == "plex"
}
func episodeCatalogueSupported(provider string) bool {
	return provider == "jellyfin" || provider == "emby"
}
func catalogueLibrarySupported(provider, kind, external string) bool {
	return episodeCatalogueSupported(provider) || provider == "plex" && validPlexCatalogueID(external) && (kind == "movie" || kind == "show")
}

// Provider item and image identifiers are interpolated into provider paths, so
// they are restricted to the characters Jellyfin/Emby actually use.
func validProviderToken(v string) bool {
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

func truncateRunes(v string, max int) string {
	v = strings.TrimSpace(v)
	if utf8.RuneCountInString(v) <= max {
		return v
	}
	return string([]rune(v)[:max])
}

type catalogueItem struct {
	ID, Title, SortTitle, Type, Summary, AddedAt, ImageTag string
	Year                                                   *int64
	Rating                                                 *float64
	DurationMS                                             *int64
	// Season and Episode are set only for episodes.
	Season, Episode *int64
}

// catalogueItems pages through one library's top-level items, or through one
// series' episodes when episodes is true. The provider has no snapshot
// isolation, so a changed total, a duplicate or a short final count rejects the
// whole snapshot instead of committing a partial catalogue.
func (p *jsonProvider) catalogueItems(ctx context.Context, parent string, episodes bool, progress func(fetched, total int)) ([]catalogueItem, error) {
	if !episodeCatalogueSupported(p.config.Type) {
		return nil, errCatalogueUnsupported
	}
	if !validProviderToken(parent) {
		return nil, errors.New("invalid provider parent identifier")
	}
	kinds, types, limit := catalogueKinds, "Movie,Series,MusicAlbum,Book,AudioBook,MusicVideo,Video", catalogueMaxItems
	if episodes {
		kinds, types, limit = map[string]string{"Episode": "episode"}, "Episode", catalogueMaxEpisodes
	}
	items := []catalogueItem{}
	seen := map[string]bool{}
	total := -1
	for start := 0; ; start += cataloguePageSize {
		query := url.Values{
			"ParentId": {parent}, "Recursive": {"true"},
			"IncludeItemTypes": {types},
			"Fields":           {"SortName,Overview,DateCreated"}, "SortBy": {"SortName"}, "SortOrder": {"Ascending"},
			"EnableImageTypes": {"Primary"}, "ImageTypeLimit": {"1"}, "EnableUserData": {"false"},
			"StartIndex": {strconv.Itoa(start)}, "Limit": {strconv.Itoa(cataloguePageSize)},
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
		if err := p.get(ctx, "/Items?"+query.Encode(), &page); err != nil {
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
			title := truncateRunes(row.Name, 512)
			if !ok || !validProviderToken(row.ID) || seen[row.ID] || title == "" || episodes && row.SeriesID != parent {
				return nil, errors.New("provider returned an invalid or duplicate item")
			}
			seen[row.ID] = true
			item := catalogueItem{ID: row.ID, Title: title, SortTitle: truncateRunes(row.SortName, 512), Type: kind, Summary: truncateRunes(row.Overview, 8000)}
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
				item.AddedAt = utcTimestamp(added)
			}
			if tag := row.ImageTags["Primary"]; validProviderToken(tag) {
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

// catalogueImage fetches one bounded item poster.
func (p *jsonProvider) catalogueImage(ctx context.Context, item, tag string) (string, []byte, error) {
	if p.config.Type == "plex" {
		return p.plexCatalogueImage(ctx, item, tag)
	}
	if !catalogueSupported(p.config.Type) || !validProviderToken(item) || !validProviderToken(tag) {
		return "", nil, errCatalogueUnsupported
	}
	base := strings.TrimRight(p.config.URL, "/")
	if p.config.Type == "emby" && !strings.HasSuffix(base, "/emby") {
		base += "/emby"
	}
	target := base + "/Items/" + item + "/Images/Primary?" + url.Values{"maxWidth": {"400"}, "quality": {"90"}, "tag": {tag}}.Encode()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		return "", nil, errors.New("invalid provider request")
	}
	req.Header.Set("Accept", "image/*")
	req.Header.Set("X-Emby-Token", p.config.APIKey)
	response, err := p.client.Do(req)
	if err != nil {
		return "", nil, errors.New("provider request failed or timed out")
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return "", nil, &providerHTTPError{StatusCode: response.StatusCode}
	}
	kind := strings.ToLower(strings.TrimSpace(strings.Split(response.Header.Get("Content-Type"), ";")[0]))
	if kind != "image/jpeg" && kind != "image/png" && kind != "image/webp" && kind != "image/gif" {
		return "", nil, errors.New("provider returned an unsupported image type")
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, catalogueImageMax+1))
	if err != nil || len(body) > catalogueImageMax || len(body) == 0 {
		return "", nil, errors.New("provider image exceeds size limit or could not be read")
	}
	return kind, body, nil
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
	if r.URL.Query().Get("sync_episodes") == "true" {
		fail(w, 409, "EPISODES_UNAVAILABLE", "Episode catalogues are not implemented; synchronize without episodes")
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
	if !library.Active || input.Revision != nil && *input.Revision != library.Revision {
		domainError(w, ErrConflict)
		return
	}
	a.catalogueMu.Lock()
	if a.catalogueRuns[id] != nil || len(a.catalogueRuns)+len(a.episodeRuns) >= 2 {
		a.catalogueMu.Unlock()
		fail(w, 409, "CATALOGUE_SYNC_BUSY", "A catalogue synchronization is already running")
		return
	}
	a.catalogueRuns[id] = &catalogueProgress{Started: utcTimestamp(time.Now()), ActorID: p.ID, Actor: p.Username}
	a.catalogueMu.Unlock()
	defer func() {
		a.catalogueMu.Lock()
		delete(a.catalogueRuns, id)
		a.catalogueMu.Unlock()
	}()
	provider, err := newMediaProvider(ProviderConfig{library.Provider, baseURL, apiKey}, a.ProviderHTTP)
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
	if library.Provider == "plex" {
		items, err = provider.(*jsonProvider).plexCatalogueItems(ctx, library.External, library.Kind, progress)
		if err == nil && collectionsSupported(library.Provider, library.Kind, library.External) {
			// Collections are part of the same complete snapshot: if they
			// cannot be read, neither list is saved.
			collections, err = provider.(*jsonProvider).plexCatalogueCollections(ctx, library.External, library.Kind)
		}
	} else {
		items, err = provider.(*jsonProvider).catalogueItems(ctx, library.External, false, progress)
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
	respond(w, 200, map[string]any{"success": true, "library_id": id, "source_revision": library.Revision, "revision": library.Revision + 1, "synced_at": now, "message": message,
		"result": map[string]int{"added": added, "updated": updated, "removed": removed, "total": len(items)}})
}

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
	a.catalogueMu.Unlock()
	status := map[string]any{"is_syncing": run != nil, "library_id": id, "started_at": nil, "started_by": nil, "started_by_username": nil,
		"progress": map[string]any{"current_page": 0, "total_pages": 0, "total_items": 0, "total_fetched": 0, "message": nil}}
	if run != nil {
		pages := (state.Total + cataloguePageSize - 1) / cataloguePageSize
		status["started_at"], status["started_by"], status["started_by_username"] = state.Started, state.ActorID, state.Actor
		status["progress"] = map[string]any{"current_page": (state.Fetched + cataloguePageSize - 1) / cataloguePageSize, "total_pages": pages, "total_items": state.Total, "total_fetched": state.Fetched, "message": "Reading provider items; nothing is saved until the complete snapshot is validated"}
	}
	respond(w, 200, status)
}

var catalogueSorts = map[string]string{
	"title_asc": "i.sort_title COLLATE NOCASE ASC,i.id ASC", "title_desc": "i.sort_title COLLATE NOCASE DESC,i.id DESC",
	"year_desc": "i.year IS NULL,i.year DESC,i.id DESC", "year_asc": "i.year IS NULL,i.year ASC,i.id ASC",
	"added_desc": "i.added_at IS NULL,i.added_at DESC,i.id DESC", "rating_desc": "i.rating IS NULL,i.rating DESC,i.id DESC",
}

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
}

func scanCatalogueItem(row rowScanner, summary bool) (catalogueItemRow, bool, error) {
	var item catalogueItemRow
	var year sql.NullInt64
	var rating sql.NullFloat64
	var duration sql.NullInt64
	var tag, text sql.NullString
	err := row.Scan(&item.ID, &item.External, &item.Title, &item.SortTitle, &item.Type, &year, &rating, &duration, &text, &tag, &item.AddedAt, &item.LastSynced)
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

const catalogueItemColumns = "i.id,i.external_id,i.title,coalesce(i.sort_title,i.title),i.item_type,i.year,i.rating,i.duration,i.summary,i.thumb_path,coalesce(i.added_at,''),coalesce(i.last_synced,'')"

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
	var nickname, serverName string
	if err := tx.QueryRowContext(r.Context(), "SELECT server_nickname,coalesce(server_name,'') FROM media_servers WHERE id=?", library.Server).Scan(&nickname, &serverName); err != nil {
		domainError(w, err)
		return
	}
	respond(w, 200, map[string]any{"id": item.ID, "external_id": item.External, "title": item.Title, "sort_title": item.SortTitle, "item_type": item.Type,
		"year": item.Year, "rating": item.Rating, "duration": item.DurationMS, "summary": item.Summary, "thumb": item.Thumb, "added_at": item.AddedAt, "last_synced": item.LastSynced,
		"catalogue_revision": library.Revision, "catalogue_supported": catalogueLibrarySupported(library.Provider, library.Kind, library.External),
		"episode_catalogue_supported": episodeCatalogueSupported(library.Provider) && item.Type == "show",
		"episode_revision":            episodeRevision, "episodes_synced_at": nullableText(episodesSynced.String), "episode_count": nullableCount(episodeCount),
		"library": map[string]any{"id": library.ID, "name": library.Name, "library_type": library.Kind, "server_id": library.Server,
			"server": map[string]any{"id": library.Server, "server_nickname": nickname, "server_name": serverName, "service_type": library.Provider}}})
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
	a.serveSignedImage(w, r, "item", itemImagePurpose, a.readCatalogueImageSource, func(ctx context.Context, p *jsonProvider, s catalogueImageSource) (string, []byte, error) {
		return p.catalogueImage(ctx, s.External, s.Tag)
	})
}

// serveSignedImage serves a signed poster URL. The URL proves only that this
// server issued it recently for one session and row; the session, its
// administrator permission and the row's library/server state are rechecked
// on every fetch before the provider is contacted, and again before delivery.
func (a *App) serveSignedImage(w http.ResponseWriter, r *http.Request, param, purpose string,
	read func(context.Context, string, int64) (catalogueImageSource, error),
	fetch func(context.Context, *jsonProvider, catalogueImageSource) (string, []byte, error)) {
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
	client, err := newMediaProvider(ProviderConfig{source.Provider, source.URL, source.APIKey}, a.ProviderHTTP)
	if err != nil {
		domainError(w, ErrConflict)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	kind, body, err := fetch(ctx, client.(*jsonProvider), source)
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
