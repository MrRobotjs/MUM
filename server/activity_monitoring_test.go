package main

import (
	"context"
	"database/sql"
	"errors"
	"net/http"
	"net/http/httptest"
	"strconv"
	"sync/atomic"
	"testing"
	"time"
)

func monitorSnapshot(t *testing.T, a *App, token string) map[string]any {
	t.Helper()
	w := apiRequest(a, "GET", "/api/settings/activity-monitoring", token, nil, nil)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	return responseData(t, w)
}
func monitorChange(actor string, task map[string]any, enabled bool) map[string]any {
	return map[string]any{"expected_actor_uuid": actor, "revision": task["revision"], "server_revision": task["server_revision"], "enabled": enabled, "interval_seconds": 30, "acknowledge_complete_session_visibility": enabled}
}
func configureTestMonitor(t *testing.T, a *App, token string, server int64, enabled bool) {
	t.Helper()
	snapshot := monitorSnapshot(t, a, token)
	for _, entry := range snapshot["tasks"].([]any) {
		task := entry.(map[string]any)
		if task["server_id"] == strconv.FormatInt(server, 10) {
			w := apiRequest(a, "PUT", "/api/settings/activity-monitoring/"+task["server_id"].(string), token, monitorChange(snapshot["actor_uuid"].(string), task, enabled), nil)
			if w.Code != 200 {
				t.Fatal(w.Code, w.Body.String())
			}
			return
		}
	}
	t.Fatal("monitor missing")
}
func TestActivityMonitorDurableConsentAndObservationOutcomes(t *testing.T) {
	a, s := testApp(t)
	token, _ := bootstrapOwner(t, a)
	var payload atomic.Value
	payload.Store([]byte(`null`))
	var requests atomic.Int64
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/Sessions" || r.Header.Get("X-Emby-Token") != "fixture-secret" {
			t.Error("wrong polling request")
		}
		requests.Add(1)
		_, _ = w.Write(payload.Load().([]byte))
	}))
	defer upstream.Close()
	server := createManagedServer(t, a, token, "jellyfin", upstream.URL)
	service := seedService(t, s, server)
	initial := monitorSnapshot(t, a, token)
	task := initial["tasks"].([]any)[0].(map[string]any)
	if task["server_name"] == "" || task["provider"] != "jellyfin" || task["enabled"] != true || task["interval_seconds"] != float64(30) {
		t.Fatal(initial)
	}
	configureTestMonitor(t, a, token, server, false)
	if err := a.runOneActivityMonitor(t.Context()); err != nil || requests.Load() != 0 {
		t.Fatal("disabled poll ran", err)
	}
	configureTestMonitor(t, a, token, server, true)
	owner, _ := s.Authenticate(t.Context(), token)
	// Durable owner consent survives logout; no worker access token exists.
	activityExec(t, s, "DELETE FROM app_sessions WHERE user_uuid=?", owner.UUID)
	body := []byte(`[ {"Id":"session","UserId":"` + service + `","NowPlayingItem":{"Id":"movie","Name":"Private fixture","Type":"Movie"},"PlayState":{"IsPaused":false}} ]`)
	payload.Store(body)
	if err := a.runOneActivityMonitor(t.Context()); err != nil {
		t.Fatal(err)
	}
	var state, code string
	var current, history, attempts int
	check := func(expected string, curr, hist int) {
		t.Helper()
		if err := s.reader.QueryRow("SELECT run_state,last_code,attempts FROM activity_monitor_schedules WHERE server_id=?", server).Scan(&state, &code, &attempts); err != nil {
			t.Fatal(err)
		}
		s.reader.QueryRow("SELECT count(*) FROM media_activity_current").Scan(&current)
		s.reader.QueryRow("SELECT count(*) FROM media_activity_history").Scan(&history)
		if code != expected || current != curr || history != hist {
			t.Fatal(state, code, current, history)
		}
	}
	check("SUCCEEDED", 1, 1)
	if err := a.runOneActivityMonitor(t.Context()); err != nil || requests.Load() != 1 {
		t.Fatal("future attempt replayed", err)
	}
	activityExec(t, s, "UPDATE activity_monitor_schedules SET next_run_at='2000-01-01T00:00:00Z'")
	payload.Store([]byte(`null`))
	if err := a.runOneActivityMonitor(t.Context()); err != nil {
		t.Fatal(err)
	}
	check("FAILED", 1, 1)
	activityExec(t, s, "UPDATE activity_monitor_schedules SET next_run_at='2000-01-01T00:00:00Z'")
	payload.Store([]byte(`[]`))
	if err := a.runOneActivityMonitor(t.Context()); err != nil {
		t.Fatal(err)
	}
	check("SUCCEEDED", 0, 1)
	if attempts != 3 {
		t.Fatal(attempts)
	}
	// Interactive activity helpers still require a live session.
	if _, err := s.beginActivityRead(t.Context(), owner.UUID, token, server); !errors.Is(err, ErrForbidden) {
		t.Fatal(err)
	}
}
func TestActivityMonitorConfigurationGuards(t *testing.T) {
	for _, mode := range []string{"delegate", "actor", "revision", "server-revision", "visibility", "interval", "missing-enabled", "unknown", "inactive", "session"} {
		t.Run(mode, func(t *testing.T) {
			a, s, owner, delegate, user := roleReadFixture(t)
			id := seedServer(t, s)
			snapshot := monitorSnapshot(t, a, owner)
			task := snapshot["tasks"].([]any)[0].(map[string]any)
			body := monitorChange(snapshot["actor_uuid"].(string), task, true)
			token := owner
			want := 409
			switch mode {
			case "delegate":
				token = delegate
				body["expected_actor_uuid"] = user
				want = 403
			case "actor":
				body["expected_actor_uuid"] = user
				want = 403
			case "revision":
				body["revision"] = 999
			case "server-revision":
				body["server_revision"] = 999
			case "visibility":
				body["acknowledge_complete_session_visibility"] = false
				want = 400
			case "interval":
				body["interval_seconds"] = 1
				want = 400
			case "missing-enabled":
				delete(body, "enabled")
				want = 400
			case "unknown":
				body["token"] = "must-not-bind-worker"
				want = 400
			case "inactive":
				activityExec(t, s, "UPDATE media_servers SET is_active=0 WHERE id=?", id)
			case "session":
				activityExec(t, s, "DELETE FROM app_sessions WHERE user_uuid=?", body["expected_actor_uuid"])
				want = 401
			}
			w := apiRequest(a, "PUT", "/api/settings/activity-monitoring/"+strconv.FormatInt(id, 10), token, body, nil)
			if w.Code != want {
				t.Fatal(w.Code, w.Body.String())
			}
			var enabled bool
			var audits int
			s.reader.QueryRow("SELECT enabled FROM activity_monitor_schedules WHERE server_id=?", id).Scan(&enabled)
			s.reader.QueryRow("SELECT count(*) FROM audit_events WHERE action='activity.monitor.configure'").Scan(&audits)
			if enabled || audits != 0 {
				t.Fatal("failed configuration changed consent")
			}
		})
	}
}
func TestActivityMonitorSystemClaimFences(t *testing.T) {
	for _, mode := range []string{"disable", "server", "provider", "owner-expired", "mapping", "lease", "superseded", "rollback"} {
		t.Run(mode, func(t *testing.T) {
			a, s, token, _, _ := roleReadFixture(t)
			owner, _ := s.Authenticate(t.Context(), token)
			id := seedServer(t, s)
			service := seedService(t, s, id)
			configureTestMonitor(t, a, token, id, true)
			claim, err := a.claimActivityMonitor(t.Context())
			if err != nil || claim == nil {
				t.Fatal(err)
			}
			if next, err := a.claimActivityMonitor(t.Context()); err != nil || next != nil {
				t.Fatal("overlapping system claim", next, err)
			}
			snapshot := activityForUser(t, service)
			switch mode {
			case "disable":
				configureTestMonitor(t, a, token, id, false)
			case "server":
				activityExec(t, s, "UPDATE media_servers SET config_revision=config_revision+1 WHERE id=?", id)
			case "provider":
				activityExec(t, s, "UPDATE provider_settings SET enabled=0 WHERE provider_id='jellyfin'")
			case "owner-expired":
				activityExec(t, s, "UPDATE user_accounts SET access_expires_at='2000-01-01T00:00:00Z' WHERE uuid=?", owner.UUID)
			case "mapping":
				activityExec(t, s, "UPDATE service_accounts SET is_active=0 WHERE uuid=?", service)
			case "lease":
				activityExec(t, s, "UPDATE activity_monitor_schedules SET lease_until='2000-01-01T00:00:00Z'")
			case "superseded":
				if _, err := s.beginActivityRead(t.Context(), owner.UUID, token, id); err != nil {
					t.Fatal(err)
				}
			}
			if mode == "rollback" {
				abort := errors.New("rollback observation and checkpoint")
				err = s.write(t.Context(), func(tx *sql.Tx) error {
					if _, err := commitActivitySnapshot(t.Context(), tx, *claim, snapshot); err != nil {
						return err
					}
					return abort
				})
				if !errors.Is(err, abort) {
					t.Fatal(err)
				}
			} else if _, err := s.applyActivitySnapshot(t.Context(), *claim, snapshot); err == nil {
				t.Fatal("invalid system snapshot committed")
			}
			var histories, success int
			s.reader.QueryRow("SELECT count(*) FROM media_activity_history").Scan(&histories)
			s.reader.QueryRow("SELECT count(*) FROM audit_events WHERE action='activity.monitor.finish' AND json_extract(details,'$.code')='SUCCEEDED'").Scan(&success)
			if histories != 0 || success != 0 {
				t.Fatal("partial history/success checkpoint", histories, success)
			}
		})
	}
}
func TestActivityMonitorExpiredRecoveryAndConfigurationPin(t *testing.T) {
	a, s := testApp(t)
	token, _ := bootstrapOwner(t, a)
	id := seedServer(t, s)
	service := seedService(t, s, id)
	configureTestMonitor(t, a, token, id, true)
	claim, err := a.claimActivityMonitor(t.Context())
	if err != nil || claim == nil {
		t.Fatal(err)
	}
	activityExec(t, s, "UPDATE activity_monitor_schedules SET lease_until='2000-01-01T00:00:00Z'")
	if next, err := a.claimActivityMonitor(t.Context()); err != nil || next != nil {
		t.Fatal("expired read replayed", err)
	}
	var code string
	var pending *string
	s.reader.QueryRow("SELECT last_code FROM activity_monitor_schedules").Scan(&code)
	s.reader.QueryRow("SELECT pending_token FROM media_activity_state").Scan(&pending)
	if code != "INTERRUPTED" || pending != nil {
		t.Fatal(code, pending)
	}
	if _, err := s.applyActivitySnapshot(t.Context(), *claim, activityForUser(t, service)); err == nil {
		t.Fatal("expired claim applied")
	}
	activityExec(t, s, "UPDATE activity_monitor_schedules SET next_run_at='2000-01-01T00:00:00Z'")
	// Content revisions (sync/review/finalization) neither fence snapshots nor revoke consent.
	activityExec(t, s, "UPDATE media_servers SET revision=revision+1")
	if next, err := a.claimActivityMonitor(t.Context()); err != nil || next == nil {
		t.Fatal("content revision revoked consent", err)
	}
	activityExec(t, s, "UPDATE activity_monitor_schedules SET run_state='succeeded',claim_token=NULL,runner_id=NULL,lease_until=NULL,next_run_at='2000-01-01T00:00:00Z'")
	activityExec(t, s, "UPDATE media_activity_state SET pending_token=NULL,pending_at=NULL,pending_until=NULL")
	activityExec(t, s, "UPDATE media_servers SET url='http://changed.invalid'")
	if next, err := a.claimActivityMonitor(t.Context()); err != nil || next != nil {
		t.Fatal("changed server reused consent", err)
	}
	configureTestMonitor(t, a, token, id, true)
	if next, err := a.claimActivityMonitor(t.Context()); err != nil || next == nil {
		t.Fatal("renewed consent not admitted", err)
	}
}
func TestActivityMonitorTrackedShutdownAndCheckpointFailure(t *testing.T) {
	for _, mode := range []string{"cancel", "checkpoint"} {
		t.Run(mode, func(t *testing.T) {
			a, s := testApp(t)
			token, _ := bootstrapOwner(t, a)
			entered := make(chan struct{}, 1)
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if mode == "checkpoint" {
					_, _ = w.Write([]byte(`null`))
					return
				}
				entered <- struct{}{}
				<-r.Context().Done()
			}))
			defer upstream.Close()
			id := createManagedServer(t, a, token, "jellyfin", upstream.URL)
			configureTestMonitor(t, a, token, id, true)
			if mode == "checkpoint" {
				activityExec(t, s, `CREATE TRIGGER fail_monitor_cleanup BEFORE UPDATE ON activity_monitor_schedules WHEN NEW.last_code='FAILED' BEGIN SELECT RAISE(ABORT,'fixture checkpoint failure'); END`)
				if err := a.runOneActivityMonitor(t.Context()); err == nil {
					t.Fatal("checkpoint failure discarded")
				}
				return
			}
			if err := a.StartScheduler(); err != nil {
				t.Fatal(err)
			}
			select {
			case <-entered:
			case <-time.After(5 * time.Second):
				t.Fatal("monitor did not start")
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
			var pending *string
			s.reader.QueryRow("SELECT last_code FROM activity_monitor_schedules").Scan(&code)
			s.reader.QueryRow("SELECT pending_token FROM media_activity_state").Scan(&pending)
			if code != "CANCELLED" || pending != nil {
				t.Fatal(code, pending)
			}
		})
	}
}
