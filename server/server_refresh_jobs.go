package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"time"
)

type serverRefreshClaim struct {
	Server, Revision, ConfigRevision, SettingsRevision int64
	Scope, Actor, Token                                string
	IncludeEpisodesAndTracks                           bool
}

// prepareServerRefreshJobs schedules startup work without requiring a user
// session. Interrupted jobs wait until their next normal interval.
func prepareServerRefreshJobs(ctx context.Context, tx *sql.Tx) error {
	_, err := tx.ExecContext(ctx, `UPDATE server_refresh_schedules SET run_state='interrupted',last_code='INTERRUPTED',claim_token=NULL,runner_id=NULL,lease_until=NULL,finished_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),next_run_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','+'||interval_seconds||' seconds'),revision=revision+1 WHERE run_state='running'`)
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `UPDATE server_refresh_schedules SET next_run_at=CASE WHEN refresh_on_startup=1 THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') WHEN next_run_at IS NULL OR julianday(next_run_at)<=julianday('now') THEN strftime('%Y-%m-%dT%H:%M:%fZ','now','+'||interval_seconds||' seconds') ELSE next_run_at END,revision=revision+1 WHERE run_state<>'interrupted'`)
	return err
}

func (a *App) claimServerRefreshJob(ctx context.Context) (*serverRefreshClaim, error) {
	return a.claimServerRefreshJobScope(ctx, "")
}

func (a *App) claimServerRefreshJobScope(ctx context.Context, scope string) (*serverRefreshClaim, error) {
	var claim *serverRefreshClaim
	err := a.store.write(ctx, func(tx *sql.Tx) error {
		if _, err := tx.ExecContext(ctx, `UPDATE server_refresh_schedules SET run_state='interrupted',last_code='INTERRUPTED',finished_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),claim_token=NULL,runner_id=NULL,lease_until=NULL,next_run_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','+'||interval_seconds||' seconds'),revision=revision+1 WHERE run_state='running' AND julianday(lease_until)<=julianday('now')`); err != nil {
			return err
		}
		var c serverRefreshClaim
		var interval int
		err := tx.QueryRowContext(ctx, `SELECT q.server_id,q.scope,q.revision,s.config_revision,pref.revision,pref.include_episodes_and_tracks,u.uuid,q.interval_seconds FROM server_refresh_schedules q JOIN media_servers s ON s.id=q.server_id JOIN provider_settings p ON p.provider_id=s.service_type JOIN server_refresh_settings pref ON pref.server_id=s.id JOIN user_accounts u ON u.kind='owner' WHERE (?='' OR q.scope=?) AND q.run_state<>'running' AND q.next_run_at IS NOT NULL AND julianday(q.next_run_at)<=julianday('now') AND s.is_active=1 AND p.enabled=1 AND u.is_active=1 AND (u.access_expires_at IS NULL OR julianday(u.access_expires_at)>julianday('now')) ORDER BY q.next_run_at,q.server_id,q.scope LIMIT 1`, scope, scope).Scan(&c.Server, &c.Scope, &c.Revision, &c.ConfigRevision, &c.SettingsRevision, &c.IncludeEpisodesAndTracks, &c.Actor, &interval)
		if errors.Is(err, sql.ErrNoRows) {
			return nil
		}
		if err != nil {
			return err
		}
		c.Token = newUUID()
		now := time.Now()
		result, err := tx.ExecContext(ctx, `UPDATE server_refresh_schedules SET run_state='running',claim_token=?,runner_id=?,lease_until=?,started_at=?,next_run_at=?,attempts=attempts+1,revision=revision+1 WHERE server_id=? AND scope=? AND revision=?`, c.Token, a.scheduler.runner, utcTimestamp(now.Add(2*time.Hour+time.Minute)), utcTimestamp(now), utcTimestamp(now.Add(time.Duration(interval)*time.Second)), c.Server, c.Scope, c.Revision)
		if err != nil {
			return err
		}
		n, err := result.RowsAffected()
		if err != nil {
			return err
		}
		if n != 1 {
			return ErrConflict
		}
		c.Revision++
		claim = &c
		return nil
	})
	return claim, err
}

func checkServerRefreshClaim(ctx context.Context, tx *sql.Tx, c *serverRefreshClaim) error {
	var valid bool
	err := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM server_refresh_schedules q JOIN media_servers s ON s.id=q.server_id JOIN provider_settings p ON p.provider_id=s.service_type JOIN user_accounts u ON u.uuid=? AND u.kind='owner' WHERE q.server_id=? AND q.scope=? AND q.revision=? AND q.claim_token=? AND q.run_state='running' AND julianday(q.lease_until)>julianday('now') AND s.config_revision=? AND s.is_active=1 AND p.enabled=1 AND u.is_active=1 AND (u.access_expires_at IS NULL OR julianday(u.access_expires_at)>julianday('now')))`, c.Actor, c.Server, c.Scope, c.Revision, c.Token, c.ConfigRevision).Scan(&valid)
	if err != nil {
		return err
	}
	if !valid {
		return ErrConflict
	}
	return nil
}

func (a *App) runOneServerRefresh(parent context.Context) error {
	return a.runOneServerRefreshScope(parent, "")
}

func (a *App) runOneServerRefreshScope(parent context.Context, scope string) error {
	lock := &a.refreshRun
	switch scope {
	case "users":
		lock = &a.refreshUsersRun
	case "libraries":
		lock = &a.refreshLibrariesRun
	}
	if !lock.TryLock() {
		return nil
	}
	defer lock.Unlock()
	ctx, cancel := context.WithTimeout(parent, 2*time.Hour)
	defer cancel()
	claim, err := a.claimServerRefreshJobScope(ctx, scope)
	if err != nil || claim == nil {
		return err
	}
	a.tasksChanged()
	defer a.tasksChanged() // after the finish below has committed
	started := utcTimestamp(time.Now())
	log := &refreshLog{}
	var server ManagedServer
	var runErr error
	select {
	case a.refreshListSlot <- struct{}{}:
		server, runErr = a.loadServer(ctx, claim.Server)
		if runErr == nil {
			var receipt map[string]int
			receipt, runErr = a.syncServerClaimed(ctx, claim.Actor, "", server, claim.Scope == "libraries", claim.Scope == "users", claim)
			if runErr == nil {
				var accounts []refreshLogItem
				if claim.Scope == "users" {
					// The list is extra detail: the counts stand if it can't be read.
					accounts, _ = a.refreshAccountChanges(ctx, claim.Server, started)
				}
				logListRefresh(log, claim.Scope, receipt, accounts)
			}
		}
		<-a.refreshListSlot
	case <-ctx.Done():
		runErr = ctx.Err()
	}
	if runErr == nil && claim.Scope == "libraries" {
		runErr = a.refreshServerCatalogues(ctx, server, claim, log)
	}
	code, state, outcome := "SUCCEEDED", "succeeded", "succeeded"
	if runErr == nil && log.warned {
		code, outcome = "WARNINGS", "warnings"
	}
	if runErr != nil {
		problem, explanation := refreshProblem(runErr)
		a.logger.Warn("Server refresh failed", "server_id", claim.Server, "scope", claim.Scope, "code", problem)
		code, state, outcome = "FAILED", "failed", "failed"
		if errors.Is(runErr, ErrConflict) || errors.Is(runErr, ErrForbidden) || ctx.Err() != nil {
			code, state, outcome = "CANCELLED", "cancelled", "cancelled"
		}
		if log.failed {
			explanation = ""
		}
		log.add(refreshLogError, "The refresh stopped", explanation)
	}
	cleanup, stop := context.WithTimeout(context.Background(), 5*time.Second)
	defer stop()
	return a.store.write(cleanup, func(tx *sql.Tx) error {
		if checkServerRefreshClaim(cleanup, tx, claim) != nil {
			code, state, outcome = "CANCELLED", "cancelled", "cancelled"
		}
		result, err := tx.ExecContext(cleanup, `UPDATE server_refresh_schedules SET run_state=?,last_code=?,finished_at=?,claim_token=NULL,runner_id=NULL,lease_until=NULL,revision=revision+1 WHERE server_id=? AND scope=? AND claim_token=? AND run_state='running'`, state, code, utcTimestamp(time.Now()), claim.Server, claim.Scope, claim.Token)
		if err != nil {
			return err
		}
		n, err := result.RowsAffected()
		if err != nil || n == 0 {
			return err
		}
		if err := saveRefreshRun(cleanup, tx, claim, started, utcTimestamp(time.Now()), outcome, log); err != nil {
			return err
		}
		details, _ := json.Marshal(map[string]any{"server_id": claim.Server, "scope": claim.Scope, "code": code})
		_, err = tx.ExecContext(cleanup, `INSERT INTO audit_events(actor_uuid,action,details,occurred_at) VALUES(?,'server.refresh.finish',?,?)`, claim.Actor, string(details), utcTimestamp(time.Now()))
		return err
	})
}
