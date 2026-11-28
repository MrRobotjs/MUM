package main

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"slices"
	"time"
)

// refreshServerCatalogues uses the same provider readers and transactional
// catalogue and child-item writers as the Media tab, guarded by the durable job.
func (a *App) refreshServerCatalogues(ctx context.Context, server ManagedServer, claim *serverRefreshClaim, log *refreshLog) error {
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
		if _, changed := claim.Live[library.External]; claim.Live != nil && !changed {
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
		err = a.refreshOneCatalogue(ctx, library, provider, claim, log)
		a.catalogueMu.Lock()
		delete(a.catalogueRuns, id)
		a.catalogueMu.Unlock()
		if err != nil {
			_, explanation := refreshProblem(err)
			log.add(refreshLogError, library.Name+": not refreshed", explanation)
			return err
		}
	}
	return nil
}

func (a *App) refreshOneCatalogue(ctx context.Context, library catalogueLibrary, provider *serverConnection, claim *serverRefreshClaim, log *refreshLog) error {
	a.setRefreshProgress(claim, refreshProgress{Library: library.Name, Phase: "items"})
	items, err := provider.catalogueItems(ctx, library.External, library.Kind, func(fetched, total int) {
		a.setRefreshProgress(claim, refreshProgress{Library: library.Name, Phase: "items", Done: fetched, Total: max(total, 0)})
	})
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
	var added, updated, removed int
	var changes []refreshLogItem
	var addedNow map[string]bool // items new in this run: their episodes are read too
	err = a.store.write(ctx, func(tx *sql.Tx) error {
		added, updated, removed, changes, addedNow = 0, 0, 0, nil, map[string]bool{}
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
		// The log lists the first changed titles; an added item's row ID is read
		// back so its poster can be shown.
		var externals []string
		note := func(id int64, item catalogueItem, change string) {
			if change == "added" {
				addedNow[item.ID] = true
			}
			if len(changes) < refreshLogEntryItems {
				changes = append(changes, refreshLogItem{Title: item.Title, Change: change, ItemID: id})
				externals = append(externals, item.ID)
			}
		}
		if added, updated, err = upsertCatalogueItemsNoting(ctx, tx, library.ID, current.Server, "", items, existing, now, note); err != nil {
			return err
		}
		for n := range changes {
			if changes[n].ItemID == 0 {
				if err := tx.QueryRowContext(ctx, "SELECT id FROM media_items WHERE library_id=? AND external_id=?", library.ID, externals[n]).Scan(&changes[n].ItemID); err != nil {
					return err
				}
			}
		}
		removed = len(existing)
		for external, id := range existing {
			if len(changes) < refreshLogEntryItems {
				var title string
				if err := tx.QueryRowContext(ctx, "SELECT title FROM media_items WHERE id=?", id).Scan(&title); err != nil {
					return err
				}
				changes = append(changes, refreshLogItem{Title: title, Change: "removed"})
			}
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
	log.addItems(refreshLogSuccess, library.Name+": "+plural(len(items), "item", "items")+" saved", fmt.Sprintf("%d added, %d updated, %d removed", added, updated, removed), changes, added+updated+removed)
	if !claim.IncludeEpisodesAndTracks {
		return nil
	}
	shows, err := a.catalogueShows(ctx, library.ID)
	if err != nil {
		return err
	}
	// A show whose episodes can't be read keeps its previous episodes and is
	// listed in the log; the other shows still refresh.
	var synced, skipped, changedShows int
	var totals episodeSyncResult
	var changedItems []refreshLogItem
	children := "episodes"
	// A live run reads only the shows or albums that changed.
	if parents := claim.Live[library.External]; claim.Live != nil && parents != nil {
		shows = slices.DeleteFunc(shows, func(show catalogueShow) bool { return !parents[show.External] && !addedNow[show.External] })
	}
	for n, show := range shows {
		child, ok := childrenOf(show.Kind)
		if !ok || !childCatalogueSupported(library.Provider, child) {
			continue
		}
		if show.Kind == "album" {
			children = "tracks"
		}
		a.setRefreshProgress(claim, refreshProgress{Library: library.Name, Phase: children, Done: n, Total: len(shows), Current: show.Title})
		result, err := a.syncChildrenForRefresh(ctx, child, claim.Actor, "", library, provider, show, false, claim)
		if err != nil {
			if !errors.Is(err, errEpisodeRead) || ctx.Err() != nil {
				return err
			}
			skipped++
			_, explanation := refreshProblem(err)
			log.addItems(refreshLogWarning, fmt.Sprintf("%s: skipped %q", library.Name, show.Title), explanation+" Its previous "+children+" are kept.",
				[]refreshLogItem{{Title: show.Title, Change: "skipped", ItemID: show.ID}}, 1)
			continue
		}
		if result.Added+result.Updated+result.Removed > 0 {
			changedShows++
			if len(changedItems) < refreshLogEntryItems {
				changedItems = append(changedItems, refreshLogItem{Title: show.Title, Change: "updated", ItemID: show.ID,
					Note: fmt.Sprintf("%d added, %d updated, %d removed", result.Added, result.Updated, result.Removed)})
			}
		}
		synced++
		totals.Total += result.Total
		totals.Added += result.Added
		totals.Updated += result.Updated
		totals.Removed += result.Removed
	}
	if synced+skipped > 0 {
		parent := "shows"
		if children == "tracks" {
			parent = "albums"
		}
		log.addItems(refreshLogSuccess, fmt.Sprintf("%s: %s synced for %d of %d %s", library.Name, children, synced, synced+skipped, parent),
			fmt.Sprintf("%d %s: %d added, %d updated, %d removed", totals.Total, children, totals.Added, totals.Updated, totals.Removed), changedItems, changedShows)
	}
	return nil
}
