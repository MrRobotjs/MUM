package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"
)

// The log of one scheduled server refresh, shown under the task's details.
// Entries are written by MUM, never copied from a provider's error text:
// failures are explained from the fixed errors MUM's adapters return.

const (
	refreshRunsKept       = 20
	refreshLogMaxEntries  = 100
	refreshLogMaxText     = 300
	refreshLogEntryItems  = 25
	refreshLogRunItems    = 300
	refreshLogMaxBytes    = 65536
	refreshRunsReturned   = 10
	refreshLogSuccess     = "success"
	refreshLogInformation = "info"
	refreshLogWarning     = "warning"
	refreshLogError       = "error"
)

type refreshLogEntry struct {
	Level   string           `json:"level"`
	Message string           `json:"message"`
	Detail  string           `json:"detail,omitempty"`
	Items   []refreshLogItem `json:"items,omitempty"`
	More    int              `json:"more_items,omitempty"`
}

// refreshLogItem is one title or account an entry is about. ItemID names a
// catalogue row; its library and signed poster link are added when the log is
// read, for items that still exist.
type refreshLogItem struct {
	Title     string `json:"title"`
	Change    string `json:"change"`
	Note      string `json:"note,omitempty"`
	ItemID    int64  `json:"item_id,omitempty"`
	LibraryID int64  `json:"library_id,omitempty"`
	PosterURL string `json:"poster_url,omitempty"`
}

// refreshLog collects a run's entries. Past the cap, the remaining entries
// are counted in one closing line instead of being stored.
type refreshLog struct {
	entries []refreshLogEntry
	dropped int
	items   int
	warned  bool
	failed  bool
}

func clipLogText(v string) string {
	if utf8.RuneCountInString(v) <= refreshLogMaxText {
		return v
	}
	return string([]rune(v)[:refreshLogMaxText-1]) + "…"
}

func (l *refreshLog) add(level, message, detail string) {
	l.addItems(level, message, detail, nil, 0)
}

// addItems adds an entry listing the items it is about; total counts every
// item, including those past the per-entry and per-run caps.
func (l *refreshLog) addItems(level, message, detail string, items []refreshLogItem, total int) {
	switch level {
	case refreshLogWarning:
		l.warned = true
	case refreshLogError:
		l.failed = true
	}
	if len(l.entries) >= refreshLogMaxEntries {
		l.dropped++
		return
	}
	keep := min(len(items), refreshLogEntryItems, max(refreshLogRunItems-l.items, 0))
	entry := refreshLogEntry{Level: level, Message: clipLogText(message), Detail: clipLogText(detail), More: max(total-keep, 0)}
	for _, item := range items[:keep] {
		item.Title, item.Note = clipLogText(item.Title), clipLogText(item.Note)
		entry.Items = append(entry.Items, item)
	}
	l.items += keep
	l.entries = append(l.entries, entry)
}

func (l *refreshLog) encoded() string {
	entries := l.entries
	if l.dropped > 0 {
		entries = append(entries, refreshLogEntry{Level: refreshLogInformation, Message: fmt.Sprintf("%d more entries were not kept", l.dropped)})
	}
	if entries == nil {
		entries = []refreshLogEntry{}
	}
	out, _ := json.Marshal(entries)
	// Over the stored size, the item lists go first; the entries stay.
	if len(out) > refreshLogMaxBytes {
		trimmed := make([]refreshLogEntry, len(entries))
		for n, entry := range entries {
			entry.More += len(entry.Items)
			entry.Items = nil
			trimmed[n] = entry
		}
		out, _ = json.Marshal(trimmed)
	}
	return string(out)
}

func plural(n int, one, many string) string {
	if n == 1 {
		return fmt.Sprintf("%d %s", n, one)
	}
	return fmt.Sprintf("%d %s", n, many)
}

// logListRefresh records the result of refreshing the server's user or
// library list; accounts lists the accounts the user refresh changed.
func logListRefresh(log *refreshLog, scope string, receipt map[string]int, accounts []refreshLogItem) {
	if scope == "users" {
		log.addItems(refreshLogSuccess, "User list refreshed: "+plural(receipt["users"], "account", "accounts"),
			fmt.Sprintf("%d added, %d updated, %d removed", receipt["added"], receipt["updated"], receipt["removed"]), accounts, receipt["added"]+receipt["updated"]+receipt["removed"])
		return
	}
	log.add(refreshLogSuccess, "Library list refreshed: "+plural(receipt["libraries"], "library", "libraries"), "")
}

// refreshAccountChanges reads the accounts a user refresh that started at
// since added, updated or removed: the sync stamps each account it writes.
func (a *App) refreshAccountChanges(ctx context.Context, server int64, since string) ([]refreshLogItem, error) {
	rows, err := a.store.reader.QueryContext(ctx, `SELECT coalesce(nullif(external_username,''),nullif(external_email,''),'Unnamed account'),
	 CASE WHEN julianday(created_at)>=julianday(?) THEN 'added' WHEN removed_at IS NOT NULL AND julianday(removed_at)>=julianday(?) THEN 'removed' ELSE 'updated' END AS change
	 FROM service_accounts WHERE server_id=? AND (julianday(updated_at)>=julianday(?) OR (removed_at IS NOT NULL AND julianday(removed_at)>=julianday(?)))
	 ORDER BY CASE change WHEN 'added' THEN 0 WHEN 'updated' THEN 1 ELSE 2 END,1 COLLATE NOCASE LIMIT ?`, since, since, server, since, since, refreshLogEntryItems)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []refreshLogItem
	for rows.Next() {
		var item refreshLogItem
		if err := rows.Scan(&item.Title, &item.Change); err != nil {
			return nil, err
		}
		out = append(out, item)
	}
	return out, rows.Err()
}

// refreshProblems explains the fixed errors the adapters return, matched by
// their exact text.
var refreshProblems = []struct{ text, code, explanation string }{
	{"Tofa merged show identity unavailable", "TOFA_SHOW_NOT_MATCHED", "This show has no TMDB match, so its versions can't be combined. Match it in Tofa."},
	{"Tofa file show identity unavailable", "TOFA_VERSION_NOT_MATCHED", "Another copy of this show in the library has no TMDB match, so MUM can't tell whether it belongs to this show. Match it in Tofa."},
	{"Tofa library count mismatch", "TOFA_LIBRARY_COUNT_MISMATCH", "The library changed in Tofa while MUM was reading it. The next run will try again."},
	{"Tofa catalogue changed during synchronization", "TOFA_CATALOGUE_CHANGED", "The library changed in Tofa while MUM was reading it. The next run will try again."},
	{"Tofa show library changed", "TOFA_SHOW_MOVED", "The show moved to another library during the refresh. The next run will try again."},
	{"incomplete Tofa catalogue page", "TOFA_INCOMPLETE_CATALOGUE_PAGE", "Tofa sent fewer items than it said the library has. The next run will try again."},
	{"incomplete Tofa catalogue", "TOFA_INCOMPLETE_CATALOGUE", "Tofa sent fewer items than it said the library has. The next run will try again."},
	{"Tofa primary profile unavailable", "TOFA_PROFILE_UNAVAILABLE", "Tofa has no main profile MUM can read the catalogue through."},
	{"Tofa primary profile is restricted or incomplete", "TOFA_PROFILE_RESTRICTED", "Tofa's main profile has content restrictions, so MUM can't read the whole catalogue through it."},
	{"Tofa library unavailable", "TOFA_LIBRARY_UNAVAILABLE", "Tofa no longer reports this library."},
	{"Tofa library statistics unavailable", "TOFA_LIBRARY_UNAVAILABLE", "Tofa no longer reports this library."},
	{"Tofa catalogue revision unavailable", "TOFA_REVISION_UNAVAILABLE", "Tofa didn't report the library's revision, so MUM can't tell whether it changed while reading."},
	{"Tofa file snapshot too large", "TOFA_FILE_LIST_TOO_LARGE", "The library's file list is larger than MUM reads in one refresh."},
}

// refreshProblem gives a failure's log code and an explanation an
// administrator can act on.
func refreshProblem(err error) (code, explanation string) {
	text := err.Error()
	for _, p := range refreshProblems {
		if text == p.text || strings.HasSuffix(text, ": "+p.text) {
			return p.code, p.explanation
		}
	}
	if strings.HasPrefix(text, "invalid Tofa ") || strings.Contains(text, ": invalid Tofa ") {
		return "TOFA_INVALID_RESPONSE", "Tofa sent data MUM couldn't read. Check that Tofa is up to date."
	}
	var upstream *providerHTTPError
	switch {
	case errors.Is(err, context.DeadlineExceeded):
		return "TIMEOUT", "The server took too long to answer. The next run will try again."
	case errors.Is(err, context.Canceled):
		return "CANCELLED", "MUM stopped the refresh, for example while shutting down."
	case errors.Is(err, ErrForbidden):
		return "AUTHORITY_REJECTED", "The owner account that authorizes background refreshes is inactive or expired."
	case errors.Is(err, ErrConflict), errors.Is(err, errCatalogueLibraryChanged):
		return "REVISION_OR_AUTHORITY_CHANGED", "The server's settings or the library changed during the refresh. The next run uses the new settings."
	case errors.As(err, &upstream):
		if upstream.StatusCode == http.StatusUnauthorized || upstream.StatusCode == http.StatusForbidden {
			return "UPSTREAM_AUTH_REJECTED", "The server rejected MUM's API key. Check the key in this server's settings."
		}
		return "UPSTREAM_HTTP_ERROR", fmt.Sprintf("The server answered with an error (HTTP %d).", upstream.StatusCode)
	}
	code = consoleErrorCode(err)
	return code, "MUM couldn't finish this step. The server log records it as " + code + "."
}

// saveRefreshRun records a finished run inside the transaction that closes
// its claim, keeping the most recent runs of that server and scope.
func saveRefreshRun(ctx context.Context, tx *sql.Tx, claim *serverRefreshClaim, started, finished, outcome string, log *refreshLog) error {
	if _, err := tx.ExecContext(ctx, `INSERT INTO server_refresh_runs(server_id,scope,started_at,finished_at,outcome,entries) VALUES(?,?,?,?,?,?)`,
		claim.Server, claim.Scope, started, finished, outcome, log.encoded()); err != nil {
		return err
	}
	_, err := tx.ExecContext(ctx, `DELETE FROM server_refresh_runs WHERE server_id=? AND scope=? AND id NOT IN (SELECT id FROM server_refresh_runs WHERE server_id=? AND scope=? ORDER BY id DESC LIMIT ?)`,
		claim.Server, claim.Scope, claim.Server, claim.Scope, refreshRunsKept)
	return err
}

type refreshRun struct {
	ID       int64             `json:"id"`
	Started  string            `json:"started_at"`
	Finished string            `json:"finished_at"`
	Outcome  string            `json:"outcome"`
	Entries  []refreshLogEntry `json:"entries"`
}

// serverRefreshRuns lists a refresh task's recent runs, newest first, for the
// administrators who can see the scheduled tasks.
func (a *App) serverRefreshRuns(w http.ResponseWriter, r *http.Request) {
	actor, ok := a.principal(w, r, true)
	if !ok {
		return
	}
	server, ok := pathID(w, r, "server")
	if !ok {
		return
	}
	query := r.URL.Query()
	scope := query.Get("scope")
	if len(query) != 1 || (scope != "users" && scope != "libraries") {
		fail(w, 400, "INVALID_TASK_QUERY", "Use scope=users or scope=libraries")
		return
	}
	tx, err := a.beginAdminRoleRead(r.Context(), actor.UUID, bearer(r))
	if err != nil {
		domainError(w, err)
		return
	}
	defer tx.Rollback()
	var exists bool
	if err := tx.QueryRowContext(r.Context(), "SELECT EXISTS(SELECT 1 FROM server_refresh_schedules WHERE server_id=? AND scope=?)", server, scope).Scan(&exists); err != nil {
		domainError(w, err)
		return
	}
	if !exists {
		fail(w, 404, "NOT_FOUND", "This server has no such refresh task")
		return
	}
	rows, err := tx.QueryContext(r.Context(), "SELECT id,started_at,finished_at,outcome,entries FROM server_refresh_runs WHERE server_id=? AND scope=? ORDER BY id DESC LIMIT ?", server, scope, refreshRunsReturned)
	if err != nil {
		domainError(w, err)
		return
	}
	defer rows.Close()
	runs := []refreshRun{}
	for rows.Next() {
		var run refreshRun
		var entries string
		if err := rows.Scan(&run.ID, &run.Started, &run.Finished, &run.Outcome, &entries); err != nil {
			domainError(w, err)
			return
		}
		if err := json.Unmarshal([]byte(entries), &run.Entries); err != nil {
			domainError(w, ErrConflict)
			return
		}
		if run.Entries == nil {
			run.Entries = []refreshLogEntry{}
		}
		runs = append(runs, run)
	}
	if err := rows.Err(); err != nil {
		domainError(w, err)
		return
	}
	rows.Close()
	// Posters are shown to administrators who can read the catalogue.
	session, authorityErr := readCatalogueAuthority(r.Context(), tx, actor.UUID, bearer(r))
	if authorityErr == nil {
		if err := a.addRefreshLogPosters(r.Context(), tx, server, session, runs); err != nil {
			domainError(w, err)
			return
		}
	}
	respond(w, 200, map[string]any{"server_id": server, "scope": scope, "runs": runs})
}

// addRefreshLogPosters fills in the library and poster link of each logged
// item that is still in this server's catalogue.
func (a *App) addRefreshLogPosters(ctx context.Context, tx *sql.Tx, server int64, session string, runs []refreshRun) error {
	lookup, err := tx.PrepareContext(ctx, "SELECT library_id,coalesce(thumb_path,'')<>'' FROM media_items WHERE id=? AND server_id=?")
	if err != nil {
		return err
	}
	defer lookup.Close()
	now := time.Now()
	for _, run := range runs {
		for _, entry := range run.Entries {
			for n := range entry.Items {
				item := &entry.Items[n]
				if item.ItemID <= 0 {
					continue
				}
				var library int64
				var poster bool
				err := lookup.QueryRowContext(ctx, item.ItemID, server).Scan(&library, &poster)
				if errors.Is(err, sql.ErrNoRows) {
					item.ItemID = 0
					continue
				}
				if err != nil {
					return err
				}
				item.LibraryID = library
				if poster {
					item.PosterURL = a.catalogueImageURL(session, item.ItemID, now)
				}
			}
		}
	}
	return nil
}
