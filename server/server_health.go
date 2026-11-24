package main

import (
	"context"
	"database/sql"
	"errors"
	"sync"
	"time"
)

// Server health in the background: the dashboard's
// Server Health card stays current without pressing Refresh. MUM checks each
// active server about once a minute, with the same test as the Refresh
// button, a few servers at a time and never holding the database writer
// during a request. A successful activity read of Plex, Jellyfin or Emby also
// proves the server is reachable, so a server read for activity is not
// checked again. Status changes are announced to administrators on the
// realtime channel; the dashboard then reads the stored status again.

const serverHealthChannel = "system.server_health"

var (
	// serverHealthInterval is how old a server's last check may get.
	serverHealthInterval = 60 * time.Second
	// serverHealthTick is how often the monitor looks for servers due a check.
	serverHealthTick = 15 * time.Second
)

const (
	serverHealthParallel = 4
	serverHealthTimeout  = 15 * time.Second
)

// runServerHealth checks servers until ctx ends, then waits for any check in
// progress before returning.
func (a *App) runServerHealth(ctx context.Context) {
	timer := time.NewTimer(5 * time.Second)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
		}
		if _, err := a.sweepServerHealth(ctx); err != nil && ctx.Err() == nil {
			a.logger.Warn("Server health check failed", "code", consoleErrorCode(err))
		}
		timer.Reset(serverHealthTick)
	}
}

// sweepServerHealth checks every active server whose last check is older than
// the interval and says how many it recorded.
func (a *App) sweepServerHealth(ctx context.Context) (int, error) {
	cutoff := utcTimestamp(time.Now().Add(-serverHealthInterval + 5*time.Second))
	rows, err := a.store.reader.QueryContext(ctx, `SELECT s.id FROM media_servers s JOIN provider_settings p ON p.provider_id=s.service_type
	 WHERE s.is_active=1 AND p.enabled=1 AND (s.last_status_check IS NULL OR s.last_status_check<?) ORDER BY s.id LIMIT 1000`, cutoff)
	if err != nil {
		return 0, err
	}
	var due []int64
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return 0, err
		}
		due = append(due, id)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return 0, err
	}
	var mu sync.Mutex
	recorded, changed := 0, false
	var firstErr error
	slots := make(chan struct{}, serverHealthParallel)
	var wg sync.WaitGroup
	for _, id := range due {
		if ctx.Err() != nil {
			break
		}
		slots <- struct{}{}
		wg.Add(1)
		go func(id int64) {
			defer func() { <-slots; wg.Done() }()
			written, statusChanged, err := a.checkServerHealth(ctx, id)
			mu.Lock()
			defer mu.Unlock()
			if written {
				recorded++
			}
			changed = changed || statusChanged
			if err != nil && firstErr == nil {
				firstErr = err
			}
		}(id)
	}
	wg.Wait()
	if recorded > 0 {
		a.announceServerHealth(changed)
	}
	return recorded, firstErr
}

// checkServerHealth tests one server and records the outcome, unless the
// server was changed or turned off meanwhile.
func (a *App) checkServerHealth(ctx context.Context, id int64) (written, changed bool, err error) {
	s, err := a.loadServer(ctx, id)
	if errors.Is(err, ErrNotFound) {
		return false, false, nil
	}
	if err != nil || !s.EffectiveActive {
		return false, false, err
	}
	connection, err := newServerConnection(ProviderConfig{s.Type, s.URL, s.apiKey}, a.ProviderHTTP)
	if err != nil {
		return false, false, nil
	}
	probe, cancel := context.WithTimeout(ctx, serverHealthTimeout)
	var info ProviderInfo
	var probeErr error
	if checker, ok := connection.module().(healthChecker); ok {
		info, probeErr = checker.Health(probe)
	} else {
		info, probeErr = connection.Test(probe)
	}
	cancel()
	if ctx.Err() != nil {
		return false, false, nil // shutting down: no verdict
	}
	online := probeErr == nil
	err = a.store.write(ctx, func(tx *sql.Tx) error {
		var previous sql.NullBool
		if err := tx.QueryRowContext(ctx, "SELECT last_status FROM media_servers WHERE id=? AND revision=? AND is_active=1", s.ID, s.Revision).Scan(&previous); errors.Is(err, sql.ErrNoRows) {
			return nil
		} else if err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `UPDATE media_servers SET server_name=CASE WHEN ? THEN ? ELSE server_name END,last_version=CASE WHEN ? THEN ? ELSE last_version END,last_status=?,last_status_check=? WHERE id=? AND revision=?`,
			online, info.Name, online, info.Version, online, utcTimestamp(time.Now()), s.ID, s.Revision); err != nil {
			return err
		}
		written = true
		changed = !previous.Valid || previous.Bool != online
		return nil
	})
	return written, changed, err
}

// markServerReachable records a successful activity read as a passed health
// check; it says whether the server was not already online. Reads can come
// every few seconds, so an online server's check time is only saved again
// once it is 30 seconds old.
func (a *App) markServerReachable(ctx context.Context, id int64) (bool, error) {
	changed := false
	now := time.Now()
	err := a.store.write(ctx, func(tx *sql.Tx) error {
		var previous sql.NullBool
		var checked sql.NullString
		if err := tx.QueryRowContext(ctx, "SELECT last_status,last_status_check FROM media_servers WHERE id=? AND is_active=1", id).Scan(&previous, &checked); errors.Is(err, sql.ErrNoRows) {
			return nil
		} else if err != nil {
			return err
		}
		if previous.Valid && previous.Bool && checked.Valid && checked.String >= utcTimestamp(now.Add(-30*time.Second)) {
			return nil
		}
		if _, err := tx.ExecContext(ctx, "UPDATE media_servers SET last_status=1,last_status_check=? WHERE id=? AND is_active=1", utcTimestamp(now), id); err != nil {
			return err
		}
		changed = !previous.Valid || !previous.Bool
		return nil
	})
	if err == nil && changed {
		a.announceServerHealth(true)
	}
	return changed, err
}

// announceServerHealth tells administrators' dashboards to read the stored
// status again. The event carries no server details: each dashboard reads
// them with its own authority.
func (a *App) announceServerHealth(changed bool) {
	if a.hub != nil {
		a.hub.publish(serverHealthChannel, "ServerHealth", map[string]any{"changed": changed})
	}
}
