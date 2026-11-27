package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"unicode/utf8"
)

// The log of one scheduled server refresh, shown under the task's details.
// Entries are written by MUM, never copied from a provider's error text:
// failures are explained from the fixed errors MUM's adapters return.

const (
	refreshRunsKept       = 20
	refreshLogMaxEntries  = 100
	refreshLogMaxText     = 300
	refreshRunsReturned   = 10
	refreshLogSuccess     = "success"
	refreshLogInformation = "info"
	refreshLogWarning     = "warning"
	refreshLogError       = "error"
)

type refreshLogEntry struct {
	Level   string `json:"level"`
	Message string `json:"message"`
	Detail  string `json:"detail,omitempty"`
}

// refreshLog collects a run's entries. Past the cap, the remaining entries
// are counted in one closing line instead of being stored.
type refreshLog struct {
	entries []refreshLogEntry
	dropped int
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
	l.entries = append(l.entries, refreshLogEntry{Level: level, Message: clipLogText(message), Detail: clipLogText(detail)})
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
	return string(out)
}

func plural(n int, one, many string) string {
	if n == 1 {
		return fmt.Sprintf("%d %s", n, one)
	}
	return fmt.Sprintf("%d %s", n, many)
}

// logListRefresh records the result of refreshing the server's user or
// library list.
func logListRefresh(log *refreshLog, scope string, receipt map[string]int) {
	if scope == "users" {
		log.add(refreshLogSuccess, "User list refreshed: "+plural(receipt["users"], "account", "accounts"),
			fmt.Sprintf("%d added, %d updated, %d removed", receipt["added"], receipt["updated"], receipt["removed"]))
		return
	}
	log.add(refreshLogSuccess, "Library list refreshed: "+plural(receipt["libraries"], "library", "libraries"), "")
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
	respond(w, 200, map[string]any{"server_id": server, "scope": scope, "runs": runs})
}
