package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// Debug logging records what media servers send MUM, for troubleshooting:
// HTTP responses and WebSocket frames, one JSON line each, per service and
// transport. Each stream is switched on for a limited time and turns itself
// off. Credentials are removed before anything is written: tokens, API keys,
// passwords and cookies in URLs and bodies, and request bodies are never
// logged. Records go through a bounded queue so provider traffic never waits
// on the disk; when it is full, records are dropped and counted. Files rotate
// at a fixed size and keep a few older parts.

const (
	debugLogDirectory  = "Debug Logs"
	debugLogWindow     = 24 * time.Hour
	debugLogFileBytes  = 5 << 20
	debugLogBackups    = 3
	debugLogBodyBytes  = 256 << 10
	debugLogQueueSize  = 1024
	debugLogTailLimit  = 200
	debugLogServerTTL  = 30 * time.Second
	debugLogSettingKey = "DEBUG_LOG_"
	debugLogRedacted   = "[redacted]"
)

type debugRecord struct {
	Time       string `json:"time"`
	ServerID   int64  `json:"server_id,omitempty"`
	Server     string `json:"server,omitempty"`
	Provider   string `json:"provider"`
	Transport  string `json:"transport"`
	Direction  string `json:"direction"`
	Method     string `json:"method,omitempty"`
	URL        string `json:"url,omitempty"`
	Status     int    `json:"status,omitempty"`
	DurationMS int64  `json:"duration_ms,omitempty"`
	Bytes      int    `json:"bytes"`
	Truncated  bool   `json:"truncated,omitempty"`
	Error      string `json:"error,omitempty"`
	Body       string `json:"body,omitempty"`
	// contentType chooses the redaction; it is not written.
	contentType string
}

type debugServer struct {
	id                 int64
	name, provider     string
	scheme, host, path string
}

type debugPayloadLog struct {
	dir     string
	store   *Store
	enabled atomic.Pointer[map[string]time.Time]
	servers atomic.Pointer[[]debugServer]
	// serversAt is when servers was read; refreshing marks a read in progress.
	serversAt  atomic.Int64
	refreshing atomic.Bool
	queue      chan debugRecord
	// sending guards queue against a record arriving while it closes.
	sending   sync.RWMutex
	closed    bool
	dropped   atomic.Int64
	mu        sync.Mutex
	files     map[string]*os.File
	closeOnce sync.Once
	done      chan struct{}
}

func debugStreamKey(provider, transport string) string { return provider + "-" + transport }

func newDebugPayloadLog(store *Store) *debugPayloadLog {
	l := &debugPayloadLog{store: store, queue: make(chan debugRecord, debugLogQueueSize), files: map[string]*os.File{}, done: make(chan struct{})}
	if store != nil && store.dataDir != "" {
		l.dir = filepath.Join(store.dataDir, debugLogDirectory)
	}
	empty := map[string]time.Time{}
	l.enabled.Store(&empty)
	noServers := []debugServer{}
	l.servers.Store(&noServers)
	go l.write()
	return l
}

// load reads which streams are switched on and until when.
func (l *debugPayloadLog) load(ctx context.Context) error {
	rows, err := l.store.reader.QueryContext(ctx, "SELECT key,value FROM settings WHERE key LIKE 'DEBUG_LOG_%'")
	if err != nil {
		return err
	}
	defer rows.Close()
	streams := map[string]time.Time{}
	for rows.Next() {
		var key, value string
		if err := rows.Scan(&key, &value); err != nil {
			return err
		}
		until, err := time.Parse(time.RFC3339Nano, value)
		if err == nil {
			streams[strings.TrimPrefix(key, debugLogSettingKey)] = until
		}
	}
	if err := rows.Err(); err != nil {
		return err
	}
	l.enabled.Store(&streams)
	l.serversAt.Store(0)
	return nil
}

func (l *debugPayloadLog) until(provider, transport string) (time.Time, bool) {
	until, ok := (*l.enabled.Load())[debugStreamKey(provider, transport)]
	return until, ok && time.Now().Before(until)
}

func (l *debugPayloadLog) on(provider, transport string) bool {
	_, on := l.until(provider, transport)
	return on && l.dir != ""
}

func (l *debugPayloadLog) anyOn() bool {
	now := time.Now()
	for _, until := range *l.enabled.Load() {
		if now.Before(until) {
			return true
		}
	}
	return false
}

// serverFor names the configured media server a request goes to. The list is
// reread in the background when it is older than a short interval.
func (l *debugPayloadLog) serverFor(u *url.URL) (debugServer, bool) {
	if time.Since(time.Unix(0, l.serversAt.Load())) > debugLogServerTTL && l.refreshing.CompareAndSwap(false, true) {
		go func() {
			defer l.refreshing.Store(false)
			ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			defer cancel()
			if err := l.readServers(ctx); err == nil {
				l.serversAt.Store(time.Now().UnixNano())
			}
		}()
	}
	for _, s := range *l.servers.Load() {
		if strings.EqualFold(u.Scheme, s.scheme) && strings.EqualFold(u.Host, s.host) && strings.HasPrefix(u.Path, s.path) {
			return s, true
		}
	}
	return debugServer{}, false
}

func (l *debugPayloadLog) readServers(ctx context.Context) error {
	rows, err := l.store.reader.QueryContext(ctx, "SELECT id,server_nickname,service_type,url FROM media_servers")
	if err != nil {
		return err
	}
	defer rows.Close()
	list := []debugServer{}
	for rows.Next() {
		var s debugServer
		var raw string
		if err := rows.Scan(&s.id, &s.name, &s.provider, &raw); err != nil {
			return err
		}
		u, err := url.Parse(raw)
		if err != nil || u.Host == "" {
			continue
		}
		s.scheme, s.host, s.path = u.Scheme, u.Host, strings.TrimRight(u.Path, "/")
		list = append(list, s)
	}
	if err := rows.Err(); err != nil {
		return err
	}
	l.servers.Store(&list)
	return nil
}

// record queues one record without waiting; a full queue drops it.
func (l *debugPayloadLog) record(r debugRecord) {
	l.sending.RLock()
	defer l.sending.RUnlock()
	if l.closed {
		return
	}
	select {
	case l.queue <- r:
	default:
		l.dropped.Add(1)
	}
}

// socketFrame records a WebSocket frame a provider sent or MUM sent it.
func (l *debugPayloadLog) socketFrame(server ManagedServer, direction string, data []byte) {
	if l == nil || !l.on(server.Type, "websocket") {
		return
	}
	body, truncated := data, false
	if len(body) > debugLogBodyBytes {
		body, truncated = body[:debugLogBodyBytes], true
	}
	l.record(debugRecord{Time: utcTimestamp(time.Now()), ServerID: server.ID, Server: server.Name, Provider: server.Type, Transport: "websocket",
		Direction: direction, Bytes: len(data), Truncated: truncated, Body: string(body), contentType: "application/json"})
}

func (l *debugPayloadLog) write() {
	defer close(l.done)
	for r := range l.queue {
		r.URL = redactDebugURL(r.URL)
		r.Body = redactDebugBody(r.Body, r.contentType)
		line, err := json.Marshal(r)
		if err != nil {
			continue
		}
		l.mu.Lock()
		if err := l.appendLine(debugStreamKey(r.Provider, r.Transport), append(line, '\n')); err != nil {
			l.dropped.Add(1)
		}
		l.mu.Unlock()
	}
	l.mu.Lock()
	for key, f := range l.files {
		_ = f.Close()
		delete(l.files, key)
	}
	l.mu.Unlock()
}

// appendLine writes to the stream's file, rotating it past the size limit.
// The caller holds mu.
func (l *debugPayloadLog) appendLine(stream string, line []byte) error {
	if l.dir == "" {
		return errors.New("debug logging has no data directory")
	}
	f := l.files[stream]
	if f == nil {
		if err := os.MkdirAll(l.dir, 0o700); err != nil {
			return err
		}
		var err error
		if f, err = os.OpenFile(filepath.Join(l.dir, stream+".log"), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600); err != nil {
			return err
		}
		l.files[stream] = f
	}
	if info, err := f.Stat(); err == nil && info.Size()+int64(len(line)) > debugLogFileBytes {
		_ = f.Close()
		delete(l.files, stream)
		base := filepath.Join(l.dir, stream+".log")
		_ = os.Remove(fmt.Sprintf("%s.%d", base, debugLogBackups))
		for n := debugLogBackups - 1; n >= 1; n-- {
			_ = os.Rename(fmt.Sprintf("%s.%d", base, n), fmt.Sprintf("%s.%d", base, n+1))
		}
		_ = os.Rename(base, base+".1")
		return l.appendLine(stream, line)
	}
	_, err := f.Write(line)
	return err
}

// close stops accepting records and waits for the queued ones to be written.
func (l *debugPayloadLog) close() {
	if l == nil {
		return
	}
	l.closeOnce.Do(func() {
		l.sending.Lock()
		l.closed = true
		close(l.queue)
		l.sending.Unlock()
		<-l.done
	})
}

// clear removes every log file.
func (l *debugPayloadLog) clear() error {
	l.mu.Lock()
	defer l.mu.Unlock()
	for key, f := range l.files {
		_ = f.Close()
		delete(l.files, key)
	}
	files, err := l.list()
	if err != nil {
		return err
	}
	var errs []error
	for _, f := range files {
		errs = append(errs, os.Remove(filepath.Join(l.dir, f.Name)))
	}
	return errors.Join(errs...)
}

type debugLogFile struct {
	Name      string `json:"name"`
	Provider  string `json:"provider"`
	Transport string `json:"transport"`
	Part      int    `json:"part"`
	Size      int64  `json:"size_bytes"`
	Modified  string `json:"modified_at"`
}

var debugLogFileName = regexp.MustCompile(`^([a-z]+)-(http|websocket)\.log(?:\.([1-3]))?$`)

func (l *debugPayloadLog) list() ([]debugLogFile, error) {
	files := []debugLogFile{}
	if l.dir == "" {
		return files, nil
	}
	entries, err := os.ReadDir(l.dir)
	if errors.Is(err, os.ErrNotExist) {
		return files, nil
	}
	if err != nil {
		return nil, err
	}
	for _, entry := range entries {
		m := debugLogFileName.FindStringSubmatch(entry.Name())
		if m == nil || !entry.Type().IsRegular() {
			continue
		}
		info, err := entry.Info()
		if err != nil {
			continue
		}
		part := 0
		if m[3] != "" {
			part = int(m[3][0] - '0')
		}
		files = append(files, debugLogFile{Name: entry.Name(), Provider: m[1], Transport: m[2], Part: part, Size: info.Size(), Modified: utcTimestamp(info.ModTime())})
	}
	slices.SortFunc(files, func(a, b debugLogFile) int {
		if c := strings.Compare(a.Provider+a.Transport, b.Provider+b.Transport); c != 0 {
			return c
		}
		return a.Part - b.Part
	})
	return files, nil
}

// tail returns the newest records of a stream's current file, newest first.
func (l *debugPayloadLog) tail(provider, transport string, limit int) ([]json.RawMessage, error) {
	out := []json.RawMessage{}
	if l.dir == "" {
		return out, nil
	}
	f, err := os.Open(filepath.Join(l.dir, debugStreamKey(provider, transport)+".log"))
	if errors.Is(err, os.ErrNotExist) {
		return out, nil
	}
	if err != nil {
		return nil, err
	}
	defer f.Close()
	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 64<<10), 4*debugLogBodyBytes)
	for scanner.Scan() {
		line := slices.Clone(scanner.Bytes())
		if !json.Valid(line) {
			continue
		}
		out = append(out, line)
		if len(out) > limit {
			out = out[1:]
		}
	}
	if err := scanner.Err(); err != nil {
		return nil, err
	}
	slices.Reverse(out)
	return out, nil
}

// Redaction. Names are compared lowercased without separators, so
// "X-Plex-Token", "api_key" and "accessToken" all match.

func debugNormalName(name string) string {
	return strings.NewReplacer("-", "", "_", "", ".", "").Replace(strings.ToLower(name))
}

// debugCodeName is a sign-in code or PIN: secret when it is text, while
// numeric fields of the same name are error or status codes.
func debugCodeName(name string) bool {
	n := debugNormalName(name)
	return n == "pin" || n == "code"
}

func debugSecretName(name string) bool {
	n := debugNormalName(name)
	if n == "pw" {
		return true
	}
	for _, part := range []string{"token", "password", "passwd", "secret", "apikey", "authorization", "cookie", "signature", "credential"} {
		if strings.Contains(n, part) {
			return true
		}
	}
	return false
}

func redactDebugURL(raw string) string {
	if raw == "" {
		return ""
	}
	u, err := url.Parse(raw)
	if err != nil {
		return debugLogRedacted
	}
	u.User = nil
	query := u.Query()
	for key := range query {
		if debugSecretName(key) {
			query[key] = []string{debugLogRedacted}
		}
	}
	u.RawQuery = query.Encode()
	return u.String()
}

var (
	debugXMLSecret  = regexp.MustCompile(`(?i)\b([a-z0-9_:-]*(?:token|password|secret|apikey|api_key|signature))\s*=\s*"[^"]*"`)
	debugTextSecret = regexp.MustCompile(`(?i)\b([a-z0-9_-]*(?:token|password|secret|apikey|api_key|signature))(=|:\s*)([^&\s"',;]+)`)
)

func redactDebugJSON(value any) any {
	switch v := value.(type) {
	case map[string]any:
		for key, child := range v {
			if _, text := child.(string); debugSecretName(key) || text && debugCodeName(key) {
				if child != nil && child != "" {
					v[key] = debugLogRedacted
				}
				continue
			}
			v[key] = redactDebugJSON(child)
		}
	case []any:
		for n, child := range v {
			v[n] = redactDebugJSON(child)
		}
	}
	return value
}

func redactDebugBody(body, contentType string) string {
	if body == "" {
		return ""
	}
	trimmed := bytes.TrimSpace([]byte(body))
	if len(trimmed) > 0 && (trimmed[0] == '{' || trimmed[0] == '[') {
		decoder := json.NewDecoder(bytes.NewReader(trimmed))
		decoder.UseNumber()
		var value any
		if decoder.Decode(&value) == nil {
			if out, err := json.Marshal(redactDebugJSON(value)); err == nil {
				return string(out)
			}
		}
	}
	if strings.Contains(contentType, "xml") || (len(trimmed) > 0 && trimmed[0] == '<') {
		body = debugXMLSecret.ReplaceAllString(body, `$1="`+debugLogRedacted+`"`)
	}
	return debugTextSecret.ReplaceAllString(body, "${1}${2}"+debugLogRedacted)
}

// debugTransport records the responses of requests to configured media
// servers while their service's HTTP stream is on. Other requests, socket
// upgrades and binary responses such as images pass through untouched.
type debugTransport struct {
	base http.RoundTripper
	log  *debugPayloadLog
}

func (t debugTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	base := t.base
	if base == nil {
		base = http.DefaultTransport
	}
	if t.log == nil || !t.log.anyOn() || req.Header.Get("Upgrade") != "" {
		return base.RoundTrip(req)
	}
	server, ok := t.log.serverFor(req.URL)
	if !ok || !t.log.on(server.provider, "http") {
		return base.RoundTrip(req)
	}
	started := time.Now()
	response, err := base.RoundTrip(req)
	r := debugRecord{Time: utcTimestamp(started), ServerID: server.id, Server: server.name, Provider: server.provider, Transport: "http",
		Direction: "response", Method: req.Method, URL: req.URL.String()}
	if err != nil {
		r.Error = "request failed or timed out"
		r.DurationMS = time.Since(started).Milliseconds()
		t.log.record(r)
		return response, err
	}
	r.Status = response.StatusCode
	contentType := strings.ToLower(response.Header.Get("Content-Type"))
	if !strings.Contains(contentType, "json") && !strings.Contains(contentType, "xml") && !strings.HasPrefix(contentType, "text/") {
		if response.StatusCode >= 200 && response.StatusCode < 300 {
			return response, nil
		}
		r.DurationMS = time.Since(started).Milliseconds()
		t.log.record(r)
		return response, nil
	}
	r.contentType = contentType
	response.Body = &debugBody{ReadCloser: response.Body, started: started, record: r, log: t.log}
	return response, nil
}

// debugBody keeps the first part of a response body as the caller reads it
// and queues the record when the body is closed.
type debugBody struct {
	io.ReadCloser
	started time.Time
	record  debugRecord
	log     *debugPayloadLog
	kept    bytes.Buffer
	total   int
	once    sync.Once
}

func (b *debugBody) Read(p []byte) (int, error) {
	n, err := b.ReadCloser.Read(p)
	if n > 0 {
		b.total += n
		if room := debugLogBodyBytes - b.kept.Len(); room > 0 {
			b.kept.Write(p[:min(n, room)])
		}
	}
	return n, err
}

func (b *debugBody) Close() error {
	err := b.ReadCloser.Close()
	b.once.Do(func() {
		b.record.DurationMS = time.Since(b.started).Milliseconds()
		b.record.Bytes = b.total
		b.record.Truncated = b.total > b.kept.Len()
		b.record.Body = b.kept.String()
		b.log.record(b.record)
	})
	return err
}
