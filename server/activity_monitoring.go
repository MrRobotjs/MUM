package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"time"
)

type activityMonitorTask struct {
	Server         string  `json:"server_id"`
	Name           string  `json:"server_name"`
	Provider       string  `json:"provider"`
	Revision       int64   `json:"revision"`
	ServerRevision int64   `json:"server_revision"`
	Enabled        bool    `json:"enabled"`
	SocketEnabled  bool    `json:"socket_enabled"`
	SocketState    string  `json:"socket_state"`
	SocketError    string  `json:"socket_error"`
	Interval       int     `json:"interval_seconds"`
	State          string  `json:"state"`
	Code           string  `json:"last_code"`
	Next           *string `json:"next_run_at"`
	Started        *string `json:"started_at"`
	Finished       *string `json:"finished_at"`
	Attempts       int64   `json:"attempts"`
}
type activityMonitorChange struct {
	Actor              string `json:"expected_actor_uuid"`
	Revision           int64  `json:"revision"`
	ServerRevision     int64  `json:"server_revision"`
	Enabled            *bool  `json:"enabled"`
	SocketEnabled      *bool  `json:"socket_enabled"`
	Interval           int    `json:"interval_seconds"`
	CompleteVisibility bool   `json:"acknowledge_complete_session_visibility"`
}

// A system claim derives authority only from persisted, revision-bound owner
// consent. It cannot substitute for an interactive session on other operations.
func checkActivityMonitorClaim(ctx context.Context, tx *sql.Tx, c activityReadClaim) error {
	var valid bool
	err := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM activity_monitor_schedules q JOIN user_accounts u ON u.uuid=q.authorized_by JOIN media_servers s ON s.id=q.server_id WHERE q.server_id=? AND q.revision=? AND q.claim_token=? AND q.run_state='running' AND q.enabled=1 AND q.authorized_by=? AND q.configured_server_revision=s.config_revision AND julianday(q.lease_until)>julianday('now') AND u.kind='owner' AND u.is_active=1 AND (u.access_expires_at IS NULL OR julianday(u.access_expires_at)>julianday('now')))`, c.Server, c.MonitorRevision, c.Token, c.Actor).Scan(&valid)
	if err != nil {
		return err
	}
	if !valid {
		return ErrConflict
	}
	return nil
}
func activityMonitorAudit(ctx context.Context, tx *sql.Tx, actor, action string, server int64, code string) error {
	details, _ := json.Marshal(struct {
		Server int64  `json:"server_id"`
		Code   string `json:"code"`
	}{server, code})
	_, err := tx.ExecContext(ctx, `INSERT INTO audit_events(actor_uuid,action,details,occurred_at) VALUES(?,?,?,?)`, actor, action, string(details), utcTimestamp(time.Now()))
	return err
}
func finishActivityMonitor(ctx context.Context, tx *sql.Tx, c activityReadClaim, code string) error {
	state := "failed"
	if code == "SUCCEEDED" {
		state = "succeeded"
	}
	if code == "CANCELLED" {
		state = "cancelled"
	}
	result, err := tx.ExecContext(ctx, `UPDATE activity_monitor_schedules SET run_state=?,last_code=?,finished_at=?,claim_token=NULL,runner_id=NULL,lease_until=NULL,next_run_at=CASE WHEN enabled=1 THEN strftime('%Y-%m-%dT%H:%M:%fZ','now','+'||interval_seconds||' seconds') ELSE NULL END,revision=revision+1 WHERE server_id=? AND revision=? AND claim_token=? AND run_state='running'`, state, code, utcTimestamp(time.Now()), c.Server, c.MonitorRevision, c.Token)
	if err != nil {
		return err
	}
	n, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if n == 0 {
		return nil
	}
	return activityMonitorAudit(ctx, tx, c.Actor, "activity.monitor.finish", c.Server, code)
}
func (a *App) claimActivityMonitor(ctx context.Context) (*activityReadClaim, error) {
	var claim *activityReadClaim
	err := a.store.write(ctx, func(tx *sql.Tx) error {
		// Expired leases are recorded, not immediately replayed. Pending activity
		// is cleared only for the exact expired token, preserving newer reads.
		expired := `SELECT server_id FROM activity_monitor_schedules WHERE run_state='running' AND julianday(lease_until)<=julianday('now') ORDER BY server_id LIMIT 100`
		if _, err := tx.ExecContext(ctx, `UPDATE media_activity_state SET pending_token=NULL,pending_at=NULL,pending_until=NULL,last_result='failed',revision=revision+1 WHERE server_id IN (`+expired+`) AND pending_token=(SELECT claim_token FROM activity_monitor_schedules WHERE server_id=media_activity_state.server_id)`); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO audit_events(actor_uuid,action,details,occurred_at) SELECT authorized_by,'activity.monitor.interrupted',json_object('server_id',server_id,'code','INTERRUPTED'),? FROM activity_monitor_schedules WHERE server_id IN (`+expired+`)`, utcTimestamp(time.Now())); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `UPDATE activity_monitor_schedules SET run_state='interrupted',last_code='INTERRUPTED',finished_at=?,claim_token=NULL,runner_id=NULL,lease_until=NULL,next_run_at=CASE WHEN enabled=1 THEN strftime('%Y-%m-%dT%H:%M:%fZ','now','+'||interval_seconds||' seconds') ELSE NULL END,revision=revision+1 WHERE server_id IN (`+expired+`)`, utcTimestamp(time.Now())); err != nil {
			return err
		}
		c := activityReadClaim{Token: newUUID(), Started: time.Now().UTC()}
		var socketTriggered bool
		err := tx.QueryRowContext(ctx, `SELECT q.server_id,q.revision,q.authorized_by,s.service_type,s.config_revision,a.generation+1,a.mapping_revision,(q.socket_pending=1 AND q.socket_enabled=1) FROM activity_monitor_schedules q JOIN media_activity_state a ON a.server_id=q.server_id JOIN media_servers s ON s.id=q.server_id JOIN provider_settings p ON p.provider_id=s.service_type JOIN user_accounts u ON u.uuid=q.authorized_by WHERE q.enabled=1 AND q.run_state<>'running' AND julianday(q.next_run_at)<=julianday('now') AND (a.pending_token IS NULL OR julianday(a.pending_until)<=julianday('now')) AND s.is_active=1 AND p.enabled=1 AND s.config_revision=q.configured_server_revision AND s.service_type IN ('jellyfin','emby','plex') AND u.kind='owner' AND u.is_active=1 AND (u.access_expires_at IS NULL OR julianday(u.access_expires_at)>julianday('now')) ORDER BY q.next_run_at,q.server_id LIMIT 1`).Scan(&c.Server, &c.MonitorRevision, &c.Actor, &c.Provider, &c.ConfigRevision, &c.Generation, &c.MappingRevision, &socketTriggered)
		if errors.Is(err, sql.ErrNoRows) {
			return nil
		}
		if err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `UPDATE activity_monitor_schedules SET socket_pending=0,run_state='running',claim_token=?,runner_id=?,lease_until=?,started_at=?,attempts=attempts+1,revision=revision+1 WHERE server_id=?`, c.Token, a.scheduler.runner, utcTimestamp(c.Started.Add(30*time.Second)), utcTimestamp(c.Started), c.Server); err != nil {
			return err
		}
		c.MonitorRevision++
		if socketTriggered {
			c.Source = "ws"
		} else {
			c.Source = "http"
		}
		if _, err := tx.ExecContext(ctx, `UPDATE media_activity_state SET generation=?,pending_token=?,pending_at=?,pending_until=?,revision=revision+1 WHERE server_id=?`, c.Generation, c.Token, utcTimestamp(c.Started), utcTimestamp(c.Started.Add(20*time.Second)), c.Server); err != nil {
			return err
		}
		if err := activityMonitorAudit(ctx, tx, c.Actor, "activity.monitor.start", c.Server, "STARTED"); err != nil {
			return err
		}
		claim = &c
		return nil
	})
	if err != nil {
		return nil, err
	}
	return claim, nil
}
func (a *App) runOneActivityMonitor(parent context.Context) error {
	if !a.syncRun.TryLock() {
		return nil
	}
	defer a.syncRun.Unlock()
	ctx, cancel := context.WithTimeout(parent, 20*time.Second)
	defer cancel()
	c, err := a.claimActivityMonitor(ctx)
	if err != nil {
		if parent.Err() != nil && (errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded)) {
			return nil
		}
		return err
	}
	if c == nil {
		return nil
	}
	a.logger.Debug("Activity poll started", "server_id", c.Server, "provider", c.Provider)
	stage := "load_source"
	observed := 0
	var applied activityApplyResult
	server, err := a.loadServer(ctx, c.Server)
	if err == nil && (server.ConfigRevision != c.ConfigRevision || !server.EffectiveActive) {
		err = ErrConflict
	}
	if err == nil {
		stage = "provider_read"
		var provider *serverConnection
		provider, err = newServerConnection(ProviderConfig{server.Type, server.URL, server.apiKey}, a.ProviderHTTP)
		if err == nil {
			var snapshot activitySnapshot
			provider.locations = &a.locationCache
			snapshot, err = provider.readActivitySnapshot(ctx)
			if err == nil {
				observed = len(snapshot.Sessions)
				stage = "persist_snapshot"
				applied, err = a.store.applyActivitySnapshot(ctx, *c, snapshot)
			}
		}
	}
	if err == nil {
		a.logger.Info("Activity poll completed", "server_id", c.Server, "provider", c.Provider, "source", c.Source, "sessions", observed, "started", applied.Started, "updated", applied.Updated, "ended", applied.Ended, "duration_ms", time.Since(c.Started).Milliseconds())
		return nil
	}
	a.logger.Warn("Activity poll failed", "server_id", c.Server, "provider", c.Provider, "stage", stage, "code", consoleErrorCode(err), "duration_ms", time.Since(c.Started).Milliseconds())
	code := "FAILED"
	if ctx.Err() != nil || errors.Is(err, ErrConflict) || errors.Is(err, ErrForbidden) {
		code = "CANCELLED"
	}
	cleanup, stop := context.WithTimeout(context.Background(), 5*time.Second)
	defer stop()
	return a.store.write(cleanup, func(tx *sql.Tx) error {
		if _, err := tx.ExecContext(cleanup, `UPDATE media_activity_state SET pending_token=NULL,pending_at=NULL,pending_until=NULL,last_result='failed',revision=revision+1 WHERE server_id=? AND generation=? AND pending_token=?`, c.Server, c.Generation, c.Token); err != nil {
			return err
		}
		return finishActivityMonitor(cleanup, tx, *c, code)
	})
}

func (a *App) activityMonitorSettings(w http.ResponseWriter, r *http.Request) {
	actor, ok := a.principal(w, r, true)
	if !ok {
		return
	}
	if r.URL.RawQuery != "" {
		fail(w, 400, "INVALID_MONITOR_QUERY", "Monitoring settings take no query options")
		return
	}
	tx, err := a.beginAdminRoleRead(r.Context(), actor.UUID, bearer(r))
	if err != nil {
		domainError(w, err)
		return
	}
	defer tx.Rollback()
	rows, err := tx.QueryContext(r.Context(), `SELECT q.server_id,s.server_nickname,s.service_type,q.revision,s.config_revision,q.enabled,q.interval_seconds,q.run_state,q.last_code,q.next_run_at,q.started_at,q.finished_at,q.attempts,coalesce(q.runner_id,''),(s.is_active=1 AND p.enabled=1 AND q.configured_server_revision=s.config_revision AND EXISTS(SELECT 1 FROM user_accounts u WHERE u.uuid=q.authorized_by AND u.kind='owner' AND u.is_active=1 AND (u.access_expires_at IS NULL OR julianday(u.access_expires_at)>julianday('now')))),q.socket_enabled FROM activity_monitor_schedules q JOIN media_servers s ON s.id=q.server_id JOIN provider_settings p ON p.provider_id=s.service_type ORDER BY q.server_id LIMIT 1001`)
	if err != nil {
		domainError(w, err)
		return
	}
	a.scheduler.mu.Lock()
	running := a.scheduler.started && !a.scheduler.closing
	checkpointError := a.scheduler.checkpointErr != nil
	a.scheduler.mu.Unlock()
	tasks := []activityMonitorTask{}
	for rows.Next() {
		var task activityMonitorTask
		var id int64
		var runner string
		var eligible bool
		if err = rows.Scan(&id, &task.Name, &task.Provider, &task.Revision, &task.ServerRevision, &task.Enabled, &task.Interval, &task.State, &task.Code, &task.Next, &task.Started, &task.Finished, &task.Attempts, &runner, &eligible, &task.SocketEnabled); err != nil {
			break
		}
		task.Server = strconv.FormatInt(id, 10)
		task.SocketState, task.SocketError = a.providerSocketStatus(id, task.SocketEnabled, eligible && task.Enabled, running)
		if !task.Enabled {
			task.State = "disabled"
		} else if task.State == "running" {
			if runner != a.scheduler.runner {
				task.State = "recovering"
			}
		} else if !running {
			task.State = "stopped"
		} else if !eligible {
			task.State = "paused"
			task.Next = nil
		} else {
			task.State = "scheduled"
		}
		tasks = append(tasks, task)
	}
	if err == nil {
		err = rows.Err()
	}
	rows.Close()
	if len(tasks) > 1000 {
		err = ErrConflict
	}
	if err == nil {
		err = tx.Commit()
	}
	if err != nil {
		domainError(w, err)
		return
	}
	respond(w, 200, map[string]any{"actor_uuid": actor.UUID, "configuration_available": actor.Kind == "owner", "runtime_available": running, "checkpoint_error": checkpointError, "tasks": tasks})
}
func (a *App) configureActivityMonitor(w http.ResponseWriter, r *http.Request) {
	actor, ok := a.principal(w, r, true)
	if !ok {
		return
	}
	server, ok := pathID(w, r, "server")
	if !ok {
		return
	}
	var input activityMonitorChange
	if !decodeStrictBody(w, r, &input) {
		return
	}
	if actor.Kind != "owner" || actor.UUID != input.Actor {
		domainError(w, ErrForbidden)
		return
	}
	socketEnabled := input.SocketEnabled != nil && *input.SocketEnabled
	if r.URL.RawQuery != "" || input.Enabled == nil || input.Revision < 1 || input.ServerRevision < 0 || input.Interval < 15 || input.Interval > 3600 || *input.Enabled && !input.CompleteVisibility || socketEnabled && !*input.Enabled {
		fail(w, 400, "INVALID_ACTIVITY_MONITOR", "Use exact revisions, enabled, 15–3600 seconds and acknowledge complete administrative session visibility before enabling")
		return
	}
	var revision int64
	err := a.store.write(r.Context(), func(tx *sql.Tx) error {
		if err := notificationAuthority(r.Context(), tx, actor.UUID, bearer(r)); err != nil {
			return err
		}
		current, err := loadPrincipal(r.Context(), tx, actor.UUID)
		if err != nil {
			return err
		}
		if current.Kind != "owner" {
			return ErrForbidden
		}
		var stored, serverRevision int64
		var active bool
		var oldToken *string
		var provider string
		err = tx.QueryRowContext(r.Context(), `SELECT q.revision,s.config_revision,(s.is_active=1 AND p.enabled=1),q.claim_token,s.service_type FROM activity_monitor_schedules q JOIN media_servers s ON s.id=q.server_id JOIN provider_settings p ON p.provider_id=s.service_type WHERE q.server_id=?`, server).Scan(&stored, &serverRevision, &active, &oldToken, &provider)
		if err != nil {
			return err
		}
		if stored != input.Revision || serverRevision != input.ServerRevision || *input.Enabled && !active {
			return ErrConflict
		}
		if oldToken != nil {
			if _, err := tx.ExecContext(r.Context(), `UPDATE media_activity_state SET pending_token=NULL,pending_at=NULL,pending_until=NULL,last_result='failed',revision=revision+1 WHERE server_id=? AND pending_token=?`, server, *oldToken); err != nil {
				return err
			}
		}
		_, err = tx.ExecContext(r.Context(), `UPDATE activity_monitor_schedules SET socket_pending=0,socket_enabled=?,socket_revision=socket_revision+1,enabled=?,interval_seconds=?,configured_server_revision=?,authorized_by=?,next_run_at=CASE WHEN ? THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') ELSE NULL END,run_state=CASE WHEN run_state='running' THEN 'cancelled' ELSE run_state END,last_code=CASE WHEN run_state='running' THEN 'CANCELLED' ELSE last_code END,finished_at=CASE WHEN run_state='running' THEN ? ELSE finished_at END,claim_token=NULL,runner_id=NULL,lease_until=NULL,revision=revision+1 WHERE server_id=?`, socketEnabled, *input.Enabled, input.Interval, serverRevision, actor.UUID, *input.Enabled, utcTimestamp(time.Now()), server)
		if err != nil {
			return err
		}
		revision = stored + 1
		details, _ := json.Marshal(struct {
			Server             int64
			Enabled            bool
			Interval           int
			Before, After      int64
			CompleteVisibility bool
			SocketEnabled      bool
		}{server, *input.Enabled, input.Interval, stored, revision, input.CompleteVisibility, socketEnabled})
		_, err = tx.ExecContext(r.Context(), `INSERT INTO audit_events(actor_uuid,action,details,occurred_at) VALUES(?,'activity.monitor.configure',?,?)`, actor.UUID, string(details), utcTimestamp(time.Now()))
		return err
	})
	if err != nil {
		domainError(w, err)
		return
	}
	respond(w, 200, map[string]any{"actor_uuid": actor.UUID, "server_id": strconv.FormatInt(server, 10), "revision": revision})
	a.logger.Info("Activity monitoring saved", "server_id", server, "enabled", *input.Enabled, "interval_seconds", input.Interval, "socket_enabled", socketEnabled)
}
