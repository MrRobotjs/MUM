package main

import (
	"context"
	"crypto/sha256"
	"fmt"
	"strconv"
	"time"
)

type activityRealtimeCursor struct {
	signal     [32]byte
	generation uint64
	seen       bool
}

// Hash only authorized committed source fences/status transitions, not media
// records or ticking age values. Snapshot writers already advance these fences.
func (s *Store) activitySignal(ctx context.Context, actor, access string, all bool) ([32]byte, error) {
	var empty [32]byte
	tx, err := s.beginActivityView(ctx, actor, access, all)
	if err != nil {
		return empty, err
	}
	defer tx.Rollback()
	statuses, fences, err := readActivityStatuses(ctx, tx, actor, activityReadQuery{All: all}, time.Now().UTC())
	if err != nil {
		return empty, err
	}
	hash := sha256.New()
	for _, status := range statuses {
		id, err := strconv.ParseInt(status.Server, 10, 64)
		if err != nil {
			return empty, err
		}
		fence := fences[id]
		if !all {
			fmt.Fprintf(hash, "eligible:%d\n", fence.Eligible)
		}
		observed := ""
		if status.Observed != nil {
			observed = *status.Observed
		}
		fmt.Fprintf(hash, "%s:%d:%d:%d:%t:%s:%s:%s:%s\n", status.Server, fence.Revision, fence.Mapping, fence.ServerRevision, fence.Active, status.Freshness, status.Pending, status.LastResult, observed)
	}
	if err = tx.Commit(); err != nil {
		return empty, err
	}
	var result [32]byte
	copy(result[:], hash.Sum(nil))
	return result, nil
}

func (h *realtimeHub) activityUpdate(ctx context.Context, c *liveClient, all bool, last *activityRealtimeCursor) bool {
	scope := "own"
	if all {
		scope = "all"
	}
	channel := "activity." + c.owner + "." + scope
	c.mu.RLock()
	subscribed, generation := c.channels[channel], c.activityGeneration
	c.mu.RUnlock()
	if !subscribed {
		last.seen = false
		return true
	}
	signal, err := h.store.activitySignal(ctx, c.owner, c.accessToken(), all)
	if err != nil {
		return false
	}
	if last.seen && last.signal == signal && last.generation == generation {
		return true
	}
	*last = activityRealtimeCursor{signal: signal, generation: generation, seen: true}
	return h.deliver(c, map[string]any{"type": "event", "event": map[string]any{"channel": channel, "type": "ActivityInvalidated", "payload": map[string]string{"actor_uuid": c.owner, "scope": scope}, "timestamp": utcTimestamp(time.Now())}})
}
