package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"sync"
	"time"
)

type syncScheduler struct {
	mu               sync.Mutex
	ctx              context.Context
	cancel           context.CancelFunc
	done             chan struct{}
	started, closing bool
	runner           string
	checkpointErr    error
}
type scheduledSyncClaim struct {
	Server, Revision int64
	Actor, Token     string
}
type scheduledSyncTask struct {
	Name           string  `json:"server_name"`
	Server         int64   `json:"server_id"`
	Revision       int64   `json:"revision"`
	ServerRevision int64   `json:"server_revision"`
	Enabled        bool    `json:"enabled"`
	Interval       int     `json:"interval_seconds"`
	State          string  `json:"state"`
	Next           *string `json:"next_run_time"`
	Started        *string `json:"started_at"`
	Finished       *string `json:"finished_at"`
	Code           string  `json:"last_code"`
	Attempts       int64   `json:"attempts"`
}

func (a *App) StartScheduler() error {
	s := a.scheduler
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closing {
		return ErrConflict
	}
	if s.started {
		return nil
	}
	s.started = true
	go a.superviseProviderSockets(s.ctx)
	go func() {
		defer close(s.done)
		defer func() { s.cancel(); <-a.providerSockets.done }()
		ticker := time.NewTicker(time.Second)
		defer ticker.Stop()
		for {
			if s.ctx.Err() != nil {
				return
			}
			if err := a.reconcileLocalExpiry(s.ctx); err != nil {
				s.mu.Lock()
				s.checkpointErr = err
				s.mu.Unlock()
			}
			if err := a.reconcileServiceExpiry(s.ctx); err != nil {
				s.mu.Lock()
				s.checkpointErr = err
				s.mu.Unlock()
			}
			if err := a.runOneScheduledSync(s.ctx); err != nil {
				s.mu.Lock()
				s.checkpointErr = err
				s.mu.Unlock()
			}
			if s.ctx.Err() == nil {
				if err := a.runOneActivityMonitor(s.ctx); err != nil {
					s.mu.Lock()
					s.checkpointErr = err
					s.mu.Unlock()
				}
			}
			select {
			case <-s.ctx.Done():
				return
			case <-ticker.C:
			}
		}
	}()
	return nil
}
func (a *App) StopScheduler() {
	s := a.scheduler
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closing {
		return
	}
	s.closing = true
	s.cancel()
	if !s.started {
		close(s.done)
	}
}
func (a *App) WaitScheduler(ctx context.Context) error {
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-a.scheduler.done:
		a.scheduler.mu.Lock()
		defer a.scheduler.mu.Unlock()
		return a.scheduler.checkpointErr
	}
}
func (a *App) CloseScheduler() { a.StopScheduler(); _ = a.WaitScheduler(context.Background()) }

func checkScheduledSyncClaim(ctx context.Context, tx *sql.Tx, c *scheduledSyncClaim) error {
	var valid bool
	err := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM server_sync_schedules s JOIN user_accounts u ON u.uuid=s.authorized_by WHERE s.server_id=? AND s.revision=? AND s.claim_token=? AND s.run_state='running' AND s.enabled=1 AND julianday(s.lease_until)>julianday('now') AND s.authorized_by=? AND u.kind='owner' AND u.is_active=1 AND (u.access_expires_at IS NULL OR julianday(u.access_expires_at)>julianday('now')))`, c.Server, c.Revision, c.Token, c.Actor).Scan(&valid)
	if err != nil {
		return err
	}
	if !valid {
		return ErrConflict
	}
	return nil
}
func finishScheduledSync(ctx context.Context, tx *sql.Tx, c *scheduledSyncClaim, code string) error {
	state := "failed"
	if code == "SUCCEEDED" {
		state = "succeeded"
	}
	if code == "CANCELLED" {
		state = "cancelled"
	}
	result, err := tx.ExecContext(ctx, `UPDATE server_sync_schedules SET run_state=?,last_code=?,finished_at=?,claim_token=NULL,runner_id=NULL,lease_until=NULL,revision=revision+1 WHERE server_id=? AND claim_token=? AND run_state='running'`, state, code, utcTimestamp(time.Now()), c.Server, c.Token)
	if err != nil {
		return err
	}
	count, err := result.RowsAffected()
	if err != nil || count == 0 {
		return err
	}
	details, _ := json.Marshal(struct {
		Server int64  `json:"server_id"`
		Code   string `json:"code"`
	}{c.Server, code})
	_, err = tx.ExecContext(ctx, `INSERT INTO audit_events(actor_uuid,action,details,occurred_at) VALUES(?,'schedule.finish',?,?)`, c.Actor, string(details), utcTimestamp(time.Now()))
	return err
}
func (a *App) claimScheduledSync(ctx context.Context) (*scheduledSyncClaim, error) {
	var claim *scheduledSyncClaim
	err := a.store.write(ctx, func(tx *sql.Tx) error {
		now := utcTimestamp(time.Now())
		expired := `SELECT server_id FROM server_sync_schedules WHERE run_state='running' AND julianday(lease_until)<=julianday(?) ORDER BY server_id LIMIT 100`
		if _, err := tx.ExecContext(ctx, `INSERT INTO audit_events(actor_uuid,action,details,occurred_at) SELECT authorized_by,'schedule.interrupted',json_object('server_id',server_id,'code','INTERRUPTED'),? FROM server_sync_schedules WHERE server_id IN (`+expired+`)`, now, now); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `UPDATE server_sync_schedules SET run_state='interrupted',last_code='INTERRUPTED',finished_at=?,claim_token=NULL,runner_id=NULL,lease_until=NULL,revision=revision+1,next_run_at=CASE WHEN enabled=1 THEN strftime('%Y-%m-%dT%H:%M:%fZ',?,'+'||interval_seconds||' seconds') ELSE NULL END WHERE server_id IN (`+expired+`)`, now, now, now); err != nil {
			return err
		}
		c := scheduledSyncClaim{}
		var interval int
		err := tx.QueryRowContext(ctx, `SELECT q.server_id,q.revision,q.authorized_by,q.interval_seconds FROM server_sync_schedules q JOIN media_servers s ON s.id=q.server_id JOIN provider_settings p ON p.provider_id=s.service_type JOIN user_accounts u ON u.uuid=q.authorized_by WHERE q.enabled=1 AND q.run_state<>'running' AND julianday(q.next_run_at)<=julianday(?) AND s.is_active=1 AND p.enabled=1 AND u.kind='owner' AND u.is_active=1 AND (u.access_expires_at IS NULL OR julianday(u.access_expires_at)>julianday(?)) ORDER BY q.next_run_at,q.server_id LIMIT 1`, now, now).Scan(&c.Server, &c.Revision, &c.Actor, &interval)
		if errors.Is(err, sql.ErrNoRows) {
			return nil
		}
		if err != nil {
			return err
		}
		c.Token = newUUID()
		if _, err := tx.ExecContext(ctx, `UPDATE server_sync_schedules SET run_state='running',claim_token=?,runner_id=?,lease_until=?,started_at=?,next_run_at=?,attempts=attempts+1,revision=revision+1 WHERE server_id=? AND revision=?`, c.Token, a.scheduler.runner, utcTimestamp(time.Now().Add(90*time.Second)), now, utcTimestamp(time.Now().Add(time.Duration(interval)*time.Second)), c.Server, c.Revision); err != nil {
			return err
		}
		c.Revision++
		claim = &c
		details, _ := json.Marshal(struct {
			Server int64 `json:"server_id"`
		}{c.Server})
		_, err = tx.ExecContext(ctx, `INSERT INTO audit_events(actor_uuid,action,details,occurred_at) VALUES(?,'schedule.start',?,?)`, c.Actor, string(details), now)
		return err
	})
	return claim, err
}
func (a *App) runOneScheduledSync(parent context.Context) error {
	if !a.syncRun.TryLock() {
		return nil
	}
	defer a.syncRun.Unlock()
	ctx, cancel := context.WithTimeout(parent, 20*time.Second)
	defer cancel()
	claim, err := a.claimScheduledSync(ctx)
	if err != nil || claim == nil {
		if err != nil && parent.Err() != nil && (errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded)) {
			if claim == nil {
				return nil
			}
			cleanup, stop := context.WithTimeout(context.Background(), 5*time.Second)
			defer stop()
			return a.store.write(cleanup, func(tx *sql.Tx) error { return finishScheduledSync(cleanup, tx, claim, "CANCELLED") })
		}
		return err
	}
	server, err := a.loadServer(ctx, claim.Server)
	if err == nil {
		principal, loadErr := loadPrincipal(ctx, a.store.reader, claim.Actor)
		if loadErr != nil {
			err = loadErr
		} else {
			a.setSyncProgress(true, principal, 1, 1, server.Name)
			defer a.setSyncProgress(false, principal, 0, 0, "")
			_, err = a.syncServerClaimed(ctx, claim.Actor, "", server, true, true, claim)
		}
	}
	if err == nil {
		return nil
	}
	code := "FAILED"
	if ctx.Err() != nil || errors.Is(err, ErrConflict) || errors.Is(err, ErrForbidden) {
		code = "CANCELLED"
	}
	cleanup, stop := context.WithTimeout(context.Background(), 5*time.Second)
	defer stop()
	return a.store.write(cleanup, func(tx *sql.Tx) error { return finishScheduledSync(cleanup, tx, claim, code) })
}

func (a *App) scheduledTasks(w http.ResponseWriter, r *http.Request) {
	actor, ok := a.principal(w, r, true)
	if !ok {
		return
	}
	if len(r.URL.Query()) != 0 {
		fail(w, 400, "INVALID_TASK_QUERY", "Task reads take no query options")
		return
	}
	tx, err := a.beginAdminRoleRead(r.Context(), actor.UUID, bearer(r))
	if err != nil {
		domainError(w, err)
		return
	}
	defer tx.Rollback()
	rows, err := tx.QueryContext(r.Context(), `SELECT q.server_id,q.revision,s.revision,s.server_nickname,q.enabled,q.interval_seconds,q.run_state,q.next_run_at,q.started_at,q.finished_at,q.last_code,q.attempts,coalesce(q.runner_id,''),(s.is_active=1 AND p.enabled=1 AND EXISTS(SELECT 1 FROM user_accounts u WHERE u.uuid=q.authorized_by AND u.kind='owner' AND u.is_active=1 AND (u.access_expires_at IS NULL OR julianday(u.access_expires_at)>julianday('now')))) FROM server_sync_schedules q JOIN media_servers s ON s.id=q.server_id JOIN provider_settings p ON p.provider_id=s.service_type ORDER BY q.server_id LIMIT 1001`)
	if err != nil {
		domainError(w, err)
		return
	}
	a.scheduler.mu.Lock()
	running := a.scheduler.started && !a.scheduler.closing
	checkpointError := a.scheduler.checkpointErr != nil
	a.scheduler.mu.Unlock()
	tasks := []scheduledSyncTask{}
	for rows.Next() {
		var task scheduledSyncTask
		var runner string
		var eligible bool
		if err = rows.Scan(&task.Server, &task.Revision, &task.ServerRevision, &task.Name, &task.Enabled, &task.Interval, &task.State, &task.Next, &task.Started, &task.Finished, &task.Code, &task.Attempts, &runner, &eligible); err != nil {
			break
		}
		if task.State == "running" {
			if runner != a.scheduler.runner {
				task.State = "recovering"
			}
		} else if !task.Enabled {
			task.State = "disabled"
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
	respond(w, 200, map[string]any{"actor_uuid": actor.UUID, "runtime_available": running, "checkpoint_error": checkpointError, "configuration_available": actor.Kind == "owner", "generated_at": utcTimestamp(time.Now()), "tasks": tasks})
}
func (a *App) configureScheduledSync(w http.ResponseWriter, r *http.Request) {
	actor, ok := a.principal(w, r, true)
	if !ok {
		return
	}
	server, ok := pathID(w, r, "server")
	if !ok {
		return
	}
	var input struct {
		Actor          string `json:"expected_actor_uuid"`
		Revision       int64  `json:"revision"`
		ServerRevision int64  `json:"server_revision"`
		Enabled        *bool  `json:"enabled"`
		Interval       int    `json:"interval_seconds"`
	}
	if !decodeStrictBody(w, r, &input) {
		return
	}
	if input.Actor != actor.UUID || actor.Kind != "owner" {
		domainError(w, ErrForbidden)
		return
	}
	if len(r.URL.Query()) != 0 || input.Enabled == nil || input.Revision < 1 || input.ServerRevision < 0 || input.Interval < 60 || input.Interval > 86400 {
		fail(w, 400, "INVALID_SCHEDULE", "Use exact revisions, enabled state and an interval from 60 to 86400 seconds")
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
		var enabled, active bool
		var interval int
		err = tx.QueryRowContext(r.Context(), `SELECT q.revision,s.revision,q.enabled,q.interval_seconds,(s.is_active=1 AND p.enabled=1) FROM server_sync_schedules q JOIN media_servers s ON s.id=q.server_id JOIN provider_settings p ON p.provider_id=s.service_type WHERE q.server_id=?`, server).Scan(&stored, &serverRevision, &enabled, &interval, &active)
		if err != nil {
			return err
		}
		if stored != input.Revision || serverRevision != input.ServerRevision {
			return ErrConflict
		}
		if *input.Enabled && !active {
			return ErrConflict
		}
		if enabled == *input.Enabled && interval == input.Interval {
			return ErrConflict
		}
		var next *string
		if *input.Enabled {
			now := utcTimestamp(time.Now())
			next = &now
		}
		_, err = tx.ExecContext(r.Context(), `UPDATE server_sync_schedules SET enabled=?,interval_seconds=?,authorized_by=?,next_run_at=?,revision=revision+1 WHERE server_id=?`, *input.Enabled, input.Interval, actor.UUID, next, server)
		if err != nil {
			return err
		}
		revision = stored + 1
		details, _ := json.Marshal(struct {
			Server        int64 `json:"server_id"`
			Enabled       bool  `json:"enabled"`
			Interval      int   `json:"interval_seconds"`
			Before, After int64
		}{server, *input.Enabled, input.Interval, stored, revision})
		_, err = tx.ExecContext(r.Context(), `INSERT INTO audit_events(actor_uuid,action,details,occurred_at) VALUES(?,'schedule.configure',?,?)`, actor.UUID, string(details), utcTimestamp(time.Now()))
		return err
	})
	if err != nil {
		domainError(w, err)
		return
	}
	respond(w, 200, map[string]any{"actor_uuid": actor.UUID, "server_id": server, "revision": revision})
}
