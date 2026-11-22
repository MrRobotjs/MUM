package main

import (
	"context"
	"database/sql"
	"testing"
	"time"
)

func taskSnapshot(t *testing.T, a *App, token string) map[string]any {
	t.Helper()
	w := apiRequest(a, "GET", "/api/settings/scheduled-tasks", token, nil, nil)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	return responseData(t, w)
}
func TestScheduledSyncStopWhileWaitingForWriterIsNotCheckpointFailure(t *testing.T) {
	a, s := testApp(t)
	held, release, finished := make(chan struct{}), make(chan struct{}), make(chan error, 1)
	go func() {
		finished <- s.write(t.Context(), func(tx *sql.Tx) error { close(held); <-release; return nil })
	}()
	<-held
	before := s.writer.Stats().WaitCount
	if err := a.StartScheduler(); err != nil {
		close(release)
		t.Fatal(err)
	}
	deadline := time.Now().Add(time.Second)
	for s.writer.Stats().WaitCount == before && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	a.StopScheduler()
	close(release)
	if err := <-finished; err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	if err := a.WaitScheduler(ctx); err != nil {
		t.Fatal("expected cancellation reported as durability failure", err)
	}
}
