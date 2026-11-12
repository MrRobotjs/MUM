package main

import (
	"context"
	"time"
)

type notificationSignal struct{ broadcast, private, inbox int64 }

func (s *Store) notificationSignal(ctx context.Context, actor string) (notificationSignal, error) {
	var signal notificationSignal
	err := s.reader.QueryRowContext(ctx, `SELECT
 coalesce((SELECT revision FROM admin_notification_signals WHERE scope='administrators'),0),
 coalesce((SELECT revision FROM admin_notification_signals WHERE scope=?),0),
 coalesce((SELECT revision FROM admin_notification_inboxes WHERE user_uuid=?),1)`, actor, actor).Scan(&signal.broadcast, &signal.private, &signal.inbox)
	return signal, err
}

// Only committed counters are observed through the query-only pool. Socket I/O
// never runs inside a writer transaction. A subscription always gets a fresh hint.
func (h *realtimeHub) notificationUpdate(ctx context.Context, c *liveClient, last *notificationSignal, generation *uint64) bool {
	channel := "notifications." + c.owner
	c.mu.RLock()
	subscribed, epoch := c.channels[channel], c.notificationGeneration
	c.mu.RUnlock()
	if !subscribed {
		return true
	}
	p, err := h.store.Authenticate(ctx, c.accessToken())
	if err != nil {
		return false
	}
	if !h.canSubscribe(ctx, p, channel) {
		return false
	}
	signal, err := h.store.notificationSignal(ctx, c.owner)
	if err != nil {
		return false
	} // Close/reconnect rather than silently lose invalidations.
	if signal == *last && epoch == *generation {
		return true
	}
	*last, *generation = signal, epoch
	return h.deliver(c, map[string]any{"type": "event", "event": map[string]any{
		"channel": channel, "type": "NotificationInvalidated", "payload": map[string]string{"actor_uuid": c.owner}, "timestamp": utcTimestamp(time.Now()),
	}})
}
