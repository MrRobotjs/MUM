package main

import (
	"database/sql"
	"fmt"
	"testing"
)

func TestAutomaticMonitoringReconcilesOnlySupportedSources(t *testing.T) {
	a, s := testApp(t)
	token, _ := bootstrapOwner(t, a)
	plex := createManagedServer(t, a, token, "plex", "http://example.invalid")
	tofa := createManagedServer(t, a, token, "tofa", "http://example.invalid")
	kavita := createManagedServer(t, a, token, "kavita", "http://example.invalid")
	configureTestMonitor(t, a, token, plex, false)
	if err := s.write(t.Context(), func(tx *sql.Tx) error { return reconcileAutomaticActivity(t.Context(), tx) }); err != nil {
		t.Fatal(err)
	}
	var enabled, sockets bool
	if err := s.reader.QueryRow("SELECT enabled,socket_enabled FROM activity_monitor_schedules WHERE server_id=?", plex).Scan(&enabled, &sockets); err != nil || !enabled || !sockets {
		t.Fatal(enabled, sockets, err)
	}
	if err := s.reader.QueryRow("SELECT enabled,socket_enabled FROM activity_monitor_schedules WHERE server_id=?", tofa).Scan(&enabled, &sockets); err != nil || !enabled || !sockets {
		t.Fatal("Tofa monitoring not enabled", enabled, sockets, err)
	}
	var count int
	if err := s.reader.QueryRow("SELECT count(*) FROM activity_monitor_schedules WHERE server_id=? AND enabled=1", kavita).Scan(&count); err != nil || count != 0 {
		t.Fatal(count, err)
	}
	var before, after int64
	if err := s.reader.QueryRow("SELECT revision FROM activity_monitor_schedules WHERE server_id=?", plex).Scan(&before); err != nil {
		t.Fatal(err)
	}
	if err := s.write(t.Context(), func(tx *sql.Tx) error { return reconcileAutomaticActivity(t.Context(), tx) }); err != nil {
		t.Fatal(err)
	}
	if err := s.reader.QueryRow("SELECT revision FROM activity_monitor_schedules WHERE server_id=?", plex).Scan(&after); err != nil || before != after {
		t.Fatal(before, after, err)
	}
}

func TestMonitoringIntervalDoesNotRequireConsent(t *testing.T) {
	a, _ := testApp(t)
	token, _ := bootstrapOwner(t, a)
	server := createManagedServer(t, a, token, "plex", "http://example.invalid")
	snapshot := monitorSnapshot(t, a, token)
	task := snapshot["tasks"].([]any)[0].(map[string]any)
	body := map[string]any{"expected_actor_uuid": snapshot["actor_uuid"], "revision": task["revision"], "server_revision": task["server_revision"], "interval_seconds": 60}
	w := apiRequest(a, "PUT", fmt.Sprintf("/api/settings/activity-monitoring/%d", server), token, body, nil)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
}

func TestAutomaticMonitoringInvalidatesChangedConfigurationClaim(t *testing.T) {
	a, s := testApp(t)
	token, _ := bootstrapOwner(t, a)
	server := createManagedServer(t, a, token, "plex", "http://example.invalid")
	activityExec(t, s, `UPDATE activity_monitor_schedules SET run_state='running',claim_token='stale',runner_id='fixture',lease_until='2099-01-01T00:00:00Z' WHERE server_id=?`, server)
	activityExec(t, s, `UPDATE media_activity_state SET pending_token='stale',pending_at='2026-01-01T00:00:00Z',pending_until='2099-01-01T00:00:00Z' WHERE server_id=?`, server)
	activityExec(t, s, `UPDATE media_servers SET url='http://changed.invalid' WHERE id=?`, server)
	if err := s.write(t.Context(), func(tx *sql.Tx) error { return reconcileAutomaticActivity(t.Context(), tx) }); err != nil {
		t.Fatal(err)
	}
	var state string
	var claim, pending sql.NullString
	var same bool
	err := s.reader.QueryRow(`SELECT q.run_state,q.claim_token,a.pending_token,q.configured_server_revision=s.config_revision FROM activity_monitor_schedules q JOIN media_activity_state a ON a.server_id=q.server_id JOIN media_servers s ON s.id=q.server_id WHERE q.server_id=?`, server).Scan(&state, &claim, &pending, &same)
	if err != nil || state != "cancelled" || claim.Valid || pending.Valid || !same {
		t.Fatal(state, claim, pending, same, err)
	}
}
