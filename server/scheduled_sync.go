package main

import (
	"context"
	"database/sql"
	"net/http"
	"sync"
	"time"
)

type syncScheduler struct {
	mu               sync.Mutex
	ctx              context.Context
	cancel           context.CancelFunc
	done             chan struct{}
	healthDone       chan struct{} // closed when the server health monitor stops
	refreshDone      chan struct{}
	started, closing bool
	runner           string
	checkpointErr    error
}
type scheduledSyncTask struct {
	Name           string  `json:"server_name"`
	Provider       string  `json:"provider"`
	Scope          string  `json:"scope"`
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
		defer close(s.healthDone)
		a.runServerHealth(s.ctx)
	}()
	go func() {
		defer close(s.refreshDone)
		for s.ctx.Err() == nil {
			err := a.store.write(s.ctx, func(tx *sql.Tx) error { return prepareServerRefreshJobs(s.ctx, tx) })
			if err == nil {
				break
			}
			if s.ctx.Err() != nil {
				return
			}
			s.mu.Lock()
			s.checkpointErr = err
			s.mu.Unlock()
			timer := time.NewTimer(time.Second)
			select {
			case <-s.ctx.Done():
				timer.Stop()
				return
			case <-timer.C:
			}
		}
		var workers sync.WaitGroup
		for _, scope := range []string{"users", "libraries"} {
			workers.Add(1)
			go func(scope string) {
				defer workers.Done()
				ticker := time.NewTicker(time.Second)
				defer ticker.Stop()
				for s.ctx.Err() == nil {
					if err := a.runOneServerRefreshScope(s.ctx, scope); err != nil && s.ctx.Err() == nil {
						s.mu.Lock()
						s.checkpointErr = err
						s.mu.Unlock()
					}
					select {
					case <-s.ctx.Done():
						return
					case <-ticker.C:
					}
				}
			}(scope)
		}
		workers.Wait()
	}()
	go func() {
		defer close(s.done)
		defer func() { s.cancel(); <-a.providerSockets.done; <-s.healthDone; <-s.refreshDone }()
		if err := a.store.write(s.ctx, func(tx *sql.Tx) error {
			if err := reconcileAutomaticActivity(s.ctx, tx); err != nil {
				return err
			}
			_, err := tx.ExecContext(s.ctx, `UPDATE activity_monitor_schedules SET next_run_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),revision=revision+1 WHERE enabled=1 AND run_state<>'running' AND server_id IN (SELECT id FROM media_servers WHERE service_type IN ('plex','jellyfin','emby'))`)
			return err
		}); err != nil && s.ctx.Err() == nil {
			s.mu.Lock()
			s.checkpointErr = err
			s.mu.Unlock()
		}
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
	rows, err := tx.QueryContext(r.Context(), `SELECT q.server_id,q.revision,s.revision,s.server_nickname,s.service_type,q.scope,q.interval_seconds,q.run_state,q.next_run_at,q.started_at,q.finished_at,q.last_code,q.attempts,coalesce(q.runner_id,''),(s.is_active=1 AND p.enabled=1 AND EXISTS(SELECT 1 FROM user_accounts u WHERE u.kind='owner' AND u.is_active=1 AND (u.access_expires_at IS NULL OR julianday(u.access_expires_at)>julianday('now')))) FROM server_refresh_schedules q JOIN media_servers s ON s.id=q.server_id JOIN provider_settings p ON p.provider_id=s.service_type ORDER BY q.server_id,q.scope LIMIT 2001`)
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
		if err = rows.Scan(&task.Server, &task.Revision, &task.ServerRevision, &task.Name, &task.Provider, &task.Scope, &task.Interval, &task.State, &task.Next, &task.Started, &task.Finished, &task.Code, &task.Attempts, &runner, &eligible); err != nil {
			break
		}
		if task.Scope == "libraries" {
			if _, supported := moduleRules(task.Provider).(libraryReader); !supported {
				continue
			}
		}
		task.Enabled = true
		if task.State == "running" {
			if runner != a.scheduler.runner {
				task.State = "recovering"
			}
		} else if !running {
			task.State = "stopped"
		} else if !eligible || task.Next == nil {
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
	if len(tasks) > 2000 {
		err = ErrConflict
	}
	if err == nil {
		err = tx.Commit()
	}
	if err != nil {
		domainError(w, err)
		return
	}
	respond(w, 200, map[string]any{"actor_uuid": actor.UUID, "runtime_available": running, "checkpoint_error": checkpointError, "configuration_available": false, "generated_at": utcTimestamp(time.Now()), "tasks": tasks})
}
