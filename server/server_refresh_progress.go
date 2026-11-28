package main

import (
	"strconv"
	"sync"
	"time"
)

// refreshProgress is how far a running scheduled refresh has got. It lives in
// memory only: it is cleared when the refresh finishes and is never saved.
type refreshProgress struct {
	// Library is the library being refreshed; empty while the server's own
	// users or libraries list is read.
	Library string `json:"library"`
	// Phase is "list" (reading the server's list), "items" (reading a
	// library's items), "episodes" or "tracks" (reading each show or album).
	Phase string `json:"phase"`
	// Done and Total count items, or shows/albums in the episodes and tracks
	// phases. Total is 0 when the server does not say.
	Done  int `json:"done"`
	Total int `json:"total"`
	// Current is the show or album whose episodes or tracks are being read.
	Current string `json:"current"`
}

// refreshProgressMinGap limits progress events to about one a second per
// refresh; a new library or phase is sent straight away.
const refreshProgressMinGap = time.Second

type refreshProgressBoard struct {
	mu    sync.Mutex
	runs  map[string]refreshProgress
	sent  map[string]time.Time
	phase map[string]string
}

func refreshProgressKey(server int64, scope string) string {
	return strconv.FormatInt(server, 10) + ":" + scope
}

// setRefreshProgress records progress and tells administrators' pages,
// outside any database transaction.
func (a *App) setRefreshProgress(claim *serverRefreshClaim, p refreshProgress) {
	if claim == nil {
		return
	}
	key := refreshProgressKey(claim.Server, claim.Scope)
	b := &a.refreshProgress
	b.mu.Lock()
	if b.runs == nil {
		b.runs, b.sent, b.phase = map[string]refreshProgress{}, map[string]time.Time{}, map[string]string{}
	}
	b.runs[key] = p
	stage := p.Library + "\x00" + p.Phase
	now := time.Now()
	send := b.phase[key] != stage || now.Sub(b.sent[key]) >= refreshProgressMinGap
	if send {
		b.sent[key], b.phase[key] = now, stage
	}
	b.mu.Unlock()
	if send && a.hub != nil {
		a.hub.publish(scheduledTasksChannel, "ScheduledTaskProgress", map[string]any{"server_id": claim.Server, "scope": claim.Scope, "progress": p})
	}
}

func (a *App) clearRefreshProgress(claim *serverRefreshClaim) {
	key := refreshProgressKey(claim.Server, claim.Scope)
	b := &a.refreshProgress
	b.mu.Lock()
	delete(b.runs, key)
	delete(b.sent, key)
	delete(b.phase, key)
	b.mu.Unlock()
}

// currentRefreshProgress is the progress of a running refresh, or nil.
func (a *App) currentRefreshProgress(server int64, scope string) *refreshProgress {
	b := &a.refreshProgress
	b.mu.Lock()
	defer b.mu.Unlock()
	if p, ok := b.runs[refreshProgressKey(server, scope)]; ok {
		return &p
	}
	return nil
}
