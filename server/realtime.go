package main

import (
	"context"
	"database/sql"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
)

type socketCommand struct {
	Type        string   `json:"type"`
	AccessToken string   `json:"access_token,omitempty"`
	Channels    []string `json:"channels,omitempty"`
}
type liveClient struct {
	owner                  string
	conn                   *websocket.Conn
	send                   chan any
	mu                     sync.RWMutex
	token                  string
	channels               map[string]bool
	notificationGeneration uint64
	activityGeneration     uint64
}
type realtimeHub struct {
	store   *Store
	ctx     context.Context
	cancel  context.CancelFunc
	mu      sync.Mutex
	clients map[*liveClient]bool
	closed  bool
	wg      sync.WaitGroup
}

func newRealtimeHub(s *Store) *realtimeHub {
	ctx, cancel := context.WithCancel(context.Background())
	return &realtimeHub{store: s, ctx: ctx, cancel: cancel, clients: make(map[*liveClient]bool)}
}
func (h *realtimeHub) close() {
	h.mu.Lock()
	h.closed = true
	h.cancel()
	for c := range h.clients {
		_ = c.conn.CloseNow()
	}
	h.mu.Unlock()
	h.wg.Wait()
}
func (c *liveClient) accessToken() string { c.mu.RLock(); defer c.mu.RUnlock(); return c.token }

func (h *realtimeHub) serve(w http.ResponseWriter, r *http.Request) {
	conn, err := websocket.Accept(w, r, nil)
	if err != nil {
		return
	}
	defer conn.CloseNow()
	conn.SetReadLimit(64 << 10)
	ctx, cancel := context.WithCancel(h.ctx)
	defer cancel()
	authCtx, authCancel := context.WithTimeout(ctx, 10*time.Second)
	var auth socketCommand
	err = wsjson.Read(authCtx, conn, &auth)
	authCancel()
	if err != nil || auth.Type != "authenticate" {
		_ = conn.Close(websocket.StatusPolicyViolation, "Authentication required")
		return
	}
	principal, err := h.store.Authenticate(ctx, auth.AccessToken)
	if err != nil {
		_ = conn.Close(websocket.StatusPolicyViolation, "Invalid session")
		return
	}
	c := &liveClient{owner: principal.UUID, conn: conn, send: make(chan any, 64), token: auth.AccessToken, channels: make(map[string]bool)}
	h.mu.Lock()
	if h.closed {
		h.mu.Unlock()
		return
	}
	h.clients[c] = true
	h.wg.Add(1)
	h.mu.Unlock()
	defer func() { h.mu.Lock(); delete(h.clients, c); h.mu.Unlock(); h.wg.Done() }()
	writerDone := make(chan struct{})
	go func() {
		defer close(writerDone)
		defer cancel()
		ticker := time.NewTicker(15 * time.Second)
		defer ticker.Stop()
		notifications := time.NewTicker(500 * time.Millisecond)
		defer notifications.Stop()
		var signal notificationSignal
		var generation uint64
		var ownActivity, allActivity activityRealtimeCursor
		for {
			select {
			case <-ctx.Done():
				return
			case <-notifications.C:
				if !h.notificationUpdate(ctx, c, &signal, &generation) {
					return
				}
				if !h.activityUpdate(ctx, c, false, &ownActivity) || !h.activityUpdate(ctx, c, true, &allActivity) {
					return
				}
			case message := <-c.send:
				p, err := h.store.Authenticate(ctx, c.accessToken())
				if err != nil {
					return
				}
				if envelope, ok := message.(map[string]any); ok && envelope["type"] == "event" {
					event, _ := envelope["event"].(map[string]any)
					channel, _ := event["channel"].(string)
					if strings.HasPrefix(channel, "notifications.") || strings.HasPrefix(channel, "activity.") {
						c.mu.RLock()
						subscribed := c.channels[channel]
						c.mu.RUnlock()
						if !subscribed {
							continue
						}
					}
					if !h.canSubscribe(ctx, p, channel) {
						continue
					}
					if event["type"] == "SessionUpdate" && !p.Admin {
						payload, _ := event["payload"].(map[string]any)
						event["payload"] = filterSessions(payload, p.UUID)
					}
				}
				writeCtx, writeCancel := context.WithTimeout(ctx, 5*time.Second)
				err = wsjson.Write(writeCtx, conn, message)
				writeCancel()
				if err != nil {
					return
				}
			case <-ticker.C:
				if _, err := h.store.Authenticate(ctx, c.accessToken()); err != nil {
					return
				}
				pingCtx, pingCancel := context.WithTimeout(ctx, 5*time.Second)
				err := conn.Ping(pingCtx)
				pingCancel()
				if err != nil {
					return
				}
			}
		}
	}()
	defer func() { cancel(); _ = conn.CloseNow(); <-writerDone }()
	c.send <- map[string]string{"type": "authenticated"}
	for {
		var command socketCommand
		if err := wsjson.Read(ctx, conn, &command); err != nil {
			return
		}
		p, err := h.store.Authenticate(ctx, c.accessToken())
		if err != nil {
			return
		}
		switch command.Type {
		case "authenticate":
			updated, err := h.store.Authenticate(ctx, command.AccessToken)
			if err != nil || updated.UUID != p.UUID {
				return
			}
			c.mu.Lock()
			c.token = command.AccessToken
			c.channels = make(map[string]bool)
			c.notificationGeneration++
			c.activityGeneration++
			c.mu.Unlock()
			if !h.deliver(c, map[string]string{"type": "authenticated"}) {
				return
			}
		case "subscribe", "unsubscribe":
			if len(command.Channels) > 64 {
				return
			}
			granted := []string{}
			rejected := []string{}
			for _, channel := range command.Channels {
				if command.Type == "unsubscribe" {
					c.mu.Lock()
					delete(c.channels, channel)
					if strings.HasPrefix(channel, "activity."+c.owner+".") {
						c.activityGeneration++
					}
					if channel == "notifications."+c.owner {
						c.notificationGeneration++
					}
					c.mu.Unlock()
					continue
				}
				if !h.canSubscribe(ctx, p, channel) {
					rejected = append(rejected, channel)
					continue
				}
				c.mu.Lock()
				if len(c.channels) < 64 {
					c.channels[channel] = true
					if strings.HasPrefix(channel, "activity."+c.owner+".") {
						c.activityGeneration++
					}
					if channel == "notifications."+c.owner {
						c.notificationGeneration++
					}
					granted = append(granted, channel)
				} else {
					rejected = append(rejected, channel)
				}
				c.mu.Unlock()
			}
			if !h.deliver(c, map[string]any{"type": "subscriptions", "channels": granted, "rejected": rejected}) {
				return
			}
		default:
			if !h.deliver(c, map[string]string{"type": "error", "message": "Unknown command"}) {
				return
			}
		}
	}
}

func (h *realtimeHub) closeAccountConnections(owner string) {
	h.mu.Lock()
	clients := []*liveClient{}
	for client := range h.clients {
		if client.owner == owner {
			clients = append(clients, client)
		}
	}
	h.mu.Unlock()
	for _, client := range clients {
		_ = client.conn.CloseNow()
	}
}

func (h *realtimeHub) deliver(c *liveClient, message any) bool {
	select {
	case c.send <- message:
		return true
	default:
		_ = c.conn.CloseNow()
		return false
	}
}
func (h *realtimeHub) canSubscribe(ctx context.Context, p Principal, channel string) bool {
	if channel == "activity."+p.UUID+".own" {
		return true
	}
	if channel == "activity."+p.UUID+".all" {
		return p.Admin
	}
	if channel == "notifications."+p.UUID {
		return p.Admin
	}
	if channel == "chat.global" {
		return true
	}
	if channel == "system.logs" || channel == "system.sync_status" {
		return p.Admin
	}
	parts := strings.Split(channel, ".")
	if len(parts) != 3 || parts[2] != "sessions" {
		return false
	}
	id, err := strconv.ParseInt(parts[1], 10, 64)
	if err != nil || id <= 0 {
		return false
	}
	var allowed bool
	err = h.store.reader.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM media_servers s JOIN provider_settings ps ON ps.provider_id=s.service_type WHERE s.id=? AND s.service_type=? AND s.is_active=1 AND ps.enabled=1
	 AND (? OR EXISTS(SELECT 1 FROM service_accounts a JOIN service_links l ON l.service_uuid=a.uuid
	 WHERE a.server_id=s.id AND a.is_active=1 AND l.user_uuid=? AND l.link_kind='owner'
	 AND (a.access_expires_at IS NULL OR julianday(a.access_expires_at)>julianday('now')))))`, id, parts[0], p.Admin, p.UUID).Scan(&allowed)
	return err == nil && allowed
}

// publish revalidates current session/role/resource scope for every recipient.
// Session payloads are copied and filtered before recomputing visible counts.
func (h *realtimeHub) publish(channel, eventType string, payload map[string]any) {
	h.mu.Lock()
	clients := make([]*liveClient, 0, len(h.clients))
	for c := range h.clients {
		clients = append(clients, c)
	}
	h.mu.Unlock()
	for _, c := range clients {
		c.mu.RLock()
		subscribed := c.channels[channel]
		c.mu.RUnlock()
		if !subscribed {
			continue
		}
		p, err := h.store.Authenticate(h.ctx, c.accessToken())
		if err != nil {
			_ = c.conn.CloseNow()
			continue
		}
		if !h.canSubscribe(h.ctx, p, channel) {
			continue
		}
		visible := payload
		if eventType == "SessionUpdate" && !p.Admin {
			visible = filterSessions(payload, p.UUID)
		}
		h.deliver(c, map[string]any{"type": "event", "event": map[string]any{"channel": channel, "type": eventType, "payload": visible, "timestamp": utcTimestamp(time.Now())}})
	}
}

func (a *App) postChat(w http.ResponseWriter, r *http.Request) {
	p, ok := a.principal(w, r, false)
	if !ok {
		return
	}
	var input struct {
		Message string `json:"message"`
	}
	if !decodeBody(w, r, &input) {
		return
	}
	message := strings.TrimSpace(input.Message)
	if message == "" || len([]rune(message)) > 4000 {
		fail(w, 400, "INVALID_MESSAGE", "Message must contain 1 to 4000 characters")
		return
	}
	created := utcTimestamp(time.Now())
	var id int64
	err := a.store.write(r.Context(), func(tx *sql.Tx) error {
		if _, err := loadPrincipal(r.Context(), tx, p.UUID); err != nil {
			return err
		}
		result, err := tx.ExecContext(r.Context(), "INSERT INTO chat_messages(user_uuid,message,created_at) VALUES(?,?,?)", p.UUID, message, created)
		if err != nil {
			return err
		}
		id, err = result.LastInsertId()
		return err
	})
	if err != nil {
		fail(w, 503, "CHAT_UNAVAILABLE", "Message was not saved")
		return
	}
	data := map[string]any{"id": id, "user_uuid": p.UUID, "username": p.Username, "message": message, "created_at": created}
	a.hub.publish("chat.global", "ChatMessage", data)
	respond(w, 201, data)
}
func (a *App) getChat(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.principal(w, r, false); !ok {
		return
	}
	before := int64(1<<63 - 1)
	if raw := r.URL.Query().Get("before_id"); raw != "" {
		var err error
		before, err = strconv.ParseInt(raw, 10, 64)
		if err != nil || before <= 0 {
			fail(w, 400, "INVALID_CURSOR", "Invalid chat cursor")
			return
		}
	}
	rows, err := a.store.reader.QueryContext(r.Context(), `SELECT c.id,c.user_uuid,coalesce(u.local_username,''),c.message,c.created_at FROM chat_messages c JOIN user_accounts u ON u.uuid=c.user_uuid WHERE c.id<? ORDER BY c.id DESC LIMIT 50`, before)
	if err != nil {
		fail(w, 503, "CHAT_UNAVAILABLE", "Could not load messages")
		return
	}
	defer rows.Close()
	messages := []map[string]any{}
	for rows.Next() {
		var id int64
		var uuid, username, message, created string
		if err := rows.Scan(&id, &uuid, &username, &message, &created); err != nil {
			fail(w, 503, "CHAT_UNAVAILABLE", "Could not load messages")
			return
		}
		messages = append(messages, map[string]any{"id": id, "user_uuid": uuid, "username": username, "message": message, "created_at": created})
	}
	if rows.Err() != nil {
		fail(w, 503, "CHAT_UNAVAILABLE", "Could not load messages")
		return
	}
	respond(w, 200, messages)
}

func filterSessions(payload map[string]any, uuid string) map[string]any {
	filtered := []any{}
	if sessions, ok := payload["sessions"].([]any); ok {
		for _, raw := range sessions {
			session, ok := raw.(map[string]any)
			if !ok {
				continue
			}
			user, ok := session["user"].(map[string]any)
			if ok && user["uuid"] == uuid {
				filtered = append(filtered, session)
			}
		}
	}
	return map[string]any{"sessions": filtered, "active_count": len(filtered)}
}
