package main

import (
	"context"
	"database/sql"
	"net/http"
	"net/http/httptest"
	"strconv"
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
func taskConfig(actor string, task map[string]any, enabled bool, interval int) map[string]any {
	return map[string]any{"expected_actor_uuid": actor, "revision": task["revision"], "server_revision": task["server_revision"], "enabled": enabled, "interval_seconds": interval}
}
func enableTestSchedule(t *testing.T, a *App, token string, id int64) {
	t.Helper()
	snapshot := taskSnapshot(t, a, token)
	for _, row := range snapshot["tasks"].([]any) {
		task := row.(map[string]any)
		if int64(task["server_id"].(float64)) == id {
			w := apiRequest(a, "PUT", "/api/settings/scheduled-tasks/"+strconv.FormatInt(id, 10), token, taskConfig(snapshot["actor_uuid"].(string), task, true, 60), nil)
			if w.Code != 200 {
				t.Fatal(w.Code, w.Body.String())
			}
			return
		}
	}
	t.Fatal("task missing")
}
func TestScheduledSyncConfigurationAndSuccessfulCheckpoint(t *testing.T) {
	a, s := testApp(t)
	token, _ := bootstrapOwner(t, a)
	upstream, _ := providerFixture(t, "jellyfin")
	id := createManagedServer(t, a, token, "jellyfin", upstream.URL)
	initial := taskSnapshot(t, a, token)
	task := initial["tasks"].([]any)[0].(map[string]any)
	if task["enabled"] != false || task["state"] != "disabled" || initial["runtime_available"] != false {
		t.Fatal(initial)
	}
	enableTestSchedule(t, a, token, id)
	if err := a.runOneScheduledSync(t.Context()); err != nil {
		t.Fatal(err)
	}
	var state, code string
	var attempts int
	s.reader.QueryRow("SELECT run_state,last_code,attempts FROM server_sync_schedules WHERE server_id=?", id).Scan(&state, &code, &attempts)
	if state != "succeeded" || code != "SUCCEEDED" || attempts != 1 {
		t.Fatal(state, code, attempts)
	}
	var accounts, notices int
	s.reader.QueryRow("SELECT count(*) FROM service_accounts WHERE server_id=?", id).Scan(&accounts)
	s.reader.QueryRow("SELECT count(*) FROM admin_notifications WHERE server_id=? AND resolved=1", id).Scan(&notices)
	if accounts == 0 || notices != 1 {
		t.Fatal("success checkpoint lacked snapshot/notice outcome", accounts, notices)
	}
	if err := a.runOneScheduledSync(t.Context()); err != nil {
		t.Fatal(err)
	}
	s.reader.QueryRow("SELECT attempts FROM server_sync_schedules WHERE server_id=?", id).Scan(&attempts)
	if attempts != 1 {
		t.Fatal("future run replayed")
	}
}
func TestScheduledSyncRejectsInvalidConfigurationAndStaleAuthority(t *testing.T) {
	for _, mode := range []string{"delegate", "actor", "revision", "server", "interval", "unknown", "inactive", "session"} {
		t.Run(mode, func(t *testing.T) {
			a, s, owner, delegate, user := roleReadFixture(t)
			id := seedServer(t, s)
			s.writer.Exec("UPDATE provider_settings SET enabled=1 WHERE provider_id='jellyfin'")
			snapshot := taskSnapshot(t, a, owner)
			task := snapshot["tasks"].([]any)[0].(map[string]any)
			body := taskConfig(snapshot["actor_uuid"].(string), task, true, 60)
			access := owner
			want := 409
			switch mode {
			case "delegate":
				access = delegate
				body["expected_actor_uuid"] = user
				want = 403
			case "actor":
				body["expected_actor_uuid"] = user
				want = 403
			case "revision":
				body["revision"] = 999
			case "server":
				body["server_revision"] = 999
			case "interval":
				body["interval_seconds"] = 1
				want = 400
			case "unknown":
				body["run_command"] = "ignored"
				want = 400
			case "inactive":
				s.writer.Exec("UPDATE media_servers SET is_active=0 WHERE id=?", id)
			case "session":
				s.writer.Exec("DELETE FROM app_sessions WHERE user_uuid=?", snapshot["actor_uuid"])
				want = 401
			}
			w := apiRequest(a, "PUT", "/api/settings/scheduled-tasks/"+strconv.FormatInt(id, 10), access, body, nil)
			if w.Code != want {
				t.Fatal(mode, w.Code, w.Body.String())
			}
			var enabled bool
			s.reader.QueryRow("SELECT enabled FROM server_sync_schedules WHERE server_id=?", id).Scan(&enabled)
			if enabled {
				t.Fatal("invalid config persisted")
			}
		})
	}
}
func TestScheduledSyncLeaseRecoveryAndFencedCommit(t *testing.T) {
	a, s := testApp(t)
	token, _ := bootstrapOwner(t, a)
	upstream, _ := providerFixture(t, "jellyfin")
	id := createManagedServer(t, a, token, "jellyfin", upstream.URL)
	enableTestSchedule(t, a, token, id)
	claim, err := a.claimScheduledSync(t.Context())
	if err != nil || claim == nil {
		t.Fatal(err)
	}
	// Another runtime cannot claim a live lease.
	if second, err := a.claimScheduledSync(t.Context()); err != nil || second != nil {
		t.Fatal(second, err)
	}
	server, err := a.loadServer(t.Context(), id)
	if err != nil {
		t.Fatal(err)
	}
	s.writer.Exec("UPDATE server_sync_schedules SET lease_until='2000-01-01T00:00:00Z' WHERE server_id=?", id)
	if _, err := a.claimScheduledSync(t.Context()); err != nil {
		t.Fatal(err)
	}
	var code string
	s.reader.QueryRow("SELECT last_code FROM server_sync_schedules WHERE server_id=?", id).Scan(&code)
	if code != "INTERRUPTED" {
		t.Fatal(code)
	}
	if _, err := a.syncServerClaimed(t.Context(), claim.Actor, "", server, true, true, claim); err == nil {
		t.Fatal("expired claim committed snapshot")
	}
	var accounts int
	s.reader.QueryRow("SELECT count(*) FROM service_accounts WHERE server_id=?", id).Scan(&accounts)
	if accounts != 0 {
		t.Fatal("fenced snapshot persisted")
	}
}
func TestScheduledSyncCancellationOverlapAndShutdown(t *testing.T) {
	a, s := testApp(t)
	token, _ := bootstrapOwner(t, a)
	entered := make(chan struct{}, 1)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case entered <- struct{}{}:
		default:
		}
		<-r.Context().Done()
	}))
	defer upstream.Close()
	id := createManagedServer(t, a, token, "jellyfin", upstream.URL)
	enableTestSchedule(t, a, token, id)
	if err := a.StartScheduler(); err != nil {
		t.Fatal(err)
	}
	select {
	case <-entered:
	case <-time.After(5 * time.Second):
		t.Fatal("worker did not start")
	}
	if w := apiRequest(a, "POST", "/api/servers/"+strconv.FormatInt(id, 10)+"/sync", token, nil, nil); w.Code != 409 {
		t.Fatal("manual overlap admitted", w.Code)
	}
	a.StopScheduler()
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	if err := a.WaitScheduler(ctx); err != nil {
		t.Fatal(err)
	}
	var code string
	var running int
	s.reader.QueryRow("SELECT last_code,run_state='running' FROM server_sync_schedules WHERE server_id=?", id).Scan(&code, &running)
	if code != "CANCELLED" || running != 0 {
		t.Fatal(code, running)
	}
	if err := a.StartScheduler(); err == nil {
		t.Fatal("closed runtime restarted")
	}
}
func TestScheduledSyncConfigurationChangeRejectsFrozenClaim(t *testing.T) {
	a, s := testApp(t)
	token, _ := bootstrapOwner(t, a)
	upstream, _ := providerFixture(t, "jellyfin")
	id := createManagedServer(t, a, token, "jellyfin", upstream.URL)
	enableTestSchedule(t, a, token, id)
	claim, err := a.claimScheduledSync(t.Context())
	if err != nil || claim == nil {
		t.Fatal(err)
	}
	snapshot := taskSnapshot(t, a, token)
	task := snapshot["tasks"].([]any)[0].(map[string]any)
	w := apiRequest(a, "PUT", "/api/settings/scheduled-tasks/"+strconv.FormatInt(id, 10), token, taskConfig(snapshot["actor_uuid"].(string), task, false, 60), nil)
	if w.Code != 200 {
		t.Fatal(w.Code)
	}
	server, err := a.loadServer(t.Context(), id)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := a.syncServerClaimed(t.Context(), claim.Actor, "", server, true, true, claim); err == nil {
		t.Fatal("disabled config committed")
	}
	if err := s.write(t.Context(), func(tx *sql.Tx) error { return finishScheduledSync(t.Context(), tx, claim, "CANCELLED") }); err != nil {
		t.Fatal(err)
	}
	var enabled bool
	var next *string
	s.reader.QueryRow("SELECT enabled,next_run_at FROM server_sync_schedules WHERE server_id=?", id).Scan(&enabled, &next)
	if enabled || next != nil {
		t.Fatal("completion overwrote disabled config")
	}
}

func TestScheduledSyncFailureCannotCommitSuccessfulCheckpoint(t *testing.T) {
	a, s := testApp(t)
	token, _ := bootstrapOwner(t, a)
	upstream, _ := providerFixture(t, "jellyfin")
	id := createManagedServer(t, a, token, "jellyfin", upstream.URL)
	enableTestSchedule(t, a, token, id)
	if _, err := s.writer.Exec(`CREATE TRIGGER fail_sync_audit BEFORE INSERT ON audit_events WHEN NEW.action='server.sync' BEGIN SELECT RAISE(ABORT,'disposable audit failure'); END`); err != nil {
		t.Fatal(err)
	}
	if err := a.runOneScheduledSync(t.Context()); err != nil {
		t.Fatal(err)
	}
	var code string
	var accounts, resolved int
	s.reader.QueryRow("SELECT last_code FROM server_sync_schedules WHERE server_id=?", id).Scan(&code)
	s.reader.QueryRow("SELECT count(*) FROM service_accounts WHERE server_id=?", id).Scan(&accounts)
	s.reader.QueryRow("SELECT count(*) FROM admin_notifications WHERE server_id=? AND resolved=1", id).Scan(&resolved)
	if code != "FAILED" || accounts != 0 || resolved != 0 {
		t.Fatal("partial successful checkpoint survived rollback", code, accounts, resolved)
	}
}

func TestScheduledSyncPausedProviderDoesNotRun(t *testing.T) {
	a, s := testApp(t)
	token, _ := bootstrapOwner(t, a)
	upstream, _ := providerFixture(t, "jellyfin")
	id := createManagedServer(t, a, token, "jellyfin", upstream.URL)
	enableTestSchedule(t, a, token, id)
	s.writer.Exec("UPDATE provider_settings SET enabled=0 WHERE provider_id='jellyfin'")
	if err := a.runOneScheduledSync(t.Context()); err != nil {
		t.Fatal(err)
	}
	var attempts int
	s.reader.QueryRow("SELECT attempts FROM server_sync_schedules WHERE server_id=?", id).Scan(&attempts)
	if attempts != 0 {
		t.Fatal("disabled provider was contacted")
	}
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
