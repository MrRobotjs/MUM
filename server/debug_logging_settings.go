package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"time"

	"app/server/providers/provider"
)

// The API Debug page's Debug Logging card: switch each service's HTTP or
// WebSocket stream on for a limited time, read the newest records, download
// the files or clear them. Administrators only; changes, downloads and
// clearing are audited.

type debugLogStream struct {
	Provider     string  `json:"provider"`
	ProviderName string  `json:"provider_name"`
	Transport    string  `json:"transport"`
	Enabled      bool    `json:"enabled"`
	EnabledUntil *string `json:"enabled_until"`
}

// requireAdministratorRead checks the signed-in administrator in a read-only
// transaction.
func (a *App) requireAdministratorRead(w http.ResponseWriter, r *http.Request) (Principal, bool) {
	p, ok := a.principal(w, r, true)
	if !ok {
		return p, false
	}
	tx, err := a.store.reader.BeginTx(r.Context(), &sql.TxOptions{ReadOnly: true})
	if err != nil {
		domainError(w, err)
		return p, false
	}
	defer tx.Rollback()
	if err := requirePermission(r.Context(), tx, p.UUID, "administrator"); err != nil {
		domainError(w, err)
		return p, false
	}
	return p, true
}

// debugLogStreams lists the streams of the services that have a server: HTTP
// for every service and WebSocket for those with a live socket.
func (a *App) debugLogStreams(ctx context.Context) ([]debugLogStream, error) {
	rows, err := a.store.reader.QueryContext(ctx, "SELECT DISTINCT service_type FROM media_servers")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	configured := map[string]bool{}
	for rows.Next() {
		var kind string
		if err := rows.Scan(&kind); err != nil {
			return nil, err
		}
		configured[kind] = true
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	streams := []debugLogStream{}
	for _, m := range mediaModules {
		id := m.Definition.ID
		if !configured[id] {
			continue
		}
		transports := []string{"http"}
		if _, live := m.New(provider.Config{}).(liveConnector); live {
			transports = append(transports, "websocket")
		}
		for _, transport := range transports {
			stream := debugLogStream{Provider: id, ProviderName: m.Definition.Name, Transport: transport}
			if until, on := a.debugLogs.until(id, transport); on {
				at := utcTimestamp(until)
				stream.Enabled, stream.EnabledUntil = true, &at
			}
			streams = append(streams, stream)
		}
	}
	return streams, nil
}

func (a *App) debugLoggingState(ctx context.Context) (map[string]any, error) {
	streams, err := a.debugLogStreams(ctx)
	if err != nil {
		return nil, err
	}
	files, err := a.debugLogs.list()
	if err != nil {
		return nil, err
	}
	return map[string]any{"available": a.debugLogs.dir != "", "window_hours": int(debugLogWindow / time.Hour), "streams": streams, "files": files, "dropped_records": a.debugLogs.dropped.Load()}, nil
}

func (a *App) getDebugLogging(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.requireAdministratorRead(w, r); !ok {
		return
	}
	state, err := a.debugLoggingState(r.Context())
	if err != nil {
		domainError(w, err)
		return
	}
	respond(w, 200, state)
}

// saveDebugLogging switches one stream on for the logging window, or off.
func (a *App) saveDebugLogging(w http.ResponseWriter, r *http.Request) {
	p, ok := a.principal(w, r, true)
	if !ok {
		return
	}
	var input struct {
		Provider  string `json:"provider"`
		Transport string `json:"transport"`
		Enabled   *bool  `json:"enabled"`
	}
	if !decodeBody(w, r, &input) {
		return
	}
	if input.Enabled == nil {
		fail(w, 400, "INVALID_DEBUG_LOGGING", "Say whether the stream is on")
		return
	}
	streams, err := a.debugLogStreams(r.Context())
	if err != nil {
		domainError(w, err)
		return
	}
	found := false
	for _, s := range streams {
		found = found || s.Provider == input.Provider && s.Transport == input.Transport
	}
	if !found {
		fail(w, 400, "INVALID_DEBUG_LOGGING", "This service has no such stream")
		return
	}
	key := debugLogSettingKey + debugStreamKey(input.Provider, input.Transport)
	until := time.Now().UTC().Add(debugLogWindow)
	err = a.store.write(r.Context(), func(tx *sql.Tx) error {
		if err := requirePermission(r.Context(), tx, p.UUID, "administrator"); err != nil {
			return err
		}
		action := "debug_logging.disable"
		if *input.Enabled {
			action = "debug_logging.enable"
			if err := putSetting(r.Context(), tx, key, until.Format(time.RFC3339Nano)); err != nil {
				return err
			}
		} else if _, err := tx.ExecContext(r.Context(), "DELETE FROM settings WHERE key=?", key); err != nil {
			return err
		}
		details, _ := json.Marshal(map[string]string{"provider": input.Provider, "transport": input.Transport})
		_, err := tx.ExecContext(r.Context(), `INSERT INTO audit_events(actor_uuid,action,details,occurred_at) VALUES(?,?,?,?)`, p.UUID, action, string(details), utcTimestamp(time.Now()))
		return err
	})
	if err != nil {
		domainError(w, err)
		return
	}
	if err := a.debugLogs.load(r.Context()); err != nil {
		domainError(w, err)
		return
	}
	state, err := a.debugLoggingState(r.Context())
	if err != nil {
		domainError(w, err)
		return
	}
	respond(w, 200, state)
}

// debugLogEntries returns the newest records of one stream, newest first.
func (a *App) debugLogEntries(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.requireAdministratorRead(w, r); !ok {
		return
	}
	query := r.URL.Query()
	providerID, transport := query.Get("provider"), query.Get("transport")
	if _, ok := findMediaModule(providerID); !ok || (transport != "http" && transport != "websocket") {
		fail(w, 400, "INVALID_DEBUG_LOG_QUERY", "Choose a service and http or websocket")
		return
	}
	limit := 50
	if raw := query.Get("limit"); raw != "" {
		n, err := strconv.Atoi(raw)
		if err != nil || n < 1 || n > debugLogTailLimit {
			fail(w, 400, "INVALID_DEBUG_LOG_QUERY", "Use a limit from 1 to 200")
			return
		}
		limit = n
	}
	entries, err := a.debugLogs.tail(providerID, transport, limit)
	if err != nil {
		domainError(w, err)
		return
	}
	respond(w, 200, map[string]any{"provider": providerID, "transport": transport, "entries": entries})
}

func (a *App) auditDebugLogs(ctx context.Context, actor, action string, details map[string]string) error {
	encoded, _ := json.Marshal(details)
	return a.store.write(ctx, func(tx *sql.Tx) error {
		if err := requirePermission(ctx, tx, actor, "administrator"); err != nil {
			return err
		}
		_, err := tx.ExecContext(ctx, `INSERT INTO audit_events(actor_uuid,action,details,occurred_at) VALUES(?,?,?,?)`, actor, action, string(encoded), utcTimestamp(time.Now()))
		return err
	})
}

// downloadDebugLog sends one log file. Only names the log itself writes are
// accepted, so no other file can be reached.
func (a *App) downloadDebugLog(w http.ResponseWriter, r *http.Request) {
	p, ok := a.requireAdministratorRead(w, r)
	if !ok {
		return
	}
	name := r.PathValue("name")
	if !debugLogFileName.MatchString(name) || a.debugLogs.dir == "" {
		fail(w, 404, "NOT_FOUND", "No such debug log")
		return
	}
	f, err := os.Open(filepath.Join(a.debugLogs.dir, name))
	if errors.Is(err, os.ErrNotExist) {
		fail(w, 404, "NOT_FOUND", "No such debug log")
		return
	}
	if err != nil {
		domainError(w, err)
		return
	}
	defer f.Close()
	if err := a.auditDebugLogs(r.Context(), p.UUID, "debug_logging.download", map[string]string{"file": name}); err != nil {
		domainError(w, err)
		return
	}
	w.Header().Set("Content-Type", "application/x-ndjson")
	w.Header().Set("Content-Disposition", `attachment; filename="mum-`+name+`.jsonl"`)
	w.WriteHeader(200)
	_, _ = f.WriteTo(w)
}

func (a *App) clearDebugLogs(w http.ResponseWriter, r *http.Request) {
	p, ok := a.requireAdministratorRead(w, r)
	if !ok {
		return
	}
	if err := a.auditDebugLogs(r.Context(), p.UUID, "debug_logging.clear", map[string]string{}); err != nil {
		domainError(w, err)
		return
	}
	if err := a.debugLogs.clear(); err != nil {
		domainError(w, err)
		return
	}
	state, err := a.debugLoggingState(r.Context())
	if err != nil {
		domainError(w, err)
		return
	}
	respond(w, 200, state)
}
