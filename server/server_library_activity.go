package main

import (
	"context"
	"database/sql"
	"errors"
	"net/http"
	"net/url"
	"slices"
	"time"
)

// A server's Libraries page: each library with its activity on this server,
// for the chosen records (all plays, MUM's recorded plays or the server's
// imported history), as the server Users page does for accounts.
//
// A MUM play belongs to the library whose catalogue holds the played item or
// its show, as on the library's own page; a play whose item isn't catalogued
// yet falls back to the library name recorded with it, when exactly one of
// this server's libraries has that name. An imported play carries the
// server's library id. Watch time comes only from MUM's recordings.

// serverLibraryPlays assigns each of this server's MUM plays to a library
// (or NULL). Its parameter is the server ID.
const serverLibraryPlays = `SELECT h.id AS id,h.first_seen_at AS first_seen_at,` + mumWatchedSeconds + ` AS secs,coalesce(
 (SELECT i.library_id FROM media_items i WHERE i.server_id=h.server_id AND i.parent_id IS NULL AND i.external_id=coalesce(h.parent_item_id,h.item_id) ORDER BY i.id LIMIT 1),
 (SELECT min(l.id) FROM media_libraries l WHERE l.server_id=h.server_id AND l.name=h.library_name HAVING count(*)=1)) AS lib
 FROM media_activity_history h WHERE h.server_id=?`

type serverLibraryActivity struct {
	plays  int
	secs   int64
	last   string
	newest int64 // the newest play's row
}

func (a *App) serverLibraryActivity(w http.ResponseWriter, r *http.Request) {
	actor, ok := a.principal(w, r, true)
	if !ok {
		return
	}
	server, ok := pathID(w, r, "server")
	if !ok {
		return
	}
	records := "all"
	values, err := url.ParseQuery(r.URL.RawQuery)
	valid := err == nil
	for key, list := range values {
		if !valid || key != "records" || len(list) != 1 || (list[0] != "all" && list[0] != "mum" && list[0] != "server") {
			valid = false
			break
		}
		records = list[0]
	}
	if !valid {
		fail(w, 400, "INVALID_SERVER_LIBRARIES_QUERY", "Use records all, mum or server")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	tx, err := a.store.reader.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		domainError(w, err)
		return
	}
	defer tx.Rollback()
	if err := accountPreferenceAuthority(ctx, tx, actor.UUID, bearer(r)); err != nil {
		domainError(w, err)
		return
	}
	if err := requirePermission(ctx, tx, actor.UUID, "administrator"); err != nil {
		domainError(w, err)
		return
	}
	var kind, name string
	if err := tx.QueryRowContext(ctx, "SELECT service_type,server_nickname FROM media_servers WHERE id=?", server).Scan(&kind, &name); errors.Is(err, sql.ErrNoRows) {
		domainError(w, ErrNotFound)
		return
	} else if err != nil {
		domainError(w, err)
		return
	}
	live := kind == "plex" || kind == "jellyfin" || kind == "emby" || kind == "tofa"
	withMUM, withImported := live && records != "server", records != "mum" && slices.Contains(importableHistory, kind)

	mum := map[int64]*serverLibraryActivity{}
	if withMUM {
		if err := readServerLibraryActivity(ctx, tx, mum, `SELECT lib,count(*),coalesce(sum(secs),0),max(first_seen_at),
		 (SELECT p2.id FROM (`+serverLibraryPlays+`) p2 WHERE p2.lib=p.lib ORDER BY p2.first_seen_at DESC,p2.id DESC LIMIT 1)
		 FROM (`+serverLibraryPlays+`) p WHERE lib IS NOT NULL GROUP BY lib`, server, server); err != nil {
			domainError(w, err)
			return
		}
	}
	imported := map[int64]*serverLibraryActivity{}
	if withImported {
		if err := readServerLibraryActivity(ctx, tx, imported, `SELECT l.id,count(*),0,max(im.viewed_at),
		 (SELECT im2.rowid FROM history_imports im2 WHERE im2.server_id=l.server_id AND im2.library_id=l.external_id ORDER BY im2.viewed_at DESC,im2.rowid DESC LIMIT 1)
		 FROM history_imports im JOIN media_libraries l ON l.server_id=im.server_id AND l.external_id=im.library_id WHERE im.server_id=? GROUP BY l.id`, server); err != nil {
			domainError(w, err)
			return
		}
	}

	// From a synced catalogue: shows' distinct seasons and their episodes, or
	// albums and their tracks.
	rows, err := tx.QueryContext(ctx, `SELECT l.id,l.external_id,l.name,l.library_type,coalesce(l.item_count,CASE WHEN l.catalogue_synced_at IS NOT NULL THEN l.catalogue_item_count END),l.last_scanned,l.catalogue_synced_at IS NOT NULL,
	 (SELECT count(*) FROM media_items s WHERE s.library_id=l.id AND s.parent_id IS NULL AND s.item_type='show'),
	 (SELECT count(*) FROM (SELECT DISTINCT e.parent_id,e.season_number FROM media_items e WHERE e.library_id=l.id AND e.item_type='episode' AND e.season_number IS NOT NULL)),
	 (SELECT count(*) FROM media_items e WHERE e.library_id=l.id AND e.item_type='episode'),
	 (SELECT count(*) FROM media_items a WHERE a.library_id=l.id AND a.parent_id IS NULL AND a.item_type='album'),
	 (SELECT count(*) FROM media_items t WHERE t.library_id=l.id AND t.item_type='track')
	 FROM media_libraries l WHERE l.server_id=? ORDER BY lower(l.name),l.id`, server)
	if err != nil {
		domainError(w, err)
		return
	}
	type library struct {
		id                                       int64
		external, name                           string
		kind, scanned                            sql.NullString
		items                                    sql.NullInt64 // the server's count, else the synced catalogue's
		catalogued                               bool
		shows, seasons, episodes, albums, tracks int64
	}
	var libraries []library
	for rows.Next() {
		var l library
		if err := rows.Scan(&l.id, &l.external, &l.name, &l.kind, &l.items, &l.scanned, &l.catalogued, &l.shows, &l.seasons, &l.episodes, &l.albums, &l.tracks); err != nil {
			rows.Close()
			domainError(w, err)
			return
		}
		libraries = append(libraries, l)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		domainError(w, err)
		return
	}

	session, sessionErr := a.requestSession(ctx, r)
	now := time.Now()
	items := []map[string]any{}
	for _, l := range libraries {
		item := map[string]any{"id": l.id, "external_id": l.external, "name": l.name, "library_type": nullableString(l.kind), "item_count": nullableCount(l.items),
			"last_scanned": nullableString(l.scanned), "catalogue_synced": l.catalogued, "plays": 0, "watch_seconds": nil, "last_streamed_at": nil, "last_played": nil}
		item["parent_count"], item["child_count"] = nil, nil
		if l.catalogued && l.shows > 0 {
			item["parent_count"], item["child_count"] = l.seasons, l.episodes
		} else if l.catalogued && l.albums > 0 {
			item["parent_count"], item["child_count"] = l.albums, l.tracks
		}
		if withMUM {
			item["watch_seconds"] = int64(0)
		}
		var newest *serverAccountPlay
		if m := mum[l.id]; m != nil {
			item["plays"], item["watch_seconds"], item["last_streamed_at"] = m.plays, m.secs, m.last
			play, err := readServerAccountPlay(ctx, tx, `SELECT title,parent_title,media_type,first_seen_at,id,item_id,coalesce(parent_item_id,''),coalesce(poster_item,''),poster_path IS NOT NULL FROM media_activity_history WHERE id=?`, m.newest)
			if err != nil {
				domainError(w, err)
				return
			}
			if play != nil {
				play.Source, newest = "mum", play
			}
		}
		if h := imported[l.id]; h != nil {
			item["plays"] = item["plays"].(int) + h.plays
			if last, ok := item["last_streamed_at"].(string); !ok || h.last > last {
				item["last_streamed_at"] = h.last
			}
			play, err := readServerAccountPlay(ctx, tx, `SELECT coalesce(title,''),coalesce(grandparent_title,parent_title),coalesce(media_type,''),viewed_at,rowid,coalesce(item_id,''),'',coalesce(poster_item,''),poster_path IS NOT NULL FROM history_imports WHERE rowid=?`, h.newest)
			if err != nil {
				domainError(w, err)
				return
			}
			// MUM's recording wins a tie, as on the Users page.
			if play != nil && (newest == nil || play.at > newest.at) {
				play.Source, newest = kind, play
			}
		}
		if newest != nil {
			if err := a.finishServerPlay(ctx, tx, server, newest, session, sessionErr == nil, now); err != nil {
				domainError(w, err)
				return
			}
			item["last_played"] = newest
		}
		items = append(items, item)
	}
	if err := tx.Commit(); err != nil {
		domainError(w, err)
		return
	}
	respond(w, 200, map[string]any{"server_id": server, "server_name": name, "service_type": kind, "live": live, "records": records, "items": items})
}

// readServerLibraryActivity reads rows of library, plays, seconds, newest
// time and newest row into into.
func readServerLibraryActivity(ctx context.Context, tx *sql.Tx, into map[int64]*serverLibraryActivity, query string, args ...any) error {
	rows, err := tx.QueryContext(ctx, query, args...)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var library int64
		var activity serverLibraryActivity
		if err := rows.Scan(&library, &activity.plays, &activity.secs, &activity.last, &activity.newest); err != nil {
			return err
		}
		into[library] = &activity
	}
	return rows.Err()
}
