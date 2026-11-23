package main

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestActivityFailedReadUsesInternalRetryDelay(t *testing.T) {
	a, store := testApp(t)
	token, _ := bootstrapOwner(t, a)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusServiceUnavailable)
	}))
	defer upstream.Close()
	server := createManagedServer(t, a, token, "jellyfin", upstream.URL)
	activityExec(t, store, "UPDATE activity_monitor_schedules SET interval_seconds=3600, socket_enabled=1, next_run_at='2000-01-01T00:00:00Z' WHERE server_id=?", server)
	before := time.Now()
	if err := a.runOneActivityMonitor(t.Context()); err != nil {
		t.Fatal(err)
	}
	var code, next string
	if err := store.reader.QueryRow("SELECT last_code,next_run_at FROM activity_monitor_schedules WHERE server_id=?", server).Scan(&code, &next); err != nil {
		t.Fatal(err)
	}
	when, err := time.Parse(time.RFC3339Nano, next)
	if err != nil || code != "FAILED" || when.Before(before.Add(25*time.Second)) || when.After(time.Now().Add(35*time.Second)) {
		t.Fatalf("expected failed read retry in about 30 seconds, got code=%s next=%s error=%v", code, next, err)
	}
	activityExec(t, store, "UPDATE activity_monitor_schedules SET run_state='running', claim_token='expired', runner_id='test', lease_until='2000-01-01T00:00:00Z' WHERE server_id=?", server)
	before = time.Now()
	if _, err := a.claimActivityMonitor(t.Context()); err != nil {
		t.Fatal(err)
	}
	if err := store.reader.QueryRow("SELECT last_code,next_run_at FROM activity_monitor_schedules WHERE server_id=?", server).Scan(&code, &next); err != nil {
		t.Fatal(err)
	}
	when, err = time.Parse(time.RFC3339Nano, next)
	if err != nil || code != "INTERRUPTED" || when.Before(before.Add(25*time.Second)) || when.After(time.Now().Add(35*time.Second)) {
		t.Fatalf("expected interrupted read retry in about 30 seconds, got code=%s next=%s error=%v", code, next, err)
	}
}
