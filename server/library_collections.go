package main

import (
	"context"
	"database/sql"
	"errors"
	"net/http"
	"time"
)

// Library collections: a durable per-library list of Plex collections, saved
// with the item snapshot in the same catalogue sync and fenced by the same
// catalogue_revision. Membership is not stored.

func collectionsSupported(provider, kind, external string) bool {
	return provider == "plex" && catalogueLibrarySupported(provider, kind, external)
}

// replaceCatalogueCollections writes one validated collection snapshot,
// keeping row IDs stable for unchanged external IDs so issued poster links
// stay bound to the same collection, and deletes collections no longer listed.
func replaceCatalogueCollections(ctx context.Context, tx *sql.Tx, library int64, collections []catalogueCollection, now string) error {
	upsert, err := tx.PrepareContext(ctx, `INSERT INTO media_collections(library_id,external_id,title,sort_title,child_count,smart,thumb_path,added_at,last_synced)
	 VALUES(?,?,?,?,?,?,nullif(?,''),nullif(?,''),?)
	 ON CONFLICT(library_id,external_id) DO UPDATE SET title=excluded.title,sort_title=excluded.sort_title,child_count=excluded.child_count,smart=excluded.smart,thumb_path=excluded.thumb_path,added_at=excluded.added_at,last_synced=excluded.last_synced`)
	if err != nil {
		return err
	}
	defer upsert.Close()
	keep := map[string]bool{}
	for _, c := range collections {
		smart := 0
		if c.Smart {
			smart = 1
		}
		if _, err := upsert.ExecContext(ctx, library, c.ID, c.Title, c.SortTitle, c.ChildCount, smart, c.ImageTag, c.AddedAt, now); err != nil {
			return err
		}
		keep[c.ID] = true
	}
	rows, err := tx.QueryContext(ctx, "SELECT id,external_id FROM media_collections WHERE library_id=?", library)
	if err != nil {
		return err
	}
	stale := []int64{}
	for rows.Next() {
		var id int64
		var external string
		if err := rows.Scan(&id, &external); err != nil {
			rows.Close()
			return err
		}
		if !keep[external] {
			stale = append(stale, id)
		}
	}
	if err := errors.Join(rows.Err(), rows.Close()); err != nil {
		return err
	}
	for _, id := range stale {
		if _, err := tx.ExecContext(ctx, "DELETE FROM media_collections WHERE id=?", id); err != nil {
			return err
		}
	}
	return nil
}

type collectionRow struct {
	ID         int64   `json:"id"`
	External   string  `json:"external_id"`
	Title      string  `json:"title"`
	SortTitle  string  `json:"sort_title"`
	ChildCount *int64  `json:"child_count"`
	Smart      bool    `json:"smart"`
	Thumb      *string `json:"thumb"`
	AddedAt    *string `json:"added_at"`
	LastSynced string  `json:"last_synced"`
}

func (a *App) libraryCollections(w http.ResponseWriter, r *http.Request) {
	p, ok := a.principal(w, r, true)
	if !ok {
		return
	}
	id, ok := pathID(w, r, "library")
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
	if !collectionsSupported(library.Provider, library.Kind, library.External) {
		fail(w, 409, "COLLECTIONS_UNSUPPORTED", "Collections are available only for Plex movie and show libraries")
		return
	}
	rows, err := tx.QueryContext(r.Context(), `SELECT id,external_id,title,sort_title,child_count,smart=1,coalesce(thumb_path,'')<>'',added_at,last_synced
	 FROM media_collections WHERE library_id=? ORDER BY sort_title COLLATE NOCASE,id`, id)
	if err != nil {
		domainError(w, err)
		return
	}
	defer rows.Close()
	now := time.Now()
	collections := []collectionRow{}
	for rows.Next() {
		var c collectionRow
		var count sql.NullInt64
		var added sql.NullString
		var image bool
		if err := rows.Scan(&c.ID, &c.External, &c.Title, &c.SortTitle, &count, &c.Smart, &image, &added, &c.LastSynced); err != nil {
			domainError(w, err)
			return
		}
		if count.Valid {
			c.ChildCount = &count.Int64
		}
		if added.Valid {
			c.AddedAt = &added.String
		}
		if image && library.Active {
			thumb := a.signedImageURL(collectionImagePurpose, "/api/media/collections/images", session, c.ID, now)
			c.Thumb = &thumb
		}
		collections = append(collections, c)
	}
	if rows.Err() != nil {
		domainError(w, rows.Err())
		return
	}
	respond(w, 200, map[string]any{"collections": collections, "catalogue_revision": library.Revision})
}

// readCollectionImageSource mirrors readCatalogueImageSource for collection
// rows. Each call opens a fresh snapshot so delivery sees changes committed
// while the provider answered.
func (a *App) readCollectionImageSource(ctx context.Context, session string, collection int64) (catalogueImageSource, error) {
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
	err = tx.QueryRowContext(ctx, `SELECT s.service_type,s.url,coalesce(s.api_key,''),c.external_id,coalesce(c.thumb_path,''),l.id,s.id,s.config_revision,coalesce(l.library_type,''),l.external_id
	 FROM media_collections c JOIN media_libraries l ON l.id=c.library_id JOIN media_servers s ON s.id=l.server_id JOIN provider_settings p ON p.provider_id=s.service_type
	 WHERE c.id=? AND l.is_available=1 AND s.is_active=1 AND p.enabled=1`, collection).Scan(
		&source.Provider, &source.URL, &source.APIKey, &source.External, &source.Tag, &source.Library, &source.Server, &source.ConfigRevision, &source.Kind, &source.LibraryExternal)
	if errors.Is(err, sql.ErrNoRows) || err == nil && (source.Tag == "" || !collectionsSupported(source.Provider, source.Kind, source.LibraryExternal)) {
		return source, ErrNotFound
	}
	return source, err
}

func (a *App) collectionImageProxy(w http.ResponseWriter, r *http.Request) {
	a.serveSignedImage(w, r, "collection", collectionImagePurpose, a.readCollectionImageSource, func(ctx context.Context, p *jsonProvider, s catalogueImageSource) (string, []byte, error) {
		return p.plexCollectionImage(ctx, s.External, s.Tag)
	})
}
