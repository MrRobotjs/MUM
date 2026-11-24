package main

import (
	"context"
	"database/sql"
	"errors"
	"net/http"
	"slices"
	"time"

	"app/server/providers/audiobookshelf"
	"app/server/providers/mediabrowser"
	"app/server/providers/provider"
	"app/server/providers/tofa"
)

// Importing a server's own play history from Plex, Jellyfin, Emby or
// Audiobookshelf. The History
// tab, Last Streamed and the Plex purge count these plays together with MUM's
// own, so they cover times MUM was not running. The import only reads from the
// server, one page at a time, and stores each page in its own short
// transaction; it never holds the writer during a provider request. It can run
// again at any time: stored entries are skipped by their key, and plays MUM
// recorded itself are left out. Every run also fills in the poster of a stored
// play that has none, and never replaces one already stored. One run per
// server at a time; shutdown stops it and the next start marks it stopped.

// historyPageSize is the number of records read per request (tests lower it).
var historyPageSize = 500

// maxHistoryRecords bounds one run; a larger history needs another run.
const maxHistoryRecords = 1_000_000

// importableHistory are the services whose history MUM can import, in the
// order the History tab lists them.
var importableHistory = []string{"plex", "jellyfin", "emby", "audiobookshelf"}

// playHistoryReader is the module feature that reads the play history.
type playHistoryReader interface {
	PlayHistory(ctx context.Context, start, size int) (provider.HistoryPage, error)
}

// recoverHistoryImports marks runs that were going when MUM stopped.
func recoverHistoryImports(ctx context.Context, store *Store) error {
	return store.write(ctx, func(tx *sql.Tx) error {
		_, err := tx.ExecContext(ctx, "UPDATE history_import_runs SET state='stopped',finished_at=?,error_code='interrupted' WHERE state='running'", utcTimestamp(time.Now()))
		return err
	})
}

func (a *App) playHistoryStatus(w http.ResponseWriter, r *http.Request) {
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
	out["scope"] = nil
	var state, started string
	var finished, code sql.NullString
	var account bool
	var total, read, added, stored, recorded, unknown int
	err = tx.QueryRowContext(r.Context(), "SELECT state,started_at,finished_at,total,read_count,added,already_stored,already_recorded,unknown_accounts,error_code,account_id IS NOT NULL FROM history_import_runs WHERE server_id=?", id).
		Scan(&state, &started, &finished, &total, &read, &added, &stored, &recorded, &unknown, &code, &account)
	if err == nil {
		out["state"], out["started_at"], out["finished_at"], out["error_code"] = state, started, nullableString(finished), nullableString(code)
		out["scope"] = map[bool]string{true: "account", false: "server"}[account]
		out["total"], out["read"], out["added"], out["already_stored"], out["already_recorded"], out["unknown_accounts"] = total, read, added, stored, recorded, unknown
	} else if !errors.Is(err, sql.ErrNoRows) {
		domainError(w, err)
		return
	}
	var count int
	var oldest, newest sql.NullString
	if err := tx.QueryRowContext(r.Context(), "SELECT count(*),min(viewed_at),max(viewed_at) FROM history_imports WHERE server_id=?", id).Scan(&count, &oldest, &newest); err != nil {
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

func (a *App) startPlayHistoryImport(w http.ResponseWriter, r *http.Request) {
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
	const unavailable = "Play history can only be imported from an active Plex, Jellyfin, Emby or Audiobookshelf server."
	if !slices.Contains(importableHistory, server.Type) || !server.EffectiveActive || !server.HasAPIKey {
		fail(w, 409, "HISTORY_UNAVAILABLE", unavailable)
		return
	}
	connection, err := newServerConnection(ProviderConfig{server.Type, server.URL, server.apiKey}, a.ProviderHTTP)
	if err != nil {
		fail(w, 409, "HISTORY_UNAVAILABLE", unavailable)
		return
	}
	reader, supported := connection.module().(playHistoryReader)
	if !supported {
		fail(w, 409, "HISTORY_UNAVAILABLE", unavailable)
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
		if err := tx.QueryRowContext(r.Context(), "SELECT EXISTS(SELECT 1 FROM history_import_runs WHERE server_id=? AND state='running')", id).Scan(&running); err != nil {
			return err
		}
		if running {
			return errHistoryRunning
		}
		if _, err := tx.ExecContext(r.Context(), `INSERT INTO history_import_runs(server_id,state,started_at) VALUES(?,'running',?)
		 ON CONFLICT(server_id) DO UPDATE SET state='running',started_at=excluded.started_at,finished_at=NULL,total=0,read_count=0,added=0,already_stored=0,already_recorded=0,unknown_accounts=0,error_code=NULL,account_id=NULL`, id, now); err != nil {
			return err
		}
		return auditAction(r.Context(), tx, actor.UUID, "server.play_history_import")
	})
	if errors.Is(err, errHistoryRunning) {
		fail(w, 409, "HISTORY_RUNNING", "An import is already running for this server.")
		return
	}
	if err != nil {
		domainError(w, err)
		return
	}
	started = true
	go func() {
		defer a.provisionWG.Done()
		a.runHistoryImport(a.provisionCtx, id, server.Type, reader)
	}()
	respond(w, 202, map[string]any{"server_id": id, "state": "running", "started_at": now})
}

var errHistoryRunning = errors.New("history import running")

// runHistoryImport imports the server's whole history and records how the
// run ended.
func (a *App) runHistoryImport(ctx context.Context, server int64, kind string, reader playHistoryReader) {
	state, code := a.importHistoryPages(ctx, server, kind, reader.PlayHistory)
	a.finishHistoryImport(ctx, server, state, code)
}

// importHistoryPages reads a history page by page until it has read every
// record, the server fails, or MUM shuts down, and says how it ended.
func (a *App) importHistoryPages(ctx context.Context, server int64, kind string, read func(ctx context.Context, start, size int) (provider.HistoryPage, error)) (state, code string) {
	size := historyPageSize
	state, code = "completed", ""
	for start := 0; ; {
		if ctx.Err() != nil {
			state, code = "stopped", "shutdown"
			break
		}
		if start >= maxHistoryRecords {
			code = "limit_reached"
			break
		}
		page, err := read(ctx, start, size)
		if err != nil {
			state, code = "failed", "server_read_failed"
			if ctx.Err() != nil {
				state, code = "stopped", "shutdown"
			}
			break
		}
		if page.Offset != start || page.Read < len(page.Entries) {
			state, code = "failed", "page_mismatch"
			break
		}
		if err := a.storeHistoryPage(ctx, server, kind, page); err != nil {
			state, code = "failed", "store_failed"
			if errors.Is(err, ErrNotFound) {
				code = "server_removed"
			}
			break
		}
		start += page.Read
		if page.Read == 0 || start >= page.Total {
			break
		}
	}
	return state, code
}

// finishHistoryImport records how a run ended.
func (a *App) finishHistoryImport(ctx context.Context, server int64, state, code string) {
	record, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer cancel()
	if err := a.store.write(record, func(tx *sql.Tx) error {
		_, err := tx.ExecContext(record, "UPDATE history_import_runs SET state=?,finished_at=?,error_code=nullif(?,'') WHERE server_id=? AND state='running'", state, utcTimestamp(time.Now()), code, server)
		return err
	}); err != nil {
		a.logger.Warn("Play history import result was not saved", "server_id", server, "state", state)
	}
}

// storeHistoryPage stores one page in one transaction. An entry already
// stored only gains a poster it lacks. An entry is left out when it is already
// stored, or when MUM recorded the same play itself: the same account and item,
// between 5 minutes before MUM first saw the play and 15 minutes after it last
// saw it (servers write the entry when the play ends).
func (a *App) storeHistoryPage(ctx context.Context, server int64, kind string, page provider.HistoryPage) error {
	now := utcTimestamp(time.Now())
	return a.store.write(ctx, func(tx *sql.Tx) error {
		var current string
		if err := tx.QueryRowContext(ctx, "SELECT service_type FROM media_servers WHERE id=?", server).Scan(&current); errors.Is(err, sql.ErrNoRows) || err == nil && current != kind {
			return ErrNotFound
		} else if err != nil {
			return err
		}
		var added, stored, recorded, unknown int
		for _, entry := range page.Entries {
			viewed := utcTimestamp(entry.ViewedAt)
			posterItem, posterPath := entry.PosterItem, entry.PosterPath
			if !validHistoryPoster(kind, posterItem, posterPath) {
				posterItem, posterPath = "", ""
			}
			var exists bool
			if err := tx.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM history_imports WHERE server_id=? AND entry_key=?)", server, entry.Key).Scan(&exists); err != nil {
				return err
			}
			if exists {
				stored++
				if entry.ListenedSeconds != nil {
					if _, err := tx.ExecContext(ctx, "UPDATE history_imports SET listened_seconds=? WHERE server_id=? AND entry_key=? AND listened_seconds IS NULL",
						nonNegativeSeconds(entry.ListenedSeconds), server, entry.Key); err != nil {
						return err
					}
				}
				if posterPath != "" {
					if _, err := tx.ExecContext(ctx, "UPDATE history_imports SET poster_item=?,poster_path=? WHERE server_id=? AND entry_key=? AND poster_path IS NULL",
						posterItem, posterPath, server, entry.Key); err != nil {
						return err
					}
				}
				continue
			}
			account, known, err := resolveHistoryAccount(ctx, tx, server, kind, entry.AccountID)
			if err != nil {
				return err
			}
			if entry.ItemID != "" {
				var seen bool
				if err := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM media_activity_history h JOIN service_accounts s ON s.uuid=h.service_uuid
				 WHERE h.server_id=? AND h.item_id=? AND s.external_user_id=? AND julianday(?) BETWEEN julianday(h.first_seen_at)-5.0/1440 AND julianday(h.last_seen_at)+15.0/1440)`,
					server, entry.ItemID, account, viewed).Scan(&seen); err != nil {
					return err
				}
				if seen {
					recorded++
					continue
				}
			}
			if _, err := tx.ExecContext(ctx, `INSERT INTO history_imports(server_id,entry_key,account_id,viewed_at,media_type,item_id,library_id,title,parent_title,grandparent_title,poster_item,poster_path,position_seconds,duration_seconds,listened_seconds,imported_at)
			 VALUES(?,?,?,?,nullif(?,''),nullif(?,''),nullif(?,''),nullif(?,''),nullif(?,''),nullif(?,''),nullif(?,''),nullif(?,''),?,?,?,?)`,
				server, entry.Key, account, viewed, entry.Type, entry.ItemID, entry.Section, entry.Title, entry.ParentTitle, entry.GrandparentTitle, posterItem, posterPath,
				nonNegativeSeconds(entry.PositionSeconds), nonNegativeSeconds(entry.DurationSeconds), nonNegativeSeconds(entry.ListenedSeconds), now); err != nil {
				return err
			}
			added++
			if !known {
				unknown++
			}
		}
		_, err := tx.ExecContext(ctx, `UPDATE history_import_runs SET total=?,read_count=read_count+?,added=added+?,already_stored=already_stored+?,already_recorded=already_recorded+?,unknown_accounts=unknown_accounts+? WHERE server_id=? AND state='running'`,
			page.Total, page.Read, added, stored, recorded, unknown, server)
		return err
	})
}

// resolveHistoryAccount is the account ID a play is stored under and whether
// the server has that account. Jellyfin and Emby write the same user ID with or
// without dashes and in either case: a play is stored under the form the
// server account has, or in canonical form until that account is synced.
func resolveHistoryAccount(ctx context.Context, tx *sql.Tx, server int64, kind, id string) (string, bool, error) {
	if kind == "jellyfin" || kind == "emby" {
		canonical := mediabrowser.CanonicalUserID(id)
		var stored string
		err := tx.QueryRowContext(ctx, "SELECT external_user_id FROM service_accounts WHERE server_id=? AND lower(replace(external_user_id,'-',''))=? ORDER BY removed_at IS NOT NULL LIMIT 1", server, canonical).Scan(&stored)
		if errors.Is(err, sql.ErrNoRows) {
			return canonical, false, nil
		}
		return stored, err == nil, err
	}
	var known bool
	err := tx.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM service_accounts WHERE server_id=? AND external_user_id=?)", server, id).Scan(&known)
	return id, known, err
}

// validHistoryPoster reports whether a stored poster reference is one MUM may
// fetch from that kind of server.
func validHistoryPoster(kind, item, path string) bool {
	switch kind {
	case "tofa":
		return tofa.ValidMediaID(item) && path == "poster"
	case "plex":
		return validPlexCataloguePoster(item, path)
	case "jellyfin", "emby":
		return mediabrowser.ValidToken(item) && mediabrowser.ValidToken(path)
	case "audiobookshelf":
		return audiobookshelf.ValidItemID(item) && path == "cover"
	}
	return false
}

func nonNegativeSeconds(v *int64) any {
	if v == nil || *v < 0 {
		return nil
	}
	return *v
}
