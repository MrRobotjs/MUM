package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
)

type providerSocketTarget struct {
	Server, Revision, SourceRevision int64
	Actor                            string
}
type providerSocketWorker struct {
	target      providerSocketTarget
	cancel      context.CancelFunc
	done        chan struct{}
	dirty       atomic.Bool
	lastNudge   time.Time // Supervisor only.
	mu          sync.Mutex
	state, code string
}
type providerSocketRuntime struct {
	mu      sync.Mutex
	workers map[int64]*providerSocketWorker
	done    chan struct{}
	code    string
}

func (w *providerSocketWorker) status(state, code string) {
	w.mu.Lock()
	w.state = state
	if state == "connected" {
		w.code = ""
	}
	if code != "" {
		w.code = code
	}
	w.mu.Unlock()
}

func providerSocketURL(server ManagedServer, device string) (string, error) {
	u, err := url.Parse(server.URL)
	if err != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || server.apiKey == "" {
		return "", ErrConflict
	}
	switch u.Scheme {
	case "http":
		u.Scheme = "ws"
	case "https":
		u.Scheme = "wss"
	default:
		return "", ErrConflict
	}
	if server.Type == "jellyfin" {
		u.Path = strings.TrimRight(u.Path, "/") + "/socket"
	} else if server.Type == "plex" {
		u.Path = strings.TrimRight(u.Path, "/") + "/:/websockets/notifications"
	} else if server.Type != "emby" {
		return "", ErrConflict
	}
	u.RawPath = ""
	q := url.Values{}
	if server.Type != "plex" {
		q.Set("api_key", server.apiKey)
		q.Set("deviceId", device)
	}
	u.RawQuery = q.Encode()
	return u.String(), nil
}

// Validate envelope JSON, discard Data entirely, and persist only this allowlisted type.
func providerSocketHint(data []byte) (string, error) {
	frame, err := decodeProviderSocketFrame(data)
	if err != nil {
		return "", err
	}
	var message string
	if raw, ok := frame["MessageType"]; !ok || json.Unmarshal(raw, &message) != nil || message == "" {
		return "", errActivitySnapshot
	}
	switch message {
	case "Sessions", "SessionStart", "SessionEnded", "PlaybackStart", "PlaybackStopped", "PlaybackProgress", "ForceKeepAlive":
		return message, nil
	}
	return "", nil
}

func decodeProviderSocketFrame(data []byte) (map[string]json.RawMessage, error) {
	if len(data) > 64*1024 || !json.Valid(data) {
		return nil, errActivitySnapshot
	}
	d := json.NewDecoder(bytes.NewReader(data))
	if err := activityJSONValue(d, 0); err != nil {
		return nil, err
	}
	if _, err := d.Token(); !errors.Is(err, io.EOF) {
		return nil, errActivitySnapshot
	}
	var frame map[string]json.RawMessage
	if err := json.Unmarshal(data, &frame); err != nil {
		return nil, errActivitySnapshot
	}
	return frame, nil
}

func plexSocketHint(data []byte) (string, error) {
	frame, err := decodeProviderSocketFrame(data)
	if err != nil {
		return "", err
	}
	var notification struct {
		Type string `json:"type"`
	}
	if raw, ok := frame["NotificationContainer"]; !ok || json.Unmarshal(raw, &notification) != nil || notification.Type == "" {
		return "", errActivitySnapshot
	}
	switch notification.Type {
	case "playing", "timeline", "activity", "transcodeSession.start", "transcodeSession.end":
		return notification.Type, nil
	}
	return "", nil
}

func (a *App) runProviderSocket(ctx context.Context, w *providerSocketWorker, server ManagedServer) {
	defer close(w.done)
	endpoint, err := providerSocketURL(server, "mum-"+a.scheduler.runner)
	if err != nil {
		w.status("failed", "INVALID_SOURCE")
		return
	}
	client := http.DefaultClient
	if a.ProviderHTTP != nil {
		client = a.ProviderHTTP
	}
	clone := *client
	clone.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	backoff := time.Second
	for ctx.Err() == nil {
		w.status("connecting", "")
		a.logger.Debug("Provider socket connecting", "server_id", server.ID, "provider", server.Type)
		dial, cancel := context.WithTimeout(ctx, 5*time.Second)
		headers := make(http.Header)
		if server.Type == "plex" {
			headers.Set("X-Plex-Token", server.apiKey)
			headers.Set("X-Plex-Client-Identifier", "mum-"+a.scheduler.runner)
		}
		conn, response, err := websocket.Dial(dial, endpoint, &websocket.DialOptions{HTTPClient: &clone, HTTPHeader: headers})
		cancel()
		if response != nil && response.Body != nil {
			response.Body.Close()
		}
		if err == nil {
			conn.SetReadLimit(64 * 1024)
			heartbeatCtx, stopHeartbeat := context.WithCancel(ctx)
			heartbeatDone := make(chan struct{})
			if server.Type == "plex" {
				go plexSocketHeartbeat(heartbeatCtx, conn, heartbeatDone)
			} else {
				close(heartbeatDone)
				write, stop := context.WithTimeout(ctx, 2*time.Second)
				err = wsjson.Write(write, conn, map[string]string{"MessageType": "SessionsStart", "Data": "0,5000"})
				stop()
			}
			if err == nil {
				w.status("connected", "")
				a.logger.Info("Provider socket connected", "server_id", server.ID, "provider", server.Type)
				w.dirty.Store(true)
			}
			for err == nil && ctx.Err() == nil {
				read, stop := ctx, func() {}
				if server.Type != "plex" {
					read, stop = context.WithTimeout(ctx, 45*time.Second)
				}
				var kind websocket.MessageType
				var data []byte
				kind, data, err = conn.Read(read)
				stop()
				if err != nil {
					break
				}
				if kind != websocket.MessageText && !(server.Type == "plex" && kind == websocket.MessageBinary) {
					err = errActivitySnapshot
					break
				}
				var hint string
				if server.Type == "plex" {
					hint, err = plexSocketHint(data)
				} else {
					hint, err = providerSocketHint(data)
				}
				if err != nil {
					break
				}
				if hint == "" {
					continue
				}
				if hint == "ForceKeepAlive" {
					write, stop := context.WithTimeout(ctx, 2*time.Second)
					err = wsjson.Write(write, conn, map[string]string{"MessageType": "KeepAlive"})
					stop()
					continue
				}
				payload, _ := json.Marshal(struct {
					Message string `json:"message_type"`
					Bytes   int    `json:"bytes"`
				}{hint, len(data)})
				id := server.ID
				err = a.queue.Enqueue(LogEntry{ServerID: &id, Source: server.Type + ".socket", Type: "provider.activity.hint", Payload: payload})
				if err == nil {
					a.logger.Debug("Provider socket activity hint queued", "server_id", server.ID, "provider", server.Type, "message_type", hint)
					w.dirty.Store(true)
					backoff = time.Second
				} else {
					w.status("backoff", "QUEUE_REJECTED")
				}
			}
			conn.CloseNow()
			stopHeartbeat()
			<-heartbeatDone
		}
		if ctx.Err() != nil {
			break
		}
		w.status("backoff", "TRANSPORT_FAILED")
		a.logger.Warn("Provider socket unavailable; HTTP polling remains active", "server_id", server.ID, "provider", server.Type, "retry_seconds", backoff.Seconds())
		if errors.Is(err, ErrQueueFull) || errors.Is(err, ErrQueueClosed) || errors.Is(err, ErrQueueFailed) {
			w.status("backoff", "QUEUE_REJECTED")
		}
		timer := time.NewTimer(backoff)
		select {
		case <-ctx.Done():
			timer.Stop()
		case <-timer.C:
		}
		backoff = min(backoff*2, 30*time.Second)
	}
	w.status("stopped", "")
	a.logger.Info("Provider socket stopped", "server_id", server.ID, "provider", server.Type)
}

func plexSocketHeartbeat(ctx context.Context, conn *websocket.Conn, done chan struct{}) {
	defer close(done)
	ticker := time.NewTicker(20 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			ping, cancel := context.WithTimeout(ctx, 5*time.Second)
			err := conn.Ping(ping)
			cancel()
			if err != nil {
				conn.CloseNow()
				return
			}
		}
	}
}
