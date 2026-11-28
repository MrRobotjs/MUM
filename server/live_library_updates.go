package main

import (
	"context"
	"database/sql"
	"errors"
	"sync"
	"time"

	"app/server/providers/provider"
)

// A server's live connection can announce library items as they are added,
// changed or removed. MUM collects the announcements per server and, once the
// server has been quiet for a moment (a library scan sends many), reads the
// changed libraries again, and in them only the changed shows' episodes or
// albums' tracks. The run is an ordinary claim on the server's libraries
// refresh, so it never overlaps a scheduled one, and it leaves the schedule's
// next run where it was. Announcements are kept in memory only: after a
// restart the startup refresh covers anything missed.
const (
	liveLibraryQuiet = 10 * time.Second
	// liveLibraryMaxWait bounds the wait while announcements keep coming.
	liveLibraryMaxWait = 2 * time.Minute
	// liveLibraryMaxItems: beyond this many, every show in the changed
	// libraries is read again instead of a list of them.
	liveLibraryMaxItems = 500
	// liveLibraryGiveUp drops announcements that could not be acted on (the
	// server kept being busy or unavailable); the next scheduled refresh reads
	// everything anyway.
	liveLibraryGiveUp = 30 * time.Minute
)

type pendingLibraryChanges struct {
	changes     []provider.LibraryChange
	overflow    map[string]bool // libraries with too many changes to list
	first, last time.Time
}

type liveLibraryBoard struct {
	mu      sync.Mutex
	servers map[int64]*pendingLibraryChanges
}

// noteLibraryChanges records announced changes for a server.
func (a *App) noteLibraryChanges(server int64, changes []provider.LibraryChange) {
	if len(changes) == 0 {
		return
	}
	b := &a.liveLibraries
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.servers == nil {
		b.servers = map[int64]*pendingLibraryChanges{}
	}
	p := b.servers[server]
	now := time.Now()
	if p == nil {
		p = &pendingLibraryChanges{overflow: map[string]bool{}, first: now}
		b.servers[server] = p
	}
	p.last = now
	for _, c := range changes {
		if p.overflow[c.Library] {
			continue
		}
		if len(p.changes) >= liveLibraryMaxItems {
			p.overflow[c.Library] = true
			continue
		}
		p.changes = append(p.changes, c)
	}
}

// takeDueLibraryChanges removes and returns one server's changes once it has
// been quiet long enough, or waited long enough.
func (a *App) takeDueLibraryChanges(now time.Time) (int64, *pendingLibraryChanges) {
	b := &a.liveLibraries
	b.mu.Lock()
	defer b.mu.Unlock()
	for server, p := range b.servers {
		if now.Sub(p.last) >= liveLibraryQuiet || now.Sub(p.first) >= liveLibraryMaxWait {
			delete(b.servers, server)
			return server, p
		}
	}
	return 0, nil
}

// putBackLibraryChanges returns changes that could not run yet, merged with
// any that arrived meanwhile, to be tried again after a quiet period.
func (a *App) putBackLibraryChanges(server int64, p *pendingLibraryChanges) {
	if time.Since(p.first) >= liveLibraryGiveUp {
		a.logger.Info("Announced library changes dropped; the next scheduled refresh reads them", "server_id", server)
		return
	}
	b := &a.liveLibraries
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.servers == nil {
		b.servers = map[int64]*pendingLibraryChanges{}
	}
	if newer := b.servers[server]; newer != nil {
		p.changes = append(p.changes, newer.changes...)
		for library := range newer.overflow {
			p.overflow[library] = true
		}
	}
	if len(p.changes) > liveLibraryMaxItems {
		for _, c := range p.changes[liveLibraryMaxItems:] {
			p.overflow[c.Library] = true
		}
		p.changes = p.changes[:liveLibraryMaxItems]
	}
	p.last = time.Now()
	b.servers[server] = p
}

// runDueLiveLibraryUpdate runs one server's announced changes when they are
// due. It runs on the libraries refresh worker, between scheduled refreshes.
func (a *App) runDueLiveLibraryUpdate(parent context.Context) error {
	server, pending := a.takeDueLibraryChanges(time.Now())
	if pending == nil {
		return nil
	}
	if !a.refreshLibrariesRun.TryLock() {
		a.putBackLibraryChanges(server, pending)
		return nil
	}
	defer a.refreshLibrariesRun.Unlock()
	ctx, cancel := context.WithTimeout(parent, 2*time.Hour)
	defer cancel()
	live, err := a.resolveLibraryChanges(ctx, server, pending)
	if err != nil {
		if ctx.Err() == nil {
			a.putBackLibraryChanges(server, pending)
		}
		return nil
	}
	claim, busy, err := a.claimLiveLibraryRefresh(ctx, server)
	if err != nil || claim == nil {
		if busy {
			a.putBackLibraryChanges(server, pending)
		}
		return err
	}
	claim.Live = live
	return a.runClaimedServerRefresh(ctx, claim)
}

// resolveLibraryChanges turns announcements into the libraries to read and,
// in each, the shows or albums whose episodes or tracks to read (nil = all).
// Provider reads happen here, before the claim and outside any transaction.
func (a *App) resolveLibraryChanges(ctx context.Context, serverID int64, p *pendingLibraryChanges) (map[string]map[string]bool, error) {
	server, err := a.loadServer(ctx, serverID)
	if err != nil {
		return nil, err
	}
	connection, err := newServerConnection(ProviderConfig{server.Type, server.URL, server.apiKey}, a.ProviderHTTP)
	if err != nil {
		return nil, err
	}
	parents, _ := connection.module().(catalogueParentReader)
	live := map[string]map[string]bool{}
	for library := range p.overflow {
		live[library] = nil
	}
	for _, c := range p.changes {
		if p.overflow[c.Library] {
			continue
		}
		if _, seen := live[c.Library]; !seen {
			live[c.Library] = map[string]bool{}
		}
		set := live[c.Library]
		if set == nil {
			continue
		}
		switch c.Kind {
		case "show", "album":
			set[c.Item] = true
		case "season", "episode", "track":
			parent, err := a.knownCatalogueParent(ctx, serverID, c.Item)
			if err == nil && parent == "" && !c.Removed && parents != nil {
				parent, err = parents.CatalogueParent(ctx, c.Item)
			}
			if err != nil || parent == "" {
				if ctx.Err() != nil {
					return nil, ctx.Err()
				}
				// The show can't be told: read every show in this library.
				live[c.Library] = nil
				continue
			}
			set[parent] = true
		}
	}
	return live, nil
}

// knownCatalogueParent returns the show or album MUM has stored for an
// episode, season or track, or "" when it has none.
func (a *App) knownCatalogueParent(ctx context.Context, server int64, item string) (string, error) {
	var parent sql.NullString
	err := a.store.reader.QueryRowContext(ctx, `SELECT parent_id FROM media_items WHERE server_id=? AND external_id=? AND parent_id IS NOT NULL LIMIT 1`, server, item).Scan(&parent)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	return parent.String, err
}

// claimLiveLibraryRefresh claims a server's libraries refresh now, leaving its
// next scheduled run unchanged. busy reports that a refresh is running.
func (a *App) claimLiveLibraryRefresh(ctx context.Context, server int64) (claim *serverRefreshClaim, busy bool, err error) {
	err = a.store.write(ctx, func(tx *sql.Tx) error {
		var c serverRefreshClaim
		var state string
		err := tx.QueryRowContext(ctx, `SELECT q.server_id,q.scope,q.revision,s.config_revision,pref.revision,pref.include_episodes_and_tracks,u.uuid,q.run_state FROM server_refresh_schedules q JOIN media_servers s ON s.id=q.server_id JOIN provider_settings p ON p.provider_id=s.service_type JOIN server_refresh_settings pref ON pref.server_id=s.id JOIN user_accounts u ON u.kind='owner' WHERE q.server_id=? AND q.scope='libraries' AND s.is_active=1 AND p.enabled=1 AND u.is_active=1 AND (u.access_expires_at IS NULL OR julianday(u.access_expires_at)>julianday('now'))`, server).Scan(&c.Server, &c.Scope, &c.Revision, &c.ConfigRevision, &c.SettingsRevision, &c.IncludeEpisodesAndTracks, &c.Actor, &state)
		if errors.Is(err, sql.ErrNoRows) {
			return nil
		}
		if err != nil {
			return err
		}
		if state == "running" {
			busy = true
			return nil
		}
		c.Token = newUUID()
		now := time.Now()
		result, err := tx.ExecContext(ctx, `UPDATE server_refresh_schedules SET run_state='running',claim_token=?,runner_id=?,lease_until=?,started_at=?,attempts=attempts+1,revision=revision+1 WHERE server_id=? AND scope='libraries' AND revision=? AND run_state<>'running'`, c.Token, a.scheduler.runner, utcTimestamp(now.Add(2*time.Hour+time.Minute)), utcTimestamp(now), c.Server, c.Revision)
		if err != nil {
			return err
		}
		if n, err := result.RowsAffected(); err != nil || n != 1 {
			if err == nil {
				err = ErrConflict
			}
			return err
		}
		c.Revision++
		claim = &c
		return nil
	})
	return claim, busy, err
}
