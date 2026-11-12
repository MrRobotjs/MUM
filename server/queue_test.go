package main

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type batchWriterFunc func(context.Context, []LogEntry) (int64, error)

func (f batchWriterFunc) WriteLogBatch(ctx context.Context, e []LogEntry) (int64, error) {
	return f(ctx, e)
}

func event(key string) LogEntry {
	return LogEntry{Source: "test", EventKey: key, Type: "update", Payload: []byte(`{"value":1}`)}
}

func TestQueueTimerThresholdAndDrain(t *testing.T) {
	for _, scenario := range []string{"timer", "threshold", "shutdown"} {
		t.Run(scenario, func(t *testing.T) {
			s := testStore(t)
			batches := make(chan int, 10)
			writer := batchWriterFunc(func(ctx context.Context, entries []LogEntry) (int64, error) {
				n, err := s.WriteLogBatch(ctx, entries)
				batches <- len(entries)
				return n, err
			})
			options := QueueOptions{FlushInterval: time.Hour}
			n := 7
			if scenario == "timer" {
				options.FlushInterval = 10 * time.Millisecond
			}
			if scenario == "threshold" {
				n = 500
			}
			q, err := NewLogQueue(writer, options)
			if err != nil {
				t.Fatal(err)
			}
			for i := range n {
				if err := q.Enqueue(event(fmt.Sprint(i))); err != nil {
					t.Fatal(err)
				}
			}
			if scenario != "shutdown" {
				select {
				case got := <-batches:
					if got != n {
						t.Fatal("batch", got, n)
					}
				case <-time.After(3 * time.Second):
					t.Fatal("flush did not run")
				}
			}
			if err := q.Shutdown(t.Context()); err != nil {
				t.Fatal(err)
			}
			if stats := q.Stats(); stats.Accepted != uint64(n) || stats.Inserted != uint64(n) || stats.Pending != 0 {
				t.Fatal(stats)
			}
			if err := q.Enqueue(event("late")); !errors.Is(err, ErrQueueClosed) {
				t.Fatal(err)
			}
		})
	}
}

func TestQueueOverloadAndBufferOwnership(t *testing.T) {
	started := make(chan struct{})
	release := make(chan struct{})
	var once sync.Once
	payloads := make(chan string, 3)
	writer := batchWriterFunc(func(ctx context.Context, b []LogEntry) (int64, error) {
		once.Do(func() { close(started) })
		<-release
		payloads <- string(b[0].Payload)
		return int64(len(b)), nil
	})
	q, err := NewLogQueue(writer, QueueOptions{Capacity: 1, BatchSize: 1})
	if err != nil {
		t.Fatal(err)
	}
	e := event("first")
	if err := q.Enqueue(e); err != nil {
		t.Fatal(err)
	}
	<-started
	e.Payload[9] = '9'
	if err := q.Enqueue(event("second")); err != nil {
		t.Fatal(err)
	}
	if err := q.Enqueue(event("overflow")); !errors.Is(err, ErrQueueFull) {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if err := q.Shutdown(ctx); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	close(release)
	if err := q.Shutdown(t.Context()); err != nil {
		t.Fatal(err)
	}
	if got := <-payloads; got != `{"value":1}` {
		t.Fatal("producer mutated accepted payload", got)
	}
	if stats := q.Stats(); stats.Accepted != 2 || stats.Rejected != 1 || stats.Processed != 2 {
		t.Fatal(stats)
	}
}

// A disk stall keeps the failed batch and every queued record, makes the
// stall visible, refuses new records once the buffer is full, and resumes on
// its own when writes succeed again (no restart, no loss, original order).
func TestQueueStallRecoversWithoutRestart(t *testing.T) {
	var stalled atomic.Bool
	var attempts atomic.Int64
	var mu sync.Mutex
	written := []string{}
	stalled.Store(true)
	writer := batchWriterFunc(func(ctx context.Context, b []LogEntry) (int64, error) {
		attempts.Add(1)
		if stalled.Load() {
			return 0, errors.New("disk unavailable")
		}
		mu.Lock()
		defer mu.Unlock()
		for _, e := range b {
			written = append(written, e.EventKey)
		}
		return int64(len(b)), nil
	})
	q, err := NewLogQueue(writer, QueueOptions{Capacity: 4, BatchSize: 1, RetryDelay: time.Millisecond, MaxRetryDelay: 5 * time.Millisecond})
	if err != nil {
		t.Fatal(err)
	}
	if err := q.Enqueue(event("e0")); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool { return q.Err() != nil })
	if !errors.Is(q.Err(), ErrQueueStalled) {
		t.Fatal("stall not reported", q.Err())
	}
	accepted := []string{"e0"}
	for i := 1; ; i++ {
		key := fmt.Sprintf("e%d", i)
		err := q.Enqueue(event(key))
		if errors.Is(err, ErrQueueFull) {
			break
		}
		if err != nil {
			t.Fatal("stalled queue refused with", err)
		}
		accepted = append(accepted, key)
		if i > 10 {
			t.Fatal("bounded buffer never filled")
		}
	}
	// Retries are paced: the stalled writer is not called in a tight loop.
	before := attempts.Load()
	time.Sleep(60 * time.Millisecond)
	if spins := attempts.Load() - before; spins > 20 {
		t.Fatal("stalled retries not backed off", spins)
	}
	stalled.Store(false)
	waitFor(t, func() bool { return q.Err() == nil && q.Stats().Pending == 0 })
	if err := q.Enqueue(event("after")); err != nil {
		t.Fatal("recovered queue refused new intake", err)
	}
	if err := q.Shutdown(t.Context()); err != nil {
		t.Fatal(err)
	}
	mu.Lock()
	defer mu.Unlock()
	want := append(accepted, "after")
	if fmt.Sprint(written) != fmt.Sprint(want) {
		t.Fatal("records lost, duplicated or reordered", written, want)
	}
}

// Shutdown during a stall drains if writes recover before the deadline, and
// otherwise stops retrying at the deadline and reports what was not written.
func TestQueueShutdownDuringStall(t *testing.T) {
	for _, recovers := range []bool{true, false} {
		t.Run(fmt.Sprint(recovers), func(t *testing.T) {
			var stalled atomic.Bool
			stalled.Store(true)
			var written atomic.Int64
			writer := batchWriterFunc(func(ctx context.Context, b []LogEntry) (int64, error) {
				if stalled.Load() {
					return 0, errors.New("disk unavailable")
				}
				written.Add(int64(len(b)))
				return int64(len(b)), nil
			})
			q, err := NewLogQueue(writer, QueueOptions{BatchSize: 1, RetryDelay: time.Millisecond, MaxRetryDelay: 2 * time.Millisecond})
			if err != nil {
				t.Fatal(err)
			}
			for _, key := range []string{"a", "b"} {
				if err := q.Enqueue(event(key)); err != nil {
					t.Fatal(err)
				}
			}
			if recovers {
				time.AfterFunc(20*time.Millisecond, func() { stalled.Store(false) })
			}
			ctx, cancel := context.WithTimeout(t.Context(), 300*time.Millisecond)
			defer cancel()
			err = q.Shutdown(ctx)
			if recovers {
				if err != nil || written.Load() != 2 || q.Stats().Pending != 0 {
					t.Fatal(err, written.Load(), q.Stats())
				}
				return
			}
			if !errors.Is(err, ErrQueueFailed) || q.Stats().Pending != 2 {
				t.Fatal("abandoned drain not reported", err, q.Stats())
			}
			// The worker has stopped: a later wait returns at once with the same error.
			done := make(chan error, 1)
			go func() { done <- q.Shutdown(context.Background()) }()
			select {
			case err := <-done:
				if !errors.Is(err, ErrQueueFailed) {
					t.Fatal(err)
				}
			case <-time.After(2 * time.Second):
				t.Fatal("shutdown hung on a permanent stall")
			}
			if !errors.Is(q.Enqueue(event("late")), ErrQueueFailed) {
				t.Fatal("abandoned queue accepted new records")
			}
		})
	}
}

func waitFor(t *testing.T, ok func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !ok() {
		if time.Now().After(deadline) {
			t.Fatal("condition not reached")
		}
		time.Sleep(time.Millisecond)
	}
}

func TestConcurrentIngestionAdminReadsAndShutdown(t *testing.T) {
	s := testStore(t)
	q, err := NewLogQueue(s, QueueOptions{})
	if err != nil {
		t.Fatal(err)
	}
	owner, err := s.CreateAccount(t.Context(), "", "owner", "encoded", true)
	if err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	start := time.Now()
	for producer := range 16 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := range 400 {
				for {
					err := q.Enqueue(event(fmt.Sprintf("%d/%d", producer, i)))
					if err == nil {
						break
					}
					if !errors.Is(err, ErrQueueFull) {
						t.Error(err)
						return
					}
					time.Sleep(time.Millisecond)
				}
			}
		}()
	}
	for admin := range 4 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := range 20 {
				if _, err := s.CreateAccount(t.Context(), owner, fmt.Sprintf("admin-op-%d-%d", admin, i), "encoded", false); err != nil {
					t.Error(err)
					return
				}
				var count int
				if err := s.reader.QueryRow("SELECT count(*) FROM log_entries").Scan(&count); err != nil {
					t.Error(err)
					return
				}
			}
		}()
	}
	wg.Wait()
	if err := q.Shutdown(t.Context()); err != nil {
		t.Fatal(err)
	}
	var count int
	if err := s.reader.QueryRow("SELECT count(*) FROM log_entries").Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 6400 {
		t.Fatal("lost events", count, q.Stats())
	}
	if err := s.CheckIntegrity(t.Context()); err != nil {
		t.Fatal(err)
	}
	t.Logf("6400 events, 80 admin writes + reads, 20 concurrent producers/actors: %s; stats=%+v", time.Since(start), q.Stats())
}

func TestConcurrentEnqueueShutdown(t *testing.T) {
	s := testStore(t)
	q, err := NewLogQueue(s, QueueOptions{})
	if err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	for producer := range 24 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := range 200 {
				err := q.Enqueue(event(fmt.Sprintf("%d/%d", producer, i)))
				if errors.Is(err, ErrQueueClosed) {
					return
				}
				if err != nil && !errors.Is(err, ErrQueueFull) {
					t.Error(err)
					return
				}
			}
		}()
	}
	if err := q.Shutdown(t.Context()); err != nil {
		t.Fatal(err)
	}
	wg.Wait()
	stats := q.Stats()
	if stats.Pending != 0 || stats.Processed != stats.Accepted || stats.Inserted != stats.Accepted {
		t.Fatal(stats)
	}
}
