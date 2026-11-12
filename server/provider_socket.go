package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"sync"
	"sync/atomic"
	"time"

	"app/server/providers/provider"

	"github.com/coder/websocket"
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

func (a *App) runProviderSocket(ctx context.Context, w *providerSocketWorker, server ManagedServer) {
	defer close(w.done)
	// The service's module describes its socket and reads its frames; this
	// loop owns dialing, retries, the queue and status.
	var live liveConnector
	var spec provider.LiveConnection
	err := errActivitySnapshot
	if m, ok := findMediaModule(server.Type); ok {
		if live, ok = m.New(provider.Config{URL: server.URL, APIKey: server.apiKey}).(liveConnector); ok {
			spec, err = live.LiveConnection("mum-" + a.scheduler.runner)
		}
	}
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
		conn, response, err := websocket.Dial(dial, spec.URL, &websocket.DialOptions{HTTPClient: &clone, HTTPHeader: spec.Header.Clone()})
		cancel()
		if response != nil && response.Body != nil {
			response.Body.Close()
		}
		if err == nil {
			conn.SetReadLimit(provider.MaxLiveFrameBytes)
			heartbeatCtx, stopHeartbeat := context.WithCancel(ctx)
			heartbeatDone := make(chan struct{})
			if spec.PingInterval > 0 {
				go providerSocketHeartbeat(heartbeatCtx, conn, spec.PingInterval, heartbeatDone)
			} else {
				close(heartbeatDone)
			}
			if len(spec.Start) > 0 {
				write, stop := context.WithTimeout(ctx, 2*time.Second)
				err = conn.Write(write, websocket.MessageText, spec.Start)
				stop()
			}
			if err == nil {
				w.status("connected", "")
				a.logger.Info("Provider socket connected", "server_id", server.ID, "provider", server.Type)
				w.dirty.Store(true)
			}
			for err == nil && ctx.Err() == nil {
				read, stop := ctx, func() {}
				if spec.ReadTimeout > 0 {
					read, stop = context.WithTimeout(ctx, spec.ReadTimeout)
				}
				var kind websocket.MessageType
				var data []byte
				kind, data, err = conn.Read(read)
				stop()
				if err != nil {
					break
				}
				if kind != websocket.MessageText && !(spec.Binary && kind == websocket.MessageBinary) {
					err = errActivitySnapshot
					break
				}
				hint, reply, eventErr := live.LiveEvent(data)
				if err = eventErr; err != nil {
					break
				}
				if len(reply) > 0 {
					write, stop := context.WithTimeout(ctx, 2*time.Second)
					err = conn.Write(write, websocket.MessageText, reply)
					stop()
					continue
				}
				if hint == "" {
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

// providerSocketHeartbeat pings the connection every interval and closes it
// when a ping fails.
func providerSocketHeartbeat(ctx context.Context, conn *websocket.Conn, interval time.Duration, done chan struct{}) {
	defer close(done)
	ticker := time.NewTicker(interval)
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
