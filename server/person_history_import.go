package main

import (
	"context"
	"database/sql"
	"errors"
	"net/http"
	"strconv"
	"time"

	"app/server/providers/provider"
)

// Importing one person's history from one server, from the History tab
// (HISTORY_TOOLBAR_DESIGN.md). Plex and Audiobookshelf can read one account's
// history, so only the person's plays are read; Jellyfin and Emby can't, and
// the History tab offers a full import of the server instead; Kavita, Komga
// and RomM keep no history MUM can read. A person's import uses the server's
// one import slot, so it never runs beside a full import, and is stored and
// deduplicated exactly as a full import's pages are.

// accountHistoryReader is the module feature that reads one account's history.
type accountHistoryReader interface {
	AccountPlayHistory(ctx context.Context, account string, start, size int) (provider.HistoryPage, error)
}

// historyImportSupport says how a service's history can be imported for one
// person: "account" (just theirs), "server" (only a full import) or "none".
func historyImportSupport(kind string) string {
	switch kind {
	case "plex", "audiobookshelf":
		return "account"
	case "jellyfin", "emby":
		return "server"
	}
	return "none"
}

// personServerAccounts are the person's account IDs on the server: their own
// account, or the accounts their profile owns.
func personServerAccounts(ctx context.Context, tx *sql.Tx, person string, server int64) ([]string, error) {
	rows, err := tx.QueryContext(ctx, `SELECT sa.external_user_id FROM service_accounts sa WHERE sa.server_id=? AND (sa.uuid=? OR EXISTS(SELECT 1 FROM service_links l
	 WHERE l.service_uuid=sa.uuid AND l.user_uuid=? AND l.link_kind='owner')) ORDER BY sa.external_user_id LIMIT 100`, server, person, person)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var accounts []string
	for rows.Next() {
		var account string
		if err := rows.Scan(&account); err != nil {
			return nil, err
		}
		accounts = append(accounts, account)
	}
	return accounts, rows.Err()
}

// personImportTarget checks the actor and the person, and returns the
// person's accounts on the server (ErrNotFound when there are none).
func personImportTarget(ctx context.Context, tx *sql.Tx, actor, person string, server int64) ([]string, error) {
	if err := requirePermission(ctx, tx, actor, "administrator"); err != nil {
		return nil, err
	}
	if err := checkActivityTarget(ctx, tx, actor, activityReadQuery{History: true, All: true, Target: person}); errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	} else if err != nil {
		return nil, err
	}
	accounts, err := personServerAccounts(ctx, tx, person, server)
	if err == nil && len(accounts) == 0 {
		err = ErrNotFound
	}
	return accounts, err
}

func (a *App) personHistoryImportStatus(w http.ResponseWriter, r *http.Request) {
	actor, ok := a.principal(w, r, true)
	if !ok {
		return
	}
	person := r.PathValue("identity")
	server, err := strconv.ParseInt(r.URL.Query().Get("server"), 10, 64)
	if err != nil || server < 1 || len(r.URL.Query()) != 1 || !validAdminMemberCursor(person) {
		fail(w, 400, "INVALID_HISTORY_IMPORT", "Name one server")
		return
	}
	tx, err := a.store.reader.BeginTx(r.Context(), &sql.TxOptions{ReadOnly: true})
	if err != nil {
		domainError(w, err)
		return
	}
	defer tx.Rollback()
	accounts, err := personImportTarget(r.Context(), tx, actor.UUID, person, server)
	if err != nil {
		domainError(w, err)
		return
	}
	var kind string
	if err := tx.QueryRowContext(r.Context(), "SELECT service_type FROM media_servers WHERE id=?", server).Scan(&kind); err != nil {
		domainError(w, err)
		return
	}
	out := map[string]any{"server_id": server, "support": historyImportSupport(kind), "state": "never", "started_at": nil, "finished_at": nil,
		"added": 0, "person_added": 0, "already_stored": 0, "already_recorded": 0, "error_code": nil, "scope": nil}
	var state, started string
	var finished, code sql.NullString
	var added, stored, recorded int
	var account bool
	err = tx.QueryRowContext(r.Context(), "SELECT state,started_at,finished_at,added,already_stored,already_recorded,error_code,account_id IS NOT NULL FROM history_import_runs WHERE server_id=?", server).
		Scan(&state, &started, &finished, &added, &stored, &recorded, &code, &account)
	if err == nil {
		out["state"], out["started_at"], out["finished_at"], out["error_code"] = state, started, nullableString(finished), nullableString(code)
		out["added"], out["already_stored"], out["already_recorded"] = added, stored, recorded
		out["scope"] = map[bool]string{true: "account", false: "server"}[account]
		// The run's counts cover every account it read (all users for a full
		// import); this person's own new plays are those of their accounts
		// stored since the run started.
		query, args := `SELECT count(*) FROM history_imports WHERE server_id=? AND imported_at>=? AND account_id IN (`, []any{server, started}
		for i, id := range accounts {
			if i > 0 {
				query += ","
			}
			query += "?"
			args = append(args, id)
		}
		var personAdded int
		if err := tx.QueryRowContext(r.Context(), query+")", args...).Scan(&personAdded); err != nil {
			domainError(w, err)
			return
		}
		out["person_added"] = personAdded
	} else if !errors.Is(err, sql.ErrNoRows) {
		domainError(w, err)
		return
	}
	respond(w, 200, out)
}

func (a *App) startPersonHistoryImport(w http.ResponseWriter, r *http.Request) {
	actor, ok := a.principal(w, r, true)
	if !ok {
		return
	}
	person := r.PathValue("identity")
	var body struct {
		Server int64 `json:"server_id"`
	}
	if !decodeStrictBody(w, r, &body) {
		return
	}
	if body.Server < 1 || !validAdminMemberCursor(person) {
		fail(w, 400, "INVALID_HISTORY_IMPORT", "Name one server")
		return
	}
	// The person must have an account there before anything else is said
	// about the server.
	check, err := a.store.reader.BeginTx(r.Context(), &sql.TxOptions{ReadOnly: true})
	if err != nil {
		domainError(w, err)
		return
	}
	_, err = personImportTarget(r.Context(), check, actor.UUID, person, body.Server)
	check.Rollback()
	if err != nil {
		domainError(w, err)
		return
	}
	server, err := a.loadServer(r.Context(), body.Server)
	if err != nil {
		domainError(w, err)
		return
	}
	const unavailable = "This server keeps no play history MUM can import, or it is inactive."
	switch historyImportSupport(server.Type) {
	case "server":
		fail(w, 409, "HISTORY_FULL_IMPORT_ONLY", server.Type+" can't import a single user's history; run a full import of the server instead.")
		return
	case "none":
		fail(w, 409, "HISTORY_UNAVAILABLE", unavailable)
		return
	}
	if !server.EffectiveActive || !server.HasAPIKey {
		fail(w, 409, "HISTORY_UNAVAILABLE", unavailable)
		return
	}
	connection, err := newServerConnection(ProviderConfig{server.Type, server.URL, server.apiKey}, a.ProviderHTTP)
	if err != nil {
		fail(w, 409, "HISTORY_UNAVAILABLE", unavailable)
		return
	}
	reader, supported := connection.module().(accountHistoryReader)
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
	var accounts []string
	err = a.store.write(r.Context(), func(tx *sql.Tx) error {
		var err error
		if accounts, err = personImportTarget(r.Context(), tx, actor.UUID, person, body.Server); err != nil {
			return err
		}
		var running bool
		if err := tx.QueryRowContext(r.Context(), "SELECT EXISTS(SELECT 1 FROM history_import_runs WHERE server_id=? AND state='running')", body.Server).Scan(&running); err != nil {
			return err
		}
		if running {
			return errHistoryRunning
		}
		if _, err := tx.ExecContext(r.Context(), `INSERT INTO history_import_runs(server_id,state,started_at,account_id) VALUES(?,'running',?,?)
		 ON CONFLICT(server_id) DO UPDATE SET state='running',started_at=excluded.started_at,finished_at=NULL,total=0,read_count=0,added=0,already_stored=0,already_recorded=0,unknown_accounts=0,error_code=NULL,account_id=excluded.account_id`,
			body.Server, now, accounts[0]); err != nil {
			return err
		}
		return auditAction(r.Context(), tx, actor.UUID, "activity.history.person_import")
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
		state, code := "completed", ""
		for _, account := range accounts {
			state, code = a.importHistoryPages(a.provisionCtx, body.Server, server.Type, func(ctx context.Context, start, size int) (provider.HistoryPage, error) {
				return reader.AccountPlayHistory(ctx, account, start, size)
			})
			if state != "completed" {
				break
			}
		}
		a.finishHistoryImport(a.provisionCtx, body.Server, state, code)
	}()
	respond(w, 202, map[string]any{"server_id": body.Server, "state": "running", "started_at": now})
}
