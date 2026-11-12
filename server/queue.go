package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

var (
	ErrQueueFull   = errors.New("log queue is full; retry later")
	ErrQueueClosed = errors.New("log queue is closed")
	ErrQueueFailed = errors.New("log queue stopped after a persistence failure")
	// ErrQueueStalled reports a transient persistence failure: accepted records
	// are kept and retried, and the queue resumes when writes succeed again.
	ErrQueueStalled = errors.New("log queue is stalled; accepted records are kept and retried")
)

// LogEntry is operational telemetry, not a stream-history or admin-audit row.
// EventKey is an optional source-provided idempotency key scoped to source/server.
type LogEntry struct {
	ServerID   *int64          `json:"server_id,omitempty"`
	Source     string          `json:"source"`
	EventKey   string          `json:"event_key,omitempty"`
	Type       string          `json:"type"`
	Payload    json.RawMessage `json:"payload"`
	OccurredAt time.Time       `json:"occurred_at"`
	ReceivedAt time.Time       `json:"received_at"`
}

func (e LogEntry) validate() error {
	if strings.TrimSpace(e.Source) == "" || len(e.Source) > 100 || strings.TrimSpace(e.Type) == "" || len(e.Type) > 100 {
		return errors.New("event source and type are required and limited to 100 bytes")
	}
	if len(e.EventKey) > 512 || len(e.Payload) > 64*1024 || !json.Valid(e.Payload) {
		return errors.New("event requires valid JSON up to 64 KiB and an event key up to 512 bytes")
	}
	if e.ServerID != nil && *e.ServerID <= 0 {
		return errors.New("event server ID must be positive")
	}
	return nil
}

// WriteLogBatch commits the whole batch or none of it. No handler should insert
// ingested logs directly; the queue is the batch writer's producer boundary.
func (s *Store) WriteLogBatch(ctx context.Context, batch []LogEntry) (int64, error) {
	for _, entry := range batch {
		if err := entry.validate(); err != nil {
			return 0, err
		}
	}
	if len(batch) == 0 {
		return 0, nil
	}
	var inserted int64
	err := s.write(ctx, func(tx *sql.Tx) error {
		stmt, err := tx.PrepareContext(ctx, `INSERT INTO log_entries
			(server_id, source, event_key, event_type, payload, occurred_at, received_at)
			VALUES (?, ?, nullif(?, ''), ?, ?, ?, ?) ON CONFLICT DO NOTHING`)
		if err != nil {
			return err
		}
		defer stmt.Close()
		for _, entry := range batch {
			if entry.OccurredAt.IsZero() {
				entry.OccurredAt = time.Now()
			}
			if entry.ReceivedAt.IsZero() {
				entry.ReceivedAt = time.Now()
			}
			result, err := stmt.ExecContext(ctx, entry.ServerID, entry.Source, entry.EventKey, entry.Type,
				string(entry.Payload), utcTimestamp(entry.OccurredAt), utcTimestamp(entry.ReceivedAt))
			if err != nil {
				return err
			}
			n, err := result.RowsAffected()
			if err != nil {
				return err
			}
			inserted += n
		}
		return nil
	})
	if err != nil {
		return 0, err
	}
	return inserted, nil
}

type BatchLogWriter interface {
	WriteLogBatch(context.Context, []LogEntry) (int64, error)
}

type QueueOptions struct {
	Capacity      int
	BatchSize     int
	FlushInterval time.Duration
	WriteTimeout  time.Duration
	MaxAttempts   int           // Quick attempts before the stall is reported.
	RetryDelay    time.Duration // First retry pause; doubles while stalled.
	MaxRetryDelay time.Duration // Cap on the stalled retry pause.
}

type QueueStats struct {
	Accepted  uint64
	Processed uint64 // Includes duplicate event keys handled by a committed batch.
	Inserted  uint64
	Rejected  uint64
	Pending   uint64 // Accepted but not successfully processed, including failed drain.
}

// LogQueue is a bounded FIFO. It never evicts previously accepted records.
// Enqueue acknowledges memory admission, NOT durability. Shutdown must complete
// before closing Store.
//
// A persistence failure stalls the queue instead of stopping it (user decision,
// DECISIONS.md 2026-11-05): the failed batch is kept and retried with backoff,
// queued records stay in order, Err reports the stall, and Enqueue keeps
// admitting until the buffer is full (ErrQueueFull). The first successful write
// clears the stall and processing resumes without a restart. Only Shutdown can
// end a stall: after its deadline the worker stops retrying and the unwritten
// records are reported as failed (ErrQueueFailed, Stats.Pending).
type LogQueue struct {
	logger                                  *slog.Logger
	entries                                 chan LogEntry
	done                                    chan struct{}
	abandon                                 chan struct{} // Closed when a Shutdown deadline passes.
	abandonOnce                             sync.Once
	writer                                  BatchLogWriter
	options                                 QueueOptions
	mu                                      sync.RWMutex // Protects admission/close against concurrent senders.
	closed                                  bool
	err                                     error // Permanent: drain abandoned at shutdown.
	stall                                   error // Transient: cleared by the next successful write.
	accepted, processed, inserted, rejected atomic.Uint64
}

func NewLogQueue(writer BatchLogWriter, options QueueOptions) (*LogQueue, error) {
	if writer == nil {
		return nil, errors.New("a batch writer is required")
	}
	if options.Capacity == 0 {
		options.Capacity = 10000
	}
	if options.BatchSize == 0 {
		options.BatchSize = 500
	}
	if options.FlushInterval == 0 {
		options.FlushInterval = 500 * time.Millisecond
	}
	if options.WriteTimeout == 0 {
		options.WriteTimeout = 5 * time.Second
	}
	if options.MaxAttempts == 0 {
		options.MaxAttempts = 3
	}
	if options.RetryDelay == 0 {
		options.RetryDelay = 100 * time.Millisecond
	}
	if options.MaxRetryDelay == 0 {
		options.MaxRetryDelay = 5 * time.Second
	}
	if options.Capacity < 1 || options.Capacity > 100000 || options.BatchSize < 1 || options.BatchSize > 500 ||
		options.FlushInterval < time.Millisecond || options.WriteTimeout < time.Millisecond || options.MaxAttempts < 1 || options.MaxAttempts > 10 || options.RetryDelay < 0 || options.MaxRetryDelay < options.RetryDelay {
		return nil, errors.New("invalid queue bounds or timing options")
	}
	q := &LogQueue{logger: slog.Default(), entries: make(chan LogEntry, options.Capacity), done: make(chan struct{}), abandon: make(chan struct{}), writer: writer, options: options}
	go q.run()
	return q, nil
}

func (q *LogQueue) Enqueue(entry LogEntry) error {
	if err := entry.validate(); err != nil {
		return err
	}
	// Producers may reuse their buffers as soon as Enqueue returns.
	entry.Payload = append(json.RawMessage(nil), entry.Payload...)
	if entry.ServerID != nil {
		id := *entry.ServerID
		entry.ServerID = &id
	}
	if entry.ReceivedAt.IsZero() {
		entry.ReceivedAt = time.Now()
	}
	if entry.OccurredAt.IsZero() {
		entry.OccurredAt = entry.ReceivedAt
	}
	q.mu.RLock()
	defer q.mu.RUnlock()
	if q.closed {
		q.rejected.Add(1)
		if q.err != nil {
			return errors.Join(ErrQueueFailed, q.err)
		}
		return ErrQueueClosed
	}
	select {
	case q.entries <- entry:
		q.accepted.Add(1)
		return nil
	default:
		q.rejected.Add(1)
		return ErrQueueFull
	}
}

// Shutdown closes admission and drains accepted records. While writes succeed,
// a wait deadline does not cancel the drain: the caller may wait again, and
// must keep Store open. If the queue is stalled when the deadline passes, the
// worker stops retrying and the unwritten records are reported as failed.
func (q *LogQueue) Shutdown(ctx context.Context) error {
	q.mu.Lock()
	if !q.closed {
		q.closed = true
		close(q.entries)
	}
	q.mu.Unlock()
	select {
	case <-q.done:
		return q.Err()
	case <-ctx.Done():
		q.abandonOnce.Do(func() { close(q.abandon) })
		q.mu.RLock()
		stalled := q.stall != nil
		q.mu.RUnlock()
		if !stalled {
			return ctx.Err()
		}
		// A stalled worker notices the abandon signal within one retry pause.
		select {
		case <-q.done:
			if err := q.Err(); err != nil {
				return err
			}
		case <-time.After(q.options.MaxRetryDelay + q.options.WriteTimeout):
		}
		return ctx.Err()
	}
}

func (q *LogQueue) Stats() QueueStats {
	// Independent atomic snapshots can span a commit; saturate pending at zero.
	a := q.accepted.Load()
	p := q.processed.Load()
	pending := uint64(0)
	if a > p {
		pending = a - p
	}
	return QueueStats{a, p, q.inserted.Load(), q.rejected.Load(), pending}
}

// Err reports a stalled (transient) or abandoned (permanent) queue.
func (q *LogQueue) Err() error {
	q.mu.RLock()
	defer q.mu.RUnlock()
	if q.err != nil {
		return q.err
	}
	return q.stall
}

func (q *LogQueue) setStall(err error) {
	q.mu.Lock()
	wasStalled := q.stall != nil
	if err == nil {
		q.stall = nil
	} else {
		q.stall = fmt.Errorf("%w: %w", ErrQueueStalled, err)
	}
	q.mu.Unlock()
	if err != nil && !wasStalled {
		q.logger.Warn("Log persistence stalled; retaining accepted records and retrying", "pending_logs", q.Stats().Pending)
	}
	if err == nil && wasStalled {
		q.logger.Info("Log persistence resumed", "pending_logs", q.Stats().Pending)
	}
}

func (q *LogQueue) run() {
	defer close(q.done)
	ticker := time.NewTicker(q.options.FlushInterval)
	defer ticker.Stop()
	batch := make([]LogEntry, 0, q.options.BatchSize)
	flush := func() bool {
		if len(batch) == 0 {
			return true
		}
		delay := q.options.RetryDelay
		for attempt := 1; ; attempt++ {
			// Each attempt holds the single SQLite writer for at most WriteTimeout;
			// the pauses between attempts leave it free for account, invitation
			// and link transactions during a stall.
			ctx, cancel := context.WithTimeout(context.Background(), q.options.WriteTimeout)
			inserted, err := q.writer.WriteLogBatch(ctx, batch)
			cancel()
			if err == nil {
				q.inserted.Add(uint64(inserted))
				q.processed.Add(uint64(len(batch)))
				clear(batch)
				batch = batch[:0]
				q.setStall(nil)
				return true
			}
			if attempt >= q.options.MaxAttempts {
				q.setStall(err)
			}
			select {
			case <-q.abandon:
				q.mu.Lock()
				q.err = fmt.Errorf("%w: %d accepted records were not written: %w", ErrQueueFailed, len(batch)+len(q.entries), err)
				if !q.closed {
					q.closed = true
					close(q.entries)
				}
				q.mu.Unlock()
				return false
			case <-time.After(delay):
			}
			if attempt >= q.options.MaxAttempts {
				delay = min(delay*2, q.options.MaxRetryDelay)
			}
		}
	}
	for {
		select {
		case entry, ok := <-q.entries:
			if !ok {
				flush()
				return
			}
			batch = append(batch, entry)
			if len(batch) >= q.options.BatchSize && !flush() {
				return
			}
		case <-ticker.C:
			if !flush() {
				return
			}
		}
	}
}
