package main

import (
	"context"
	"database/sql"
	"errors"
	"time"
)

// refreshServerCatalogues uses the same provider readers and transactional
// catalogue and child-item writers as the Media tab, guarded by the durable job.
func (a *App) refreshServerCatalogues(ctx context.Context, server ManagedServer, claim *serverRefreshClaim) error {
	rows, err := a.store.reader.QueryContext(ctx, `SELECT id FROM media_libraries WHERE server_id=? AND is_available=1 ORDER BY id`, server.ID)
	if err != nil {
		return err
	}
	var ids []int64
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return err
		}
		ids = append(ids, id)
	}
	if err := errors.Join(rows.Err(), rows.Close()); err != nil {
		return err
	}
	provider, err := newServerConnection(ProviderConfig{server.Type, server.URL, server.apiKey}, a.ProviderHTTP)
	if err != nil {
		return err
	}
	for _, id := range ids {
		tx, err := a.store.reader.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
		if err != nil {
			return err
		}
		library, readErr := loadCatalogueLibrary(ctx, tx, id)
		if readErr == nil {
			readErr = checkServerRefreshClaim(ctx, tx, claim)
		}
		_ = tx.Rollback()
		if readErr != nil {
			return readErr
		}
		if !catalogueLibrarySupported(library.Provider, library.Kind, library.External) {
			continue
		}
		for {
			a.catalogueMu.Lock()
			if a.catalogueClosing {
				a.catalogueMu.Unlock()
				return context.Canceled
			}
			if a.catalogueRuns[id] == nil && len(a.catalogueRuns)+len(a.episodeRuns) < 2 {
				a.catalogueRuns[id] = &catalogueProgress{Started: utcTimestamp(time.Now()), Phase: "shows"}
				a.catalogueMu.Unlock()
				break
			}
			a.catalogueMu.Unlock()
			timer := time.NewTimer(time.Second)
			select {
			case <-ctx.Done():
				timer.Stop()
				return ctx.Err()
			case <-timer.C:
			}
		}
		// An interactive catalogue run may have finished while we waited.
		tx, err = a.store.reader.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
		if err == nil {
			library, err = loadCatalogueLibrary(ctx, tx, id)
			if err == nil {
				err = checkServerRefreshClaim(ctx, tx, claim)
			}
			_ = tx.Rollback()
		}
		if err != nil {
			a.catalogueMu.Lock()
			delete(a.catalogueRuns, id)
			a.catalogueMu.Unlock()
			return err
		}
		err = a.refreshOneCatalogue(ctx, library, provider, claim)
		a.catalogueMu.Lock()
		delete(a.catalogueRuns, id)
		a.catalogueMu.Unlock()
		if err != nil {
			return err
		}
	}
	return nil
}

func (a *App) refreshOneCatalogue(ctx context.Context, library catalogueLibrary, provider *serverConnection, claim *serverRefreshClaim) error {
	items, err := provider.catalogueItems(ctx, library.External, library.Kind, func(int, int) {})
	if err != nil {
		return err
	}
	var collections []catalogueCollection
	if collectionsSupported(library.Provider, library.Kind, library.External) {
		collections, err = provider.catalogueCollections(ctx, library.External, library.Kind)
		if err != nil {
			return err
		}
	}
	err = a.store.write(ctx, func(tx *sql.Tx) error {
		if err := checkServerRefreshClaim(ctx, tx, claim); err != nil {
			return err
		}
		current, err := loadCatalogueLibrary(ctx, tx, library.ID)
		if err != nil {
			return err
		}
		if !current.Active || current.Revision != library.Revision || current.ConfigRevision != library.ConfigRevision || current.External != library.External || current.Kind != library.Kind {
			return ErrConflict
		}
		existing := map[string]int64{}
		rows, err := tx.QueryContext(ctx, "SELECT id,external_id FROM media_items WHERE library_id=? AND parent_id IS NULL", library.ID)
		if err != nil {
			return err
		}
		for rows.Next() {
			var id int64
			var external string
			if err := rows.Scan(&id, &external); err != nil {
				rows.Close()
				return err
			}
			existing[external] = id
		}
		if err := errors.Join(rows.Err(), rows.Close()); err != nil {
			return err
		}
		now := utcTimestamp(time.Now())
		if _, _, err = upsertCatalogueItems(ctx, tx, library.ID, current.Server, "", items, existing, now); err != nil {
			return err
		}
		for external, id := range existing {
			if _, err = tx.ExecContext(ctx, "DELETE FROM media_items WHERE library_id=? AND parent_id=?", library.ID, external); err != nil {
				return err
			}
			if _, err = tx.ExecContext(ctx, "DELETE FROM media_items WHERE id=?", id); err != nil {
				return err
			}
		}
		if collections != nil {
			if err = replaceCatalogueCollections(ctx, tx, library.ID, collections, now); err != nil {
				return err
			}
		}
		_, err = tx.ExecContext(ctx, "UPDATE media_libraries SET catalogue_revision=catalogue_revision+1,catalogue_synced_at=?,catalogue_item_count=? WHERE id=?", now, len(items), library.ID)
		return err
	})
	if err != nil {
		return err
	}
	if !claim.IncludeEpisodesAndTracks {
		return nil
	}
	shows, err := a.catalogueShows(ctx, library.ID)
	if err != nil {
		return err
	}
	for _, show := range shows {
		child, ok := childrenOf(show.Kind)
		if !ok || !childCatalogueSupported(library.Provider, child) {
			continue
		}
		if _, err = a.syncChildrenForRefresh(ctx, child, claim.Actor, "", library, provider, show, false, claim); err != nil {
			return err
		}
	}
	return nil
}
