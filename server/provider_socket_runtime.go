package main

import (
	"context"
	"database/sql"
	"time"
)

func (a *App) providerSocketTargets(ctx context.Context) ([]providerSocketTarget, error) {
	rows, err := a.store.reader.QueryContext(ctx, `SELECT q.server_id,q.socket_revision,s.config_revision,q.authorized_by FROM activity_monitor_schedules q JOIN media_servers s ON s.id=q.server_id JOIN provider_settings p ON p.provider_id=s.service_type JOIN user_accounts u ON u.uuid=q.authorized_by WHERE q.enabled=1 AND q.socket_enabled=1 AND s.config_revision=q.configured_server_revision AND s.is_active=1 AND p.enabled=1 AND s.service_type IN ('jellyfin','emby','plex') AND u.kind='owner' AND u.is_active=1 AND (u.access_expires_at IS NULL OR julianday(u.access_expires_at)>julianday('now')) ORDER BY q.server_id LIMIT 16`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []providerSocketTarget{}
	for rows.Next() {
		var target providerSocketTarget
		if err = rows.Scan(&target.Server, &target.Revision, &target.SourceRevision, &target.Actor); err != nil {
			return nil, err
		}
		result = append(result, target)
	}
	return result, rows.Err()
}
func (a *App) nudgeProviderSocket(ctx context.Context, w *providerSocketWorker) error {
	if time.Since(w.lastNudge) < 5*time.Second || !w.dirty.Swap(false) {
		return nil
	}
	changed := false
	err := a.store.write(ctx, func(tx *sql.Tx) error {
		r, err := tx.ExecContext(ctx, `UPDATE activity_monitor_schedules SET socket_pending=1,next_run_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),revision=revision+1 WHERE server_id=? AND socket_revision=? AND enabled=1 AND socket_enabled=1 AND authorized_by=? AND run_state<>'running' AND configured_server_revision=? AND EXISTS(SELECT 1 FROM media_servers s JOIN provider_settings p ON p.provider_id=s.service_type JOIN user_accounts u ON u.uuid=? WHERE s.id=activity_monitor_schedules.server_id AND s.config_revision=? AND s.is_active=1 AND p.enabled=1 AND u.kind='owner' AND u.is_active=1 AND (u.access_expires_at IS NULL OR julianday(u.access_expires_at)>julianday('now')))`, w.target.Server, w.target.Revision, w.target.Actor, w.target.SourceRevision, w.target.Actor, w.target.SourceRevision)
		if err != nil {
			return err
		}
		n, err := r.RowsAffected()
		changed = n == 1
		return err
	})
	if err != nil || !changed {
		w.dirty.Store(true)
	} else {
		w.lastNudge = time.Now()
	}
	return err
}
func (a *App) superviseProviderSockets(ctx context.Context) {
	r := a.providerSockets
	defer close(r.done)
	defer func() {
		r.mu.Lock()
		workers := r.workers
		r.workers = map[int64]*providerSocketWorker{}
		r.mu.Unlock()
		for _, w := range workers {
			w.cancel()
		}
		for _, w := range workers {
			<-w.done
		}
	}()
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for ctx.Err() == nil {
		targets, err := a.providerSocketTargets(ctx)
		desired := map[int64]providerSocketTarget{}
		if err == nil {
			for _, t := range targets {
				desired[t.Server] = t
			}
		}
		r.mu.Lock()
		existing := make(map[int64]*providerSocketWorker, len(r.workers))
		for id, w := range r.workers {
			existing[id] = w
		}
		if err != nil {
			r.code = "STATE_UNAVAILABLE"
		} else {
			r.code = ""
		}
		r.mu.Unlock()
		for id, w := range existing {
			if target, ok := desired[id]; !ok || target != w.target {
				w.cancel()
				<-w.done
				r.mu.Lock()
				delete(r.workers, id)
				r.mu.Unlock()
				delete(existing, id)
			}
		}
		for _, target := range targets {
			if ctx.Err() != nil {
				break
			}
			w := existing[target.Server]
			if w == nil {
				server, loadErr := a.loadServer(ctx, target.Server)
				if loadErr != nil || server.ConfigRevision != target.SourceRevision || !server.EffectiveActive {
					continue
				}
				workerCtx, cancel := context.WithCancel(ctx)
				w = &providerSocketWorker{target: target, cancel: cancel, done: make(chan struct{}), state: "connecting"}
				r.mu.Lock()
				r.workers[target.Server] = w
				r.mu.Unlock()
				go a.runProviderSocket(workerCtx, w, server)
			}
			if err := a.nudgeProviderSocket(ctx, w); err != nil {
				w.status("failed", "CHECKPOINT_FAILED")
			}
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}
func (a *App) providerSocketStatus(id int64, enabled, eligible, running bool) (string, string) {
	if !enabled {
		return "disabled", ""
	}
	if !running {
		return "stopped", ""
	}
	if !eligible {
		return "paused", ""
	}
	r := a.providerSockets
	r.mu.Lock()
	w, code := r.workers[id], r.code
	r.mu.Unlock()
	if code != "" {
		return "failed", code
	}
	if w == nil {
		return "waiting", ""
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.state, w.code
}
