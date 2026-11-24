package main

import (
	"context"
	"crypto/sha256"
	"fmt"
	"time"
)

// historySignal reads committed revision fences only after authorizing the
// same scope used by the history API. No history details leave this process.
func (s *Store) historySignal(ctx context.Context, actor, access string, all bool) ([32]byte, error) {
	var empty [32]byte
	tx, err := s.beginActivityView(ctx, actor, access, all)
	if err != nil {
		return empty, err
	}
	defer tx.Rollback()
	hash := sha256.New()
	if all {
		var revision int64
		if err = tx.QueryRowContext(ctx, `SELECT revision FROM history_realtime_global WHERE singleton=1`).Scan(&revision); err != nil {
			return empty, err
		}
		fmt.Fprintf(hash, "all:%d", revision)
	} else {
		rows, e := tx.QueryContext(ctx, `SELECT a.uuid,coalesce(r.revision,0),coalesce(i.revision,0)
   FROM service_links l JOIN service_accounts a ON a.uuid=l.service_uuid
   LEFT JOIN history_realtime_service r ON r.service_uuid=a.uuid AND r.owner_uuid=l.user_uuid
   LEFT JOIN history_realtime_import i ON i.server_id=a.server_id AND i.account_id=a.external_user_id
   WHERE l.user_uuid=? AND l.link_kind='owner' ORDER BY a.uuid`, actor)
		if e != nil {
			return empty, e
		}
		for rows.Next() {
			var id string
			var recorded, imported int64
			if e = rows.Scan(&id, &recorded, &imported); e != nil {
				rows.Close()
				return empty, e
			}
			fmt.Fprintf(hash, "%s:%d:%d\n", id, recorded, imported)
		}
		e = rows.Err()
		rows.Close()
		if e != nil {
			return empty, e
		}
	}
	if err = tx.Commit(); err != nil {
		return empty, err
	}
	var out [32]byte
	copy(out[:], hash.Sum(nil))
	return out, nil
}

func (h *realtimeHub) historyUpdate(ctx context.Context, c *liveClient, all bool, last *activityRealtimeCursor) bool {
	scope := "own"
	if all {
		scope = "all"
	}
	channel := "history." + c.owner + "." + scope
	c.mu.RLock()
	subscribed, generation := c.channels[channel], c.historyGeneration
	c.mu.RUnlock()
	if !subscribed {
		last.seen = false
		return true
	}
	signal, err := h.store.historySignal(ctx, c.owner, c.accessToken(), all)
	if err != nil {
		return false
	}
	if last.seen && last.signal == signal && last.generation == generation {
		return true
	}
	*last = activityRealtimeCursor{signal: signal, generation: generation, seen: true}
	return h.deliver(c, map[string]any{"type": "event", "event": map[string]any{"channel": channel, "type": "HistoryInvalidated", "payload": map[string]string{"actor_uuid": c.owner, "scope": scope}, "timestamp": utcTimestamp(time.Now())}})
}
