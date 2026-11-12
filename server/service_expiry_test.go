package main

import (
	"context"
	"errors"
	"testing"
	"time"
)

func serviceExpirySnapshot(t *testing.T, a *App, token, service string) map[string]any {
	t.Helper()
	w := apiRequest(a, "GET", "/api/service-accounts/"+service+"/expiry", token, nil, nil)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	return responseData(t, w)
}
func serviceExpiryBody(p map[string]any, after any) map[string]any {
	return map[string]any{"expected_actor_uuid": p["actor_uuid"], "expected_service_uuid": p["service_uuid"], "expiry_revision": p["expiry_revision"], "link_revision": p["link_revision"], "server_revision": p["server_revision"], "expected_is_active": p["is_active"], "expected_owner_uuid": p["owner_uuid"], "expected_access_expires_at": p["access_expires_at"], "access_expires_at": after, "acknowledge_local_only": true}
}

func TestServiceExpiryGuardedOwnerOnlyMutationAndRollback(t *testing.T) {
	f := activityReadFixture(t)
	a, s := f.app, f.store
	path := "/api/service-accounts/" + f.service + "/expiry"
	if w := apiRequest(a, "GET", path, f.token, nil, nil); w.Code != 403 {
		t.Fatal("delegated owner accessed policy", w.Code)
	}
	p := serviceExpirySnapshot(t, a, f.ownerToken, f.service)
	activityExec(t, s, "CREATE TRIGGER deny_service_expiry BEFORE INSERT ON audit_events WHEN NEW.action='service.expiry.change' BEGIN SELECT RAISE(ABORT,'fixture'); END")
	if w := apiRequest(a, "PUT", path, f.ownerToken, serviceExpiryBody(p, "2099-01-01T00:00:00Z"), nil); w.Code == 200 {
		t.Fatal("ignored audit failure")
	}
	if now := serviceExpirySnapshot(t, a, f.ownerToken, f.service); now["expiry_revision"] != p["expiry_revision"] || now["link_revision"] != p["link_revision"] || now["access_expires_at"] != nil {
		t.Fatal("partial expiry write", now)
	}
	activityExec(t, s, "DROP TRIGGER deny_service_expiry")
	w := apiRequest(a, "PUT", path, f.ownerToken, serviceExpiryBody(p, "2099-01-01T00:00:00Z"), nil)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	out := responseData(t, w)
	if out["owner_uuid"] != f.user || out["is_active"] != true || out["local_only"] != true {
		t.Fatal(out)
	}
	if _, err := s.Authenticate(t.Context(), f.token); err != nil {
		t.Fatal("human session revoked", err)
	}
	if w = apiRequest(a, "PUT", path, f.ownerToken, serviceExpiryBody(p, nil), nil); w.Code != 409 {
		t.Fatal("stale plan reused", w.Code)
	}
	var active int
	s.reader.QueryRow("SELECT is_active FROM service_accounts WHERE uuid=?", f.service).Scan(&active)
	if active != 1 {
		t.Fatal("remote activation mutated")
	}
}

func TestServiceExpiryDeadlineFencesCurrentButRetainsHistory(t *testing.T) {
	f := activityReadFixture(t)
	s := f.store
	owner, _ := s.Authenticate(t.Context(), f.ownerToken)
	expires := time.Now().Add(450 * time.Millisecond)
	activityExec(t, s, "UPDATE service_accounts SET access_expires_at=? WHERE uuid=?", utcTimestamp(expires), f.service)
	claim, err := s.beginActivityRead(t.Context(), owner.UUID, f.ownerToken, f.server)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.applyActivitySnapshot(t.Context(), claim, activityForUser(t, f.service)); err != nil {
		t.Fatal(err)
	}
	tx, err := s.beginActivityView(t.Context(), f.user, f.token, false)
	if err != nil {
		t.Fatal(err)
	}
	_, fences, err := readActivityStatuses(t.Context(), tx, f.user, activityReadQuery{}, time.Now())
	tx.Rollback()
	if err != nil {
		t.Fatal(err)
	}
	before, err := s.activitySignal(t.Context(), f.user, f.token, false)
	if err != nil {
		t.Fatal(err)
	}
	time.Sleep(time.Until(expires) + 25*time.Millisecond)
	if err = s.checkActivityDelivery(t.Context(), f.user, f.token, activityReadQuery{}, fences); !errors.Is(err, ErrConflict) {
		t.Fatal("deadline-crossing delivery escaped", err)
	}
	after, _ := s.activitySignal(t.Context(), f.user, f.token, false)
	if after == before {
		t.Fatal("deadline not invalidated")
	}
	for _, tc := range []struct {
		endpoint, token string
		count           int
	}{{"current", f.token, 0}, {"history", f.token, 1}, {"current?scope=all", f.ownerToken, 1}} {
		w := apiRequest(f.app, "GET", "/api/activity/"+tc.endpoint, tc.token, nil, nil)
		if w.Code != 200 || len(responseData(t, w)["items"].([]any)) != tc.count {
			t.Fatal(tc.endpoint, w.Code, w.Body.String())
		}
	}
	w := apiRequest(f.app, "GET", "/api/activity/summary", f.token, nil, nil)
	p := responseData(t, w)
	if p["recorded_observations"] != "1" || p["retained_current_observations"] != "0" {
		t.Fatal(p)
	}
}

func TestServiceExpiryOwnershipEpochAndPendingWork(t *testing.T) {
	f := activityReadFixture(t)
	p := serviceExpirySnapshot(t, f.app, f.ownerToken, f.service)
	path := "/api/service-accounts/" + f.service + "/expiry"
	activityExec(t, f.store, "UPDATE account_link_state SET revision=revision+1")
	if w := apiRequest(f.app, "PUT", path, f.ownerToken, serviceExpiryBody(p, "2099-01-01T00:00:00Z"), nil); w.Code != 409 {
		t.Fatal("stale ownership accepted", w.Code)
	}
	p = serviceExpirySnapshot(t, f.app, f.ownerToken, f.service)
	job := newUUID()
	now := utcTimestamp(time.Now())
	activityExec(t, f.store, "INSERT INTO provisioning_jobs(id,user_uuid,status,created_at,updated_at) VALUES(?,?,'pending',?,?)", job, f.user, now, now)
	activityExec(t, f.store, "INSERT INTO provisioning_steps(job_id,server_id,status) VALUES(?,?,'pending')", job, f.server)
	if w := apiRequest(f.app, "PUT", path, f.ownerToken, serviceExpiryBody(p, "2099-01-01T00:00:00Z"), nil); w.Code != 409 {
		t.Fatal("pending work bypassed", w.Code)
	}
}

// A failed invitation job blocks service changes on its server until it is
// reviewed; once cancelled (status stays 'failed') it no longer does. The
// user's Plex server stayed blocked by cancelled jobs before this fix.
func TestServicePendingWorkIgnoresCancelledJobs(t *testing.T) {
	f := activityReadFixture(t)
	job := newUUID()
	now := utcTimestamp(time.Now())
	activityExec(t, f.store, "INSERT INTO provisioning_jobs(id,user_uuid,status,created_at,updated_at) VALUES(?,?,'failed',?,?)", job, f.user, now, now)
	activityExec(t, f.store, "INSERT INTO provisioning_steps(job_id,server_id,status) VALUES(?,?,'failed')", job, f.server)
	pending := func() bool {
		t.Helper()
		tx, err := f.store.reader.BeginTx(t.Context(), nil)
		if err != nil {
			t.Fatal(err)
		}
		defer tx.Rollback()
		busy, err := servicePendingWork(t.Context(), tx, f.server)
		if err != nil {
			t.Fatal(err)
		}
		return busy
	}
	if !pending() {
		t.Fatal("failed job awaiting review did not block")
	}
	activityExec(t, f.store, "UPDATE provisioning_jobs SET resolution='cancelled',reservation_held=0 WHERE id=?", job)
	if pending() {
		t.Fatal("cancelled job still blocks the server")
	}
}

func TestServiceExpiryPrivateNoticeAndPreservedHumanAuthority(t *testing.T) {
	f := activityReadFixture(t)
	activityExec(t, f.store, "UPDATE service_accounts SET access_expires_at='2000-01-01T00:00:00Z' WHERE uuid=?", f.service)
	for range 2 {
		if err := f.app.reconcileServiceExpiry(t.Context()); err != nil {
			t.Fatal(err)
		}
	}
	if p := inboxSnapshot(t, f.app, f.ownerToken); p["total"] != float64(1) || p["notifications"].([]any)[0].(map[string]any)["notification_type"] != "SERVICE_EXPIRED" {
		t.Fatal(p)
	}
	if p := inboxSnapshot(t, f.app, f.token); p["total"] != float64(0) {
		t.Fatal("private service notice leaked")
	}
	if _, err := f.store.Authenticate(context.Background(), f.token); err != nil {
		t.Fatal("service expiry changed human access", err)
	}
	var count int
	f.store.reader.QueryRow("SELECT count(*) FROM service_links WHERE service_uuid=?", f.service).Scan(&count)
	if count != 1 {
		t.Fatal("owner link deleted")
	}
	var audits int
	f.store.reader.QueryRow("SELECT count(*) FROM audit_events WHERE action='service.expiry.reconcile'").Scan(&audits)
	if audits != 1 {
		t.Fatal("duplicate reconciliation", audits)
	}
	activityExec(t, f.store, "UPDATE service_accounts SET access_expires_at=NULL WHERE uuid=?", f.service)
	if err := f.app.reconcileServiceExpiry(t.Context()); err != nil {
		t.Fatal(err)
	}
	var resolved int
	f.store.reader.QueryRow("SELECT resolved FROM admin_notifications WHERE notification_type='SERVICE_EXPIRED'").Scan(&resolved)
	if resolved != 1 {
		t.Fatal("obsolete notice unresolved")
	}
	if w := apiRequest(f.app, "GET", "/api/users/"+f.service, f.ownerToken, nil, nil); w.Code != 200 || responseData(t, w)["access_expires_at"] != nil {
		t.Fatal(w.Code, w.Body.String())
	}
}
