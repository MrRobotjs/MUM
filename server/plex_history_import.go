package main

import (
	"context"
	"database/sql"
	"errors"
	"net/http"
	"time"

	"app/server/providers/plex"
)

// Importing a Plex server's own play history (PURGE_DESIGN.md). The purge
// counts these plays together with MUM's own, so it works on a new install and
// covers times MUM was not running. The import only reads from Plex, one page
// at a time, and stores each page in its own short transaction; it never holds
// the writer during a Plex request. It can run again at any time: stored
// entries are skipped by their history key, and plays MUM recorded itself are
// left out. Every run also fills in the poster of a stored play that has none,
// and never replaces one already stored. One run per server at a time; shutdown stops it and the next start
// marks it stopped.

// plexHistoryPageSize is the number of entries read per request (tests lower it).
var plexHistoryPageSize = 500

// maxPlexHistoryEntries bounds one run; a larger history needs another run.
const maxPlexHistoryEntries = 1_000_000

// playHistoryReader is the module feature that reads the play history.
type playHistoryReader interface {
	PlayHistory(ctx context.Context, start, size int) (plex.HistoryPage, error)
}

// recoverPlexHistoryImports marks runs that were going when MUM stopped.
func recoverPlexHistoryImports(ctx context.Context, store *Store) error {
	return store.write(ctx, func(tx *sql.Tx) error {
		_, err := tx.ExecContext(ctx, "UPDATE plex_history_import_runs SET state='stopped',finished_at=?,error_code='interrupted' WHERE state='running'", utcTimestamp(time.Now()))
		return err
	})
}

func (a *App) plexHistoryStatus(w http.ResponseWriter, r *http.Request) {
	actor, ok := a.principal(w, r, true)
	if !ok {
		return
	}
	id, ok := pathID(w, r, "server")
	if !ok {
		return
	}
	tx, err := a.store.reader.BeginTx(r.Context(), &sql.TxOptions{ReadOnly: true})
	if err != nil {
		domainError(w, err)
		return
	}
	defer tx.Rollback()
	if err := requirePermission(r.Context(), tx, actor.UUID, "administrator"); err != nil {
		domainError(w, err)
		return
	}
	var kind string
	if err := tx.QueryRowContext(r.Context(), "SELECT service_type FROM media_servers WHERE id=?", id).Scan(&kind); errors.Is(err, sql.ErrNoRows) {
		domainError(w, ErrNotFound)
		return
	} else if err != nil {
		domainError(w, err)
		return
	}
	out := map[string]any{"server_id": id, "state": "never", "started_at": nil, "finished_at": nil, "total": 0, "read": 0, "added": 0,
		"already_stored": 0, "already_recorded": 0, "unknown_accounts": 0, "error_code": nil, "stored_plays": 0, "oldest_play": nil, "newest_play": nil}
	var state, started string
	var finished, code sql.NullString
	var total, read, added, stored, recorded, unknown int
	err = tx.QueryRowContext(r.Context(), "SELECT state,started_at,finished_at,total,read_count,added,already_stored,already_recorded,unknown_accounts,error_code FROM plex_history_import_runs WHERE server_id=?", id).
		Scan(&state, &started, &finished, &total, &read, &added, &stored, &recorded, &unknown, &code)
	if err == nil {
		out["state"], out["started_at"], out["finished_at"], out["error_code"] = state, started, nullableString(finished), nullableString(code)
		out["total"], out["read"], out["added"], out["already_stored"], out["already_recorded"], out["unknown_accounts"] = total, read, added, stored, recorded, unknown
	} else if !errors.Is(err, sql.ErrNoRows) {
		domainError(w, err)
		return
	}
	var count int
	var oldest, newest sql.NullString
	if err := tx.QueryRowContext(r.Context(), "SELECT count(*),min(viewed_at),max(viewed_at) FROM plex_history_imports WHERE server_id=?", id).Scan(&count, &oldest, &newest); err != nil {
		domainError(w, err)
		return
	}
	out["stored_plays"], out["oldest_play"], out["newest_play"] = count, nullableString(oldest), nullableString(newest)
	// When MUM first recorded a play on this server: plays before then are
	// known only from the imported history (the purge dialog says so).
	var since sql.NullString
	if err := tx.QueryRowContext(r.Context(), "SELECT min(first_seen_at) FROM media_activity_history WHERE server_id=?", id).Scan(&since); err != nil {
		domainError(w, err)
		return
	}
	out["mum_since"] = nullableString(since)
	respond(w, 200, out)
}

func (a *App) startPlexHistoryImport(w http.ResponseWriter, r *http.Request) {
	actor, ok := a.principal(w, r, true)
	if !ok {
		return
	}
	id, ok := pathID(w, r, "server")
	if !ok {
		return
	}
	server, err := a.loadServer(r.Context(), id)
	if err != nil {
		domainError(w, err)
		return
	}
	if server.Type != "plex" || !server.EffectiveActive || !server.HasAPIKey {
		fail(w, 409, "PLEX_HISTORY_UNAVAILABLE", "Play history can only be imported from an active Plex server.")
		return
	}
	connection, err := newServerConnection(ProviderConfig{server.Type, server.URL, server.apiKey}, a.ProviderHTTP)
	if err != nil {
		fail(w, 409, "PLEX_HISTORY_UNAVAILABLE", "Play history can only be imported from an active Plex server.")
		return
	}
	reader, supported := connection.module().(playHistoryReader)
	if !supported {
		fail(w, 409, "PLEX_HISTORY_UNAVAILABLE", "Play history can only be imported from an active Plex server.")
		return
	}
	a.provisionMu.Lock()
	if a.provisionClosing {
		a.provisionMu.Unlock()
		fail(w, 503, "SHUTTING_DOWN", "MUM is shutting down")
		return
	}
	a.provisionWG.Add(1)
	a.provisionMu.Unlock()
	started := false
	defer func() {
		if !started {
			a.provisionWG.Done()
		}
	}()
	now := utcTimestamp(time.Now())
	err = a.store.write(r.Context(), func(tx *sql.Tx) error {
		if err := requirePermission(r.Context(), tx, actor.UUID, "administrator"); err != nil {
			return err
		}
		var running bool
		if err := tx.QueryRowContext(r.Context(), "SELECT EXISTS(SELECT 1 FROM plex_history_import_runs WHERE server_id=? AND state='running')", id).Scan(&running); err != nil {
			return err
		}
		if running {
			return errPlexHistoryRunning
		}
		if _, err := tx.ExecContext(r.Context(), `INSERT INTO plex_history_import_runs(server_id,state,started_at) VALUES(?,'running',?)
		 ON CONFLICT(server_id) DO UPDATE SET state='running',started_at=excluded.started_at,finished_at=NULL,total=0,read_count=0,added=0,already_stored=0,already_recorded=0,unknown_accounts=0,error_code=NULL`, id, now); err != nil {
			return err
		}
		return auditAction(r.Context(), tx, actor.UUID, "server.plex_history_import")
	})
	if errors.Is(err, errPlexHistoryRunning) {
		fail(w, 409, "PLEX_HISTORY_RUNNING", "An import is already running for this server.")
		return
	}
	if err != nil {
		domainError(w, err)
		return
	}
	started = true
	go func() {
		defer a.provisionWG.Done()
		a.runPlexHistoryImport(a.provisionCtx, id, reader)
	}()
	respond(w, 202, map[string]any{"server_id": id, "state": "running", "started_at": now})
}

var errPlexHistoryRunning = errors.New("plex history import running")

// runPlexHistoryImport reads the history page by page until it has read every
// entry, Plex fails, or MUM shuts down, and records how the run ended.
func (a *App) runPlexHistoryImport(ctx context.Context, server int64, reader playHistoryReader) {
	size := plexHistoryPageSize
	state, code := "completed", ""
	for start := 0; ; {
		if ctx.Err() != nil {
			state, code = "stopped", "shutdown"
			break
		}
		if start >= maxPlexHistoryEntries {
			code = "limit_reached"
			break
		}
		page, err := reader.PlayHistory(ctx, start, size)
		if err != nil {
			state, code = "failed", "plex_read_failed"
			if ctx.Err() != nil {
				state, code = "stopped", "shutdown"
			}
			break
		}
		if page.Offset != start {
			state, code = "failed", "plex_page_mismatch"
			break
		}
		if err := a.storePlexHistoryPage(ctx, server, page); err != nil {
			state, code = "failed", "store_failed"
			if errors.Is(err, ErrNotFound) {
				code = "server_removed"
			}
			break
		}
		start += len(page.Entries)
		if len(page.Entries) == 0 || start >= page.Total {
			break
		}
	}
	record, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer cancel()
	if err := a.store.write(record, func(tx *sql.Tx) error {
		_, err := tx.ExecContext(record, "UPDATE plex_history_import_runs SET state=?,finished_at=?,error_code=nullif(?,'') WHERE server_id=? AND state='running'", state, utcTimestamp(time.Now()), code, server)
		return err
	}); err != nil {
		a.logger.Warn("Plex history import result was not saved", "server_id", server, "state", state)
	}
}

// storePlexHistoryPage stores one page in one transaction. An entry already
// stored only gains a poster it lacks. An entry is left out when it is already
// stored, or when MUM recorded the same play itself:
// the same account and item, between 5 minutes before MUM first saw the play
// and 15 minutes after it last saw it (Plex writes the entry when the item is
// finished).
func (a *App) storePlexHistoryPage(ctx context.Context, server int64, page plex.HistoryPage) error {
	now := utcTimestamp(time.Now())
	return a.store.write(ctx, func(tx *sql.Tx) error {
		var kind string
		if err := tx.QueryRowContext(ctx, "SELECT service_type FROM media_servers WHERE id=?", server).Scan(&kind); errors.Is(err, sql.ErrNoRows) || err == nil && kind != "plex" {
			return ErrNotFound
		} else if err != nil {
			return err
		}
		var added, stored, recorded, unknown int
		for _, entry := range page.Entries {
			viewed := utcTimestamp(entry.ViewedAt)
			var exists bool
			if err := tx.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM plex_history_imports WHERE server_id=? AND history_key=?)", server, entry.Key).Scan(&exists); err != nil {
				return err
			}
			if exists {
				stored++
				if entry.PosterPath != "" && validPlexCataloguePoster(entry.PosterItem, entry.PosterPath) {
					if _, err := tx.ExecContext(ctx, "UPDATE plex_history_imports SET poster_item=?,poster_path=? WHERE server_id=? AND history_key=? AND poster_path IS NULL",
						entry.PosterItem, entry.PosterPath, server, entry.Key); err != nil {
						return err
					}
				}
				continue
			}
			if entry.RatingKey != "" {
				var seen bool
				if err := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM media_activity_history h JOIN service_accounts s ON s.uuid=h.service_uuid
				 WHERE h.server_id=? AND h.item_id=? AND s.external_user_id=? AND julianday(?) BETWEEN julianday(h.first_seen_at)-5.0/1440 AND julianday(h.last_seen_at)+15.0/1440)`,
					server, entry.RatingKey, entry.AccountID, viewed).Scan(&seen); err != nil {
					return err
				}
				if seen {
					recorded++
					continue
				}
			}
			posterItem, posterPath := entry.PosterItem, entry.PosterPath
			if !validPlexCataloguePoster(posterItem, posterPath) {
				posterItem, posterPath = "", ""
			}
			if _, err := tx.ExecContext(ctx, `INSERT INTO plex_history_imports(server_id,history_key,account_id,viewed_at,media_type,rating_key,library_section_id,title,parent_title,grandparent_title,imported_at,poster_item,poster_path)
			 VALUES(?,?,?,?,nullif(?,''),nullif(?,''),nullif(?,''),nullif(?,''),nullif(?,''),nullif(?,''),?,nullif(?,''),nullif(?,''))`,
				server, entry.Key, entry.AccountID, viewed, entry.Type, entry.RatingKey, entry.Section, entry.Title, entry.ParentTitle, entry.GrandparentTitle, now, posterItem, posterPath); err != nil {
				return err
			}
			added++
			var known bool
			if err := tx.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM service_accounts WHERE server_id=? AND external_user_id=?)", server, entry.AccountID).Scan(&known); err != nil {
				return err
			}
			if !known {
				unknown++
			}
		}
		_, err := tx.ExecContext(ctx, `UPDATE plex_history_import_runs SET total=?,read_count=read_count+?,added=added+?,already_stored=already_stored+?,already_recorded=already_recorded+?,unknown_accounts=unknown_accounts+? WHERE server_id=? AND state='running'`,
			page.Total, len(page.Entries), added, stored, recorded, unknown, server)
		return err
	})
}
