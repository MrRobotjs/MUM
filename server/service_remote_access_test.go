package main

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"path/filepath"
	"slices"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

type remoteFixture struct {
	activityViewFixture
	path     string
	disabled atomic.Bool
	admin    atomic.Bool
	writes   atomic.Int64
	reads    atomic.Int64
	deletes  atomic.Int64
	deleted  atomic.Bool
	onDelete func(*http.Request) (*http.Response, error)
	onWrite  func(*http.Request) (*http.Response, error)
}

func jsonResponse(r *http.Request, status int, body string) *http.Response {
	return &http.Response{StatusCode: status, Header: http.Header{"Content-Type": {"application/json"}}, Body: io.NopCloser(strings.NewReader(body)), Request: r}
}

// A disposable Jellyfin transport for one recorded account; nothing leaves the process.
func newRemoteFixture(t *testing.T) *remoteFixture {
	t.Helper()
	f := &remoteFixture{activityViewFixture: activityReadFixture(t)}
	f.path = "/api/service-accounts/" + f.service + "/remote-access"
	activityExec(t, f.store, "UPDATE media_servers SET api_key='fixture-secret',url='http://jellyfin.fixture' WHERE id=?", f.server)
	activityExec(t, f.store, "UPDATE service_accounts SET external_username='Remote Name' WHERE uuid=?", f.service)
	f.app.ProviderHTTP = &http.Client{Transport: providerTransport(func(r *http.Request) (*http.Response, error) {
		if r.Header.Get("X-Emby-Token") != "fixture-secret" {
			t.Error("missing provider credentials")
		}
		switch {
		case r.Method == "GET" && r.URL.Path == "/System/Info":
			return jsonResponse(r, 200, `{"ServerName":"Fixture","Version":"10"}`), nil
		case r.Method == "GET" && r.URL.Path == "/Users/"+f.service:
			f.reads.Add(1)
			if f.deleted.Load() {
				return jsonResponse(r, 404, `{}`), nil
			}
			policy, _ := json.Marshal(map[string]any{"IsAdministrator": f.admin.Load(), "IsDisabled": f.disabled.Load(), "AuthenticationProviderId": "default", "PasswordResetProviderId": "default", "EnabledFolders": []string{"movies"}})
			return jsonResponse(r, 200, `{"Id":"`+f.service+`","Name":"Remote Name","Policy":`+string(policy)+`}`), nil
		case r.Method == "DELETE" && r.URL.Path == "/Users/"+f.service:
			f.deletes.Add(1)
			if f.onDelete != nil {
				return f.onDelete(r)
			}
			f.deleted.Store(true)
			return jsonResponse(r, 204, ``), nil
		case r.Method == "POST" && r.URL.Path == "/Users/"+f.service+"/Policy":
			f.writes.Add(1)
			if f.onWrite != nil {
				return f.onWrite(r)
			}
			var body map[string]any
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body["EnabledFolders"] == nil {
				t.Error("policy write did not preserve the observed policy", body, err)
			}
			disabled, ok := body["IsDisabled"].(bool)
			if !ok {
				t.Error("policy write omitted IsDisabled", body)
			}
			f.disabled.Store(disabled)
			return jsonResponse(r, 204, ``), nil
		}
		t.Error("unexpected provider request", r.Method, r.URL.Path)
		return jsonResponse(r, 404, `{}`), nil
	})}
	return f
}

func (f *remoteFixture) read(t *testing.T) map[string]any {
	t.Helper()
	w := apiRequest(f.app, "GET", f.path, f.ownerToken, nil, nil)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	if strings.Contains(w.Body.String(), "fixture-secret") || strings.Contains(w.Body.String(), "fingerprint") || strings.Contains(w.Body.String(), "operation_token") {
		t.Fatal("remote access record leaked private state", w.Body.String())
	}
	return responseData(t, w)
}
func remoteBody(p map[string]any) map[string]any {
	return map[string]any{"expected_actor_uuid": p["actor_uuid"], "expected_service_uuid": p["service_uuid"], "operation_revision": p["operation_revision"], "link_revision": p["link_revision"], "server_revision": p["server_revision"], "expected_is_active": p["is_active"], "expected_owner_uuid": p["owner_uuid"], "reason": "Access expired for this account", "acknowledge_remote_write": true, "acknowledge_in_flight_risk": true}
}
func (f *remoteFixture) disable(t *testing.T, p map[string]any) (int, map[string]any) {
	t.Helper()
	w := apiRequest(f.app, "POST", f.path+"/disable", f.ownerToken, remoteBody(p), nil)
	if w.Code != 200 {
		return w.Code, nil
	}
	return w.Code, responseData(t, w)
}
func (f *remoteFixture) column(t *testing.T, query string) any {
	t.Helper()
	var value any
	if err := f.store.reader.QueryRow(query, f.service).Scan(&value); err != nil {
		t.Fatal(err)
	}
	return value
}

func TestServiceRemoteDisableVerifiedOnceAndIdempotentObservation(t *testing.T) {
	f := newRemoteFixture(t)
	// The delegated administrator owns this account: visible, never actionable.
	if w := apiRequest(f.app, "GET", f.path, f.token, nil, nil); w.Code != 200 || responseData(t, w)["availability"] != "protected_self" || responseData(t, w)["can_disable"] != false {
		t.Fatal("delegated self revocation offered", w.Code, w.Body.String())
	}
	p := f.read(t)
	if p["availability"] != "available" || p["can_disable"] != true || p["cleanup_scope"] != "account" || p["state"] != "none" {
		t.Fatal(p)
	}
	before := f.column(t, "SELECT s.revision FROM media_servers s JOIN service_accounts a ON a.server_id=s.id WHERE a.uuid=?").(int64)
	for _, broken := range []func(map[string]any){
		func(b map[string]any) { b["acknowledge_remote_write"] = false },
		func(b map[string]any) { b["reason"] = "short" },
		func(b map[string]any) { delete(b, "expected_owner_uuid") },
	} {
		body := remoteBody(p)
		broken(body)
		if w := apiRequest(f.app, "POST", f.path+"/disable", f.ownerToken, body, nil); w.Code != 400 {
			t.Fatal("unconfirmed request accepted", w.Code)
		}
	}
	code, out := f.disable(t, p)
	if code != 200 || out["state"] != "disabled" || out["is_active"] != false || out["error_code"] != nil || f.writes.Load() != 1 {
		t.Fatal(code, out, f.writes.Load())
	}
	if after := f.column(t, "SELECT s.revision FROM media_servers s JOIN service_accounts a ON a.server_id=s.id WHERE a.uuid=?").(int64); after != before+1 {
		t.Fatal("stale syncs not invalidated", before, after)
	}
	if token := f.column(t, "SELECT operation_token FROM service_remote_access WHERE service_uuid=?"); token != nil {
		t.Fatal("lease retained")
	}
	if _, err := f.store.Authenticate(t.Context(), f.token); err != nil {
		t.Fatal("linked human session revoked", err)
	}
	if links := f.column(t, "SELECT count(*) FROM service_links WHERE service_uuid=?").(int64); links != 1 {
		t.Fatal("ownership changed")
	}
	if code, _ := f.disable(t, p); code != 409 {
		t.Fatal("stale plan reused", code)
	}
	// A fresh, explicit request inspects first and does not write again.
	code, out = f.disable(t, f.read(t))
	if code != 200 || out["state"] != "disabled" || f.writes.Load() != 1 {
		t.Fatal("already-disabled account rewritten", code, out, f.writes.Load())
	}
	var dispatched []bool
	rows, err := f.store.reader.Query("SELECT json_extract(details,'$.remote_write_dispatched') FROM audit_events WHERE action='service.remote_access.disable' ORDER BY id")
	if err != nil {
		t.Fatal(err)
	}
	for rows.Next() {
		var value bool
		rows.Scan(&value)
		dispatched = append(dispatched, value)
	}
	rows.Close()
	if len(dispatched) != 2 || !dispatched[0] || dispatched[1] {
		t.Fatal("audit outcomes", dispatched)
	}
}

func TestServiceRemoteDisableUncertainAndUnsupportedNeverRetry(t *testing.T) {
	for _, mode := range []string{"lost", "rejected", "admin", "unverified"} {
		t.Run(mode, func(t *testing.T) {
			f := newRemoteFixture(t)
			switch mode {
			case "lost":
				f.onWrite = func(*http.Request) (*http.Response, error) { return nil, errors.New("connection reset") }
			case "rejected":
				f.onWrite = func(r *http.Request) (*http.Response, error) { return jsonResponse(r, 500, `{}`), nil }
			case "admin":
				f.admin.Store(true)
			case "unverified":
				f.onWrite = func(r *http.Request) (*http.Response, error) { return jsonResponse(r, 204, ``), nil }
			}
			code, out := f.disable(t, f.read(t))
			want := map[string][2]string{"lost": {"unknown", "REMOTE_OUTCOME_UNCERTAIN"}, "rejected": {"unknown", "REMOTE_OUTCOME_UNCERTAIN"}, "admin": {"failed", "REMOTE_ACCOUNT_UNSUPPORTED"}, "unverified": {"failed", "REMOTE_DISABLE_NOT_VERIFIED"}}[mode]
			if code != 200 || out["state"] != want[0] || out["error_code"] != want[1] || out["is_active"] != true {
				t.Fatal(code, out)
			}
			if writes := map[string]int64{"lost": 1, "rejected": 1, "admin": 0, "unverified": 1}[mode]; f.writes.Load() != writes {
				t.Fatal("remote writes", f.writes.Load())
			}
		})
	}
}

func TestServiceRemoteDisableLeaseFollowsLiveOwnerSession(t *testing.T) {
	f := newRemoteFixture(t)
	owner, _ := f.store.Authenticate(t.Context(), f.ownerToken)
	f.onWrite = func(r *http.Request) (*http.Response, error) {
		// Logout while the request is in flight: no further request or local
		// outcome may be attributed to the revoked session.
		activityExec(t, f.store, "DELETE FROM app_sessions WHERE user_uuid=?", owner.UUID)
		f.disabled.Store(true)
		return jsonResponse(r, 204, ``), nil
	}
	p := f.read(t)
	w := apiRequest(f.app, "POST", f.path+"/disable", f.ownerToken, remoteBody(p), nil)
	if w.Code != 503 {
		t.Fatal("revoked session outcome reported as certain", w.Code, w.Body.String())
	}
	if state := f.column(t, "SELECT state||'/'||error_code FROM service_remote_access WHERE service_uuid=?"); state != "unknown/RECONCILIATION_REQUIRED" {
		t.Fatal(state)
	}
	if active := f.column(t, "SELECT is_active FROM service_accounts WHERE uuid=?").(int64); active != 1 {
		t.Fatal("unrecorded outcome changed local state")
	}
	// The transport rechecks the lease, so no verification read follows the logout.
	if f.reads.Load() != 1 || f.writes.Load() != 1 {
		t.Fatal("provider requests continued after session revocation", f.reads.Load(), f.writes.Load())
	}
}

func TestServiceRemoteDisablePendingWorkAndExpiryExclusion(t *testing.T) {
	f := newRemoteFixture(t)
	p := f.read(t)
	job := newUUID()
	now := utcTimestamp(time.Now())
	activityExec(t, f.store, "INSERT INTO provisioning_jobs(id,user_uuid,status,created_at,updated_at) VALUES(?,?,'pending',?,?)", job, f.user, now, now)
	activityExec(t, f.store, "INSERT INTO provisioning_steps(job_id,server_id,status) VALUES(?,?,'pending')", job, f.server)
	if code, _ := f.disable(t, p); code != 409 || f.writes.Load() != 0 {
		t.Fatal("pending provisioning bypassed", code)
	}
	if now := f.read(t); now["availability"] != "pending_work" || now["can_disable"] != false {
		t.Fatal(now)
	}
	activityExec(t, f.store, "DELETE FROM provisioning_steps")
	activityExec(t, f.store, "DELETE FROM provisioning_jobs")
	// A running remote operation blocks the local expiry editor on that server.
	owner, _ := f.store.Authenticate(t.Context(), f.ownerToken)
	activityExec(t, f.store, `UPDATE service_remote_access SET state='running',operation_token='lease',operation_kind='disable',actor_uuid=?,access_hash='x',role_revision=1,config_revision=1,link_revision=1,provider_fingerprint='x',external_user_id='x',operation_expires_at='2999-01-01T00:00:00Z' WHERE service_uuid=?`, owner.UUID, f.service)
	if e := serviceExpirySnapshot(t, f.app, f.ownerToken, f.service); e["availability"] != "pending_work" {
		t.Fatal("expiry editor ignored running remote operation", e)
	}
	if now := f.read(t); now["availability"] != "running" {
		t.Fatal(now)
	}
	if err := f.app.recoverProvisioning(context.Background()); err != nil {
		t.Fatal(err)
	}
	if state := f.column(t, "SELECT state||'/'||error_code||'/'||(operation_token IS NULL) FROM service_remote_access WHERE service_uuid=?"); state != "unknown/INTERRUPTED_RECONCILIATION_REQUIRED/1" {
		t.Fatal("restart did not resolve the interrupted lease", state)
	}
	if code, out := f.disable(t, f.read(t)); code != 200 || out["state"] != "disabled" || f.writes.Load() != 1 {
		t.Fatal("explicit inspection after interruption", code, out)
	}
}

func TestServiceRemoteAccessScopeAndUnsupportedProviders(t *testing.T) {
	for kind, scope := range map[string]string{"jellyfin": "account", "emby": "account", "kavita": "account", "audiobookshelf": "account", "romm": "account", "komga": "media", "plex": ""} {
		if serviceRemoteScope(kind) != scope {
			t.Fatal(kind)
		}
	}
	f := newRemoteFixture(t)
	activityExec(t, f.store, "UPDATE service_accounts SET external_username=NULL WHERE uuid=?", f.service)
	if p := f.read(t); p["availability"] != "identity_unknown" || p["can_disable"] != false {
		t.Fatal(p)
	}
	activityExec(t, f.store, "UPDATE service_accounts SET external_username='Remote Name' WHERE uuid=?", f.service)
	activityExec(t, f.store, "UPDATE media_servers SET is_active=0 WHERE id=?", f.server)
	if p := f.read(t); p["availability"] != "server_inactive" {
		t.Fatal(p)
	}
}

func TestProfileRemoteAccessPlanListsOnlyOwnedAccounts(t *testing.T) {
	f := newRemoteFixture(t)
	path := "/api/users/" + f.user + "/remote-access"
	if w := apiRequest(f.app, "GET", path, f.token, nil, nil); w.Code != 200 || responseData(t, w)["accounts"].([]any)[0].(map[string]any)["availability"] != "protected_self" {
		t.Fatal("delegated self plan not protected", w.Code, w.Body.String())
	}
	if w := apiRequest(f.app, "GET", "/api/users/"+newUUID()+"/remote-access", f.ownerToken, nil, nil); w.Code != 404 {
		t.Fatal("unknown profile", w.Code)
	}
	// A second owned account and an account owned by someone else.
	second := seedService(t, f.store, f.server)
	other := seedService(t, f.store, f.server)
	owner, _ := f.store.Authenticate(t.Context(), f.ownerToken)
	if err := f.store.LinkServiceAccounts(t.Context(), owner.UUID, f.user, []string{second}); err != nil {
		t.Fatal(err)
	}
	w := apiRequest(f.app, "GET", path, f.ownerToken, nil, nil)
	if w.Code != 200 || strings.Contains(w.Body.String(), "fixture-secret") || strings.Contains(w.Body.String(), "fingerprint") {
		t.Fatal(w.Code, w.Body.String())
	}
	plan := responseData(t, w)
	accounts := plan["accounts"].([]any)
	if plan["user_uuid"] != f.user || len(accounts) != 2 {
		t.Fatal(plan)
	}
	seen := map[string]bool{}
	for _, entry := range accounts {
		record := entry.(map[string]any)
		seen[record["service_uuid"].(string)] = true
		if record["owner_uuid"] != f.user || record["link_revision"] != plan["link_revision"] {
			t.Fatal("plan record not from one snapshot", record)
		}
	}
	if !seen[f.service] || !seen[second] || seen[other] {
		t.Fatal("plan included the wrong accounts", seen)
	}
	// The second account has no recorded remote name, so it is not offered.
	for _, entry := range accounts {
		if record := entry.(map[string]any); record["service_uuid"] == second && record["availability"] != "identity_unknown" {
			t.Fatal(record)
		}
	}
}

func TestProfileRemoteAccessPlanRefusesTruncation(t *testing.T) {
	f := newRemoteFixture(t)
	for range serviceRemotePlanLimit {
		service := seedService(t, f.store, f.server)
		activityExec(t, f.store, "INSERT INTO service_links(user_uuid,service_uuid,link_kind,created_at) VALUES(?,?,'owner',?)", f.user, service, utcTimestamp(time.Now()))
	}
	if w := apiRequest(f.app, "GET", "/api/users/"+f.user+"/remote-access", f.ownerToken, nil, nil); w.Code != 409 {
		t.Fatal("oversized plan silently truncated", w.Code)
	}
}

// moveService gives the fixture account a new primary owner while stopped.
func (f *remoteFixture) moveService(t *testing.T, owner string) {
	t.Helper()
	activityExec(t, f.store, "DELETE FROM service_links WHERE service_uuid=?", f.service)
	activityExec(t, f.store, "INSERT INTO service_links(user_uuid,service_uuid,link_kind,created_at) VALUES(?,?,'owner',?)", owner, f.service, utcTimestamp(time.Now()))
}
func (f *remoteFixture) member(t *testing.T, name string, role string) string {
	t.Helper()
	owner, _ := f.store.Authenticate(t.Context(), f.ownerToken)
	member, err := f.store.CreateAccount(t.Context(), owner.UUID, name, "fixture-hash", false)
	if err != nil {
		t.Fatal(err)
	}
	if role != "" {
		if err := f.store.AssignAdminRole(t.Context(), owner.UUID, member, role); err != nil {
			t.Fatal(err)
		}
	}
	return member
}

func TestServiceRemoteDisableDelegatedHierarchy(t *testing.T) {
	for _, tc := range []struct {
		name, role, availability string
		code                     int
	}{{"no-role", "", "available", 200}, {"cosmetic-lower", "low", "available", 200}, {"peer", "high", "", 403}, {"owner", "", "protected_owner", 200}, {"unowned", "", "owner_only", 200}} {
		t.Run(tc.name, func(t *testing.T) {
			f := newRemoteFixture(t)
			switch tc.name {
			case "owner":
				owner, _ := f.store.Authenticate(t.Context(), f.ownerToken)
				f.moveService(t, owner.UUID)
			case "unowned":
				activityExec(t, f.store, "DELETE FROM service_links WHERE service_uuid=?", f.service)
			default:
				f.moveService(t, f.member(t, "remote-"+tc.name, tc.role))
			}
			w := apiRequest(f.app, "GET", f.path, f.token, nil, nil)
			if w.Code != tc.code {
				t.Fatal(w.Code, w.Body.String())
			}
			if tc.code != 200 {
				if f.writes.Load() != 0 {
					t.Fatal("remote write")
				}
				return
			}
			p := responseData(t, w)
			if p["availability"] != tc.availability {
				t.Fatal(p)
			}
			body := apiRequest(f.app, "POST", f.path+"/disable", f.token, remoteBody(p), nil)
			if tc.availability != "available" {
				if body.Code != 409 || f.writes.Load() != 0 {
					t.Fatal("protected account revoked", body.Code)
				}
				return
			}
			if body.Code != 200 || responseData(t, body)["state"] != "disabled" || f.writes.Load() != 1 {
				t.Fatal(body.Code, body.Body.String())
			}
			var actor string
			f.store.reader.QueryRow("SELECT actor_uuid FROM audit_events WHERE action='service.remote_access.disable'").Scan(&actor)
			if actor != f.user {
				t.Fatal("audit actor", actor)
			}
		})
	}
}

func TestServiceRemoteDisableDelegatedLeaseFollowsGrantsAndOwnership(t *testing.T) {
	for _, mode := range []string{"role", "link"} {
		t.Run(mode, func(t *testing.T) {
			f := newRemoteFixture(t)
			member := f.member(t, "remote-target", "")
			f.moveService(t, member)
			other := seedService(t, f.store, f.server)
			f.onWrite = func(r *http.Request) (*http.Response, error) {
				if mode == "role" {
					// Revoking the delegate's grant mid-request ends the lease.
					activityExec(t, f.store, "DELETE FROM admin_privileges WHERE user_uuid=?", f.user)
				} else {
					// Any ownership change also ends it.
					activityExec(t, f.store, "INSERT INTO service_links(user_uuid,service_uuid,link_kind,created_at) VALUES(?,?,'owner',?)", member, other, utcTimestamp(time.Now()))
				}
				f.disabled.Store(true)
				return jsonResponse(r, 204, ``), nil
			}
			w := apiRequest(f.app, "GET", f.path, f.token, nil, nil)
			if w.Code != 200 {
				t.Fatal(w.Code, w.Body.String())
			}
			if body := apiRequest(f.app, "POST", f.path+"/disable", f.token, remoteBody(responseData(t, w)), nil); body.Code != 503 {
				t.Fatal("outcome recorded after authority changed", body.Code, body.Body.String())
			}
			if f.reads.Load() != 1 || f.writes.Load() != 1 {
				t.Fatal("requests continued after authority changed", f.reads.Load(), f.writes.Load())
			}
			if active := f.column(t, "SELECT is_active FROM service_accounts WHERE uuid=?").(int64); active != 1 {
				t.Fatal("unrecorded outcome changed local state")
			}
		})
	}
}

func TestProfileRemoteAccessPlanDelegatedHierarchy(t *testing.T) {
	f := newRemoteFixture(t)
	peer := f.member(t, "remote-peer", "high")
	lower := f.member(t, "remote-lower", "low")
	f.moveService(t, lower)
	if w := apiRequest(f.app, "GET", "/api/users/"+peer+"/remote-access", f.token, nil, nil); w.Code != 403 {
		t.Fatal("peer plan disclosed", w.Code)
	}
	w := apiRequest(f.app, "GET", "/api/users/"+lower+"/remote-access", f.token, nil, nil)
	if w.Code != 200 || responseData(t, w)["accounts"].([]any)[0].(map[string]any)["availability"] != "available" {
		t.Fatal(w.Code, w.Body.String())
	}
	owner, _ := f.store.Authenticate(t.Context(), f.ownerToken)
	f.moveService(t, owner.UUID)
	w = apiRequest(f.app, "GET", "/api/users/"+owner.UUID+"/remote-access", f.token, nil, nil)
	if w.Code != 200 || responseData(t, w)["accounts"].([]any)[0].(map[string]any)["availability"] != "protected_owner" {
		t.Fatal(w.Code, w.Body.String())
	}
}

func (f *remoteFixture) enable(t *testing.T, p map[string]any) (int, map[string]any) {
	t.Helper()
	w := apiRequest(f.app, "POST", f.path+"/enable", f.ownerToken, remoteBody(p), nil)
	if w.Code != 200 {
		return w.Code, nil
	}
	return w.Code, responseData(t, w)
}

func TestServiceRemoteEnableVerifiedOnceAndPolicyGates(t *testing.T) {
	f := newRemoteFixture(t)
	f.moveService(t, f.member(t, "remote-enable-target", ""))
	f.disabled.Store(true)
	activityExec(t, f.store, "UPDATE service_accounts SET is_active=0 WHERE uuid=?", f.service)
	p := f.read(t)
	if p["can_enable"] != true || p["enable_availability"] != "available" {
		t.Fatal(p)
	}
	code, out := f.enable(t, p)
	if code != 200 || out["state"] != "enabled" || out["is_active"] != true || f.writes.Load() != 1 || f.disabled.Load() {
		t.Fatal(code, out, f.writes.Load())
	}
	// Already enabled: inspect only.
	if code, out = f.enable(t, f.read(t)); code != 200 || out["state"] != "enabled" || f.writes.Load() != 1 {
		t.Fatal("already-enabled account rewritten", code, out)
	}
	var actions []string
	rows, err := f.store.reader.Query("SELECT json_extract(details,'$.outcome')||'/'||json_extract(details,'$.remote_write_dispatched') FROM audit_events WHERE action='service.remote_access.enable' ORDER BY id")
	if err != nil {
		t.Fatal(err)
	}
	for rows.Next() {
		var value string
		rows.Scan(&value)
		actions = append(actions, value)
	}
	rows.Close()
	if !slices.Equal(actions, []string{"enabled/1", "enabled/0"}) {
		t.Fatal(actions)
	}
	// Local policy blocks re-enabling: an elapsed service expiry or an inactive owner.
	activityExec(t, f.store, "UPDATE service_accounts SET access_expires_at='2000-01-01T00:00:00Z' WHERE uuid=?", f.service)
	if p = f.read(t); p["enable_availability"] != "service_expired" || p["can_enable"] != false || p["can_disable"] != true {
		t.Fatal(p)
	}
	if code, _ := f.enable(t, p); code != 409 {
		t.Fatal("expired account re-enabled", code)
	}
	activityExec(t, f.store, "UPDATE service_accounts SET access_expires_at=NULL WHERE uuid=?", f.service)
	activityExec(t, f.store, "UPDATE user_accounts SET is_active=0 WHERE uuid=(SELECT user_uuid FROM service_links WHERE service_uuid=? AND link_kind='owner')", f.service)
	if p = f.read(t); p["enable_availability"] != "owner_inactive" || p["can_enable"] != false {
		t.Fatal(p)
	}
	if f.writes.Load() != 1 {
		t.Fatal("blocked enable wrote remotely")
	}
}

func TestServiceRemoteEnableUncertainAndUnsupported(t *testing.T) {
	f := newRemoteFixture(t)
	f.moveService(t, f.member(t, "remote-enable-lost", ""))
	f.disabled.Store(true)
	f.onWrite = func(*http.Request) (*http.Response, error) { return nil, errors.New("connection reset") }
	code, out := f.enable(t, f.read(t))
	if code != 200 || out["state"] != "unknown" || out["error_code"] != "REMOTE_OUTCOME_UNCERTAIN" || f.writes.Load() != 1 {
		t.Fatal(code, out)
	}
	if active := f.column(t, "SELECT is_active FROM service_accounts WHERE uuid=?").(int64); active != 1 {
		t.Fatal("uncertain enable changed local state")
	}
	// Komga removed media access instead of disabling; enabling would invent a grant.
	activityExec(t, f.store, "UPDATE provider_settings SET enabled=1 WHERE provider_id='komga'")
	activityExec(t, f.store, "UPDATE media_servers SET service_type='komga' WHERE id=?", f.server)
	activityExec(t, f.store, "UPDATE service_accounts SET external_username='reader@example.invalid' WHERE uuid=?", f.service)
	if p := f.read(t); p["cleanup_scope"] != "media" || p["enable_availability"] != "unsupported" || p["can_enable"] != false {
		t.Fatal(p)
	}
	if err := (&jsonProvider{config: ProviderConfig{Type: "komga"}}).enableRecordedUser(t.Context(), remoteReview{}); !errors.Is(err, ErrConflict) {
		t.Fatal("komga enable accepted", err)
	}
}

func TestRecordedEnableAdaptersPreserveAccess(t *testing.T) {
	t.Run("kavita", func(t *testing.T) {
		for _, mode := range []string{"", "ignored_enable"} {
			f := newKavitaProvisionFixture(t, mode)
			f.confirmed, f.name, f.roles, f.libraries = true, "Reader", []string{"Pleb", "Change Password"}, []int64{2}
			provider, err := newMediaProvider(ProviderConfig{"kavita", f.server.URL, "fixture-secret"}, f.server.Client())
			if err != nil {
				t.Fatal(err)
			}
			p := provider.(*jsonProvider)
			user, err := p.inspectProvisionedUser(t.Context(), "17", "Reader")
			if err != nil || !user.Disabled {
				t.Fatal(user, err)
			}
			err = p.enableRecordedUser(t.Context(), user)
			if mode == "ignored_enable" {
				if !errors.Is(err, ErrConflict) {
					t.Fatal("ignored enable verified", err)
				}
				continue
			}
			after, inspectErr := p.inspectProvisionedUser(t.Context(), "17", "Reader")
			if err != nil || inspectErr != nil || after.Disabled || !slices.Contains(after.Kavita.Roles, "Change Password") || !slices.Equal(after.Kavita.Libraries, []int64{2}) {
				t.Fatal(err, inspectErr, after.Kavita)
			}
		}
	})
	t.Run("audiobookshelf", func(t *testing.T) {
		f := newABSProvisionFixture(t, "")
		f.created, f.name, f.active = true, "Reader", false
		f.permissions = map[string]bool{"download": true, "update": false, "delete": false, "upload": false, "createEreader": false, "accessAllLibraries": false, "accessAllTags": true, "accessExplicitContent": false, "selectedTagsNotAccessible": false}
		f.libraries, f.tags = []string{"lib-b", "lib-a"}, []string{}
		provider, err := newMediaProvider(ProviderConfig{"audiobookshelf", f.server.URL + "/proxy", "fixture-secret"}, f.server.Client())
		if err != nil {
			t.Fatal(err)
		}
		p := provider.(*jsonProvider)
		user, err := p.inspectProvisionedUser(t.Context(), "abs-user", "Reader")
		if err != nil || !user.Disabled {
			t.Fatal(user, err)
		}
		if err := p.enableRecordedUser(t.Context(), user); err != nil || !f.active || f.patches != 1 || !f.permissions["download"] || len(f.libraries) != 2 {
			t.Fatal(err, f.active, f.patches)
		}
	})
	t.Run("romm", func(t *testing.T) {
		f := newRomMProvisionFixture(t, "")
		f.created, f.enabled = true, false
		p := rommTestProvider(t, f)
		user, err := p.inspectProvisionedUser(t.Context(), "2", "reader")
		if err != nil || !user.Disabled {
			t.Fatal(user, err)
		}
		if err := p.enableRecordedUser(t.Context(), user); err != nil || !f.enabled {
			t.Fatal(err)
		}
		after, err := p.inspectProvisionedUser(t.Context(), "2", "reader")
		if err != nil || after.Disabled || !rommContentEqual(after.RomM, user.RomM) {
			t.Fatal(err)
		}
	})
}

// openSchemaBefore applies the embedded migrations that sort before prefix to a
// raw database, as an earlier executable would have left it.
func openSchemaBefore(t *testing.T, prefix string) (string, *sql.DB) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "mum.db")
	db, err := sql.Open("sqlite", sqliteDSN(path, false))
	if err != nil {
		t.Fatal(err)
	}
	db.SetMaxOpenConns(1)
	for _, statement := range []string{"PRAGMA foreign_keys=ON", "CREATE TABLE schema_migrations (version TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)"} {
		if _, err = db.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	files, err := migrationFiles.ReadDir("go_migrations")
	if err != nil {
		t.Fatal(err)
	}
	for _, file := range files {
		if file.Name() >= prefix {
			break
		}
		body, err := migrationFiles.ReadFile("go_migrations/" + file.Name())
		if err != nil {
			t.Fatal(err)
		}
		if _, err = db.Exec(string(body)); err != nil {
			t.Fatal(file.Name(), err)
		}
		if _, err = db.Exec("INSERT INTO schema_migrations VALUES(?,?,?)", file.Name(), fmt.Sprintf("%x", sha256.Sum256(body)), utcTimestamp(time.Now())); err != nil {
			t.Fatal(err)
		}
	}
	return path, db
}

func TestServiceRemoteEnableMigrationKeepsOutcomesAndResolvesLeases(t *testing.T) {
	path, db := openSchemaBefore(t, "047")
	now := utcTimestamp(time.Now())
	for _, statement := range []string{
		"INSERT INTO identities(uuid,kind) VALUES('11111111-1111-1111-1111-111111111111','owner')",
		"INSERT INTO user_accounts(uuid,kind,local_username,created_at,updated_at) VALUES('11111111-1111-1111-1111-111111111111','owner','owner','" + now + "','" + now + "')",
		"INSERT INTO media_servers(id,server_nickname,service_type,url) VALUES(1,'fixture','jellyfin','http://fixture.invalid')",
		"INSERT INTO identities(uuid,kind) VALUES('22222222-2222-2222-2222-222222222222','service'),('33333333-3333-3333-3333-333333333333','service')",
		"INSERT INTO service_accounts(uuid,server_id,external_user_id,created_at,updated_at) VALUES('22222222-2222-2222-2222-222222222222',1,'done','" + now + "','" + now + "'),('33333333-3333-3333-3333-333333333333',1,'lease','" + now + "','" + now + "')",
		"UPDATE service_remote_access SET state='disabled',checked_at='" + now + "',revision=3 WHERE service_uuid='22222222-2222-2222-2222-222222222222'",
		"UPDATE service_remote_access SET state='running',operation_token='lease',actor_uuid='11111111-1111-1111-1111-111111111111',access_hash='x',role_revision=1,config_revision=1,link_revision=1,provider_fingerprint='x',external_user_id='lease',operation_expires_at='2999-01-01T00:00:00Z',revision=5 WHERE service_uuid='33333333-3333-3333-3333-333333333333'",
	} {
		if _, err := db.Exec(statement); err != nil {
			t.Fatal(statement, err)
		}
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	s, err := OpenStore(t.Context(), path)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	read := func(service string) string {
		var value string
		if err := s.reader.QueryRow("SELECT state||'/'||coalesce(error_code,'')||'/'||revision||'/'||(operation_token IS NULL)||'/'||(operation_kind IS NULL) FROM service_remote_access WHERE service_uuid=?", service).Scan(&value); err != nil {
			t.Fatal(err)
		}
		return value
	}
	if got := read("22222222-2222-2222-2222-222222222222"); got != "disabled//3/1/1" {
		t.Fatal("completed outcome changed", got)
	}
	if got := read("33333333-3333-3333-3333-333333333333"); got != "unknown/INTERRUPTED_RECONCILIATION_REQUIRED/6/1/1" {
		t.Fatal("pre-migration lease survived as live", got)
	}
	// The recreated insert trigger still seeds rows, and a lease without a kind is refused.
	if _, err := s.writer.Exec("INSERT INTO identities(uuid,kind) VALUES('44444444-4444-4444-4444-444444444444','service')"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.writer.Exec("INSERT INTO service_accounts(uuid,server_id,external_user_id,created_at,updated_at) VALUES('44444444-4444-4444-4444-444444444444',1,'new',?,?)", now, now); err != nil {
		t.Fatal(err)
	}
	if got := read("44444444-4444-4444-4444-444444444444"); got != "none//1/1/1" {
		t.Fatal("insert trigger lost", got)
	}
	if _, err := s.writer.Exec("UPDATE service_remote_access SET state='running',operation_token='t',actor_uuid='11111111-1111-1111-1111-111111111111',access_hash='x',role_revision=1,config_revision=1,link_revision=1,provider_fingerprint='x',external_user_id='new',operation_expires_at='2999-01-01T00:00:00Z' WHERE service_uuid='44444444-4444-4444-4444-444444444444'"); err == nil {
		t.Fatal("lease without operation kind accepted")
	}
	if err := s.CheckIntegrity(t.Context()); err != nil {
		t.Fatal(err)
	}
}

func (f *remoteFixture) remove(t *testing.T, p map[string]any, name string) (int, map[string]any) {
	t.Helper()
	body := remoteBody(p)
	body["confirm_username"] = name
	body["acknowledge_irreversible"] = true
	w := apiRequest(f.app, "POST", f.path+"/delete", f.ownerToken, body, nil)
	if w.Code != 200 {
		return w.Code, nil
	}
	return w.Code, responseData(t, w)
}
func (f *remoteFixture) disabledByMUM(t *testing.T) map[string]any {
	t.Helper()
	if code, out := f.disable(t, f.read(t)); code != 200 || out["state"] != "disabled" {
		t.Fatal("setup disable", code, out)
	}
	return f.read(t)
}

func TestServiceRemoteDeleteRequiresVerifiedDisableAndTypedConfirmation(t *testing.T) {
	f := newRemoteFixture(t)
	if p := f.read(t); p["delete_availability"] != "disable_first" || p["can_delete"] != false {
		t.Fatal("delete offered before a verified disable", p)
	}
	p := f.disabledByMUM(t)
	if p["delete_availability"] != "available" || p["can_delete"] != true {
		t.Fatal(p)
	}
	// Confirmation fields belong only to delete; delete requires both.
	for _, body := range []map[string]any{{"confirm_username": "Remote Name"}, {"acknowledge_irreversible": true}} {
		b := remoteBody(p)
		for k, v := range body {
			b[k] = v
		}
		if w := apiRequest(f.app, "POST", f.path+"/delete", f.ownerToken, b, nil); w.Code != 400 {
			t.Fatal("partial delete confirmation accepted", w.Code)
		}
		if w := apiRequest(f.app, "POST", f.path+"/disable", f.ownerToken, b, nil); w.Code != 400 {
			t.Fatal("delete confirmation accepted on disable", w.Code)
		}
	}
	if code, _ := f.remove(t, p, "remote name"); code != 409 || f.deletes.Load() != 0 {
		t.Fatal("inexact username accepted", code)
	}
	code, out := f.remove(t, p, "Remote Name")
	if code != 200 || out["state"] != "deleted" || out["is_active"] != false || f.deletes.Load() != 1 {
		t.Fatal(code, out, f.deletes.Load())
	}
	// MUM keeps the identity, ownership link and history; nothing is deleted locally.
	if count := f.column(t, "SELECT count(*) FROM service_links WHERE service_uuid=?").(int64); count != 1 {
		t.Fatal("ownership removed")
	}
	if count := f.column(t, "SELECT count(*) FROM media_activity_history WHERE service_uuid=?").(int64); count == 0 {
		t.Fatal("history removed")
	}
	if p = f.read(t); p["delete_availability"] != "disable_first" {
		t.Fatal("deleted account offered again", p)
	}
	var details string
	f.store.reader.QueryRow("SELECT details FROM audit_events WHERE action='service.remote_access.delete'").Scan(&details)
	if !strings.Contains(details, `"outcome":"deleted"`) || strings.Contains(details, "fixture-secret") {
		t.Fatal(details)
	}
}

func TestServiceRemoteDeleteRefusesRemoteChangesAndNeverReplays(t *testing.T) {
	for _, mode := range []string{"reenabled", "lost", "unverified", "delegated"} {
		t.Run(mode, func(t *testing.T) {
			f := newRemoteFixture(t)
			if mode == "delegated" {
				f.moveService(t, f.member(t, "remote-delete-target", ""))
			}
			p := f.disabledByMUM(t)
			switch mode {
			case "reenabled":
				f.disabled.Store(false)
			case "lost":
				f.onDelete = func(*http.Request) (*http.Response, error) {
					f.deleted.Store(true)
					return nil, errors.New("connection reset")
				}
			case "unverified":
				f.onDelete = func(r *http.Request) (*http.Response, error) { return jsonResponse(r, 204, ``), nil }
			case "delegated":
				w := apiRequest(f.app, "GET", f.path, f.token, nil, nil)
				d := responseData(t, w)
				if d["can_disable"] != true || d["delete_availability"] != "owner_only" || d["can_delete"] != false {
					t.Fatal(d)
				}
				body := remoteBody(d)
				body["confirm_username"], body["acknowledge_irreversible"] = "Remote Name", true
				if w := apiRequest(f.app, "POST", f.path+"/delete", f.token, body, nil); w.Code != 409 || f.deletes.Load() != 0 {
					t.Fatal("delegated delete", w.Code)
				}
				return
			}
			code, out := f.remove(t, p, "Remote Name")
			want := map[string][3]any{"reenabled": {"failed", "REMOTE_NOT_DISABLED", int64(0)}, "lost": {"unknown", "REMOTE_OUTCOME_UNCERTAIN", int64(1)}, "unverified": {"failed", "REMOTE_DELETE_NOT_VERIFIED", int64(1)}}[mode]
			if code != 200 || out["state"] != want[0] || out["error_code"] != want[1] || f.deletes.Load() != want[2] {
				t.Fatal(code, out, f.deletes.Load())
			}
			if mode == "lost" {
				// Recovery is an explicit inspection, never a replayed DELETE.
				if p = f.read(t); p["delete_availability"] != "disable_first" {
					t.Fatal(p)
				}
				if code, out = f.disable(t, p); code != 200 || out["state"] != "absent" || f.deletes.Load() != 1 {
					t.Fatal("lost delete not reconciled by inspection", code, out)
				}
			}
		})
	}
}

func TestRecordedDeleteAdaptersUseRecordedIDs(t *testing.T) {
	for kind, want := range map[string]string{"jellyfin": "/Users/abc-1", "emby": "/emby/Users/abc-1", "audiobookshelf": "/api/users/abc-1", "komga": "/api/v2/users/abc-1", "romm": "/api/users/7"} {
		var got string
		client := &http.Client{Transport: providerTransport(func(r *http.Request) (*http.Response, error) {
			got = r.Method + " " + r.URL.Path
			return jsonResponse(r, 204, ``), nil
		})}
		provider, err := newMediaProvider(ProviderConfig{kind, "http://fixture.invalid", "fixture-secret"}, client)
		if err != nil {
			t.Fatal(err)
		}
		id := "abc-1"
		if kind == "romm" {
			id = "7"
		}
		p := provider.(*jsonProvider)
		if err := p.deleteRecordedUser(t.Context(), remoteReview{ID: id, Disabled: true}); err != nil || got != "DELETE "+want {
			t.Fatal(kind, got, err)
		}
		if err := p.deleteRecordedUser(t.Context(), remoteReview{ID: id}); !errors.Is(err, ErrConflict) {
			t.Fatal(kind, "deleted an account not observed disabled")
		}
	}
	for _, kind := range []string{"kavita", "plex"} {
		if serviceRemoteDeletable(kind) || (&jsonProvider{config: ProviderConfig{Type: kind}}).deleteRecordedUser(t.Context(), remoteReview{ID: "1", Disabled: true}) == nil {
			t.Fatal(kind, "delete allowed")
		}
	}
}

func TestServiceRemoteDeleteMigrationCarriesEveryColumn(t *testing.T) {
	path, db := openSchemaBefore(t, "048")
	now := utcTimestamp(time.Now())
	for _, statement := range []string{
		"INSERT INTO identities(uuid,kind) VALUES('11111111-1111-1111-1111-111111111111','owner'),('22222222-2222-2222-2222-222222222222','service'),('33333333-3333-3333-3333-333333333333','service')",
		"INSERT INTO user_accounts(uuid,kind,local_username,created_at,updated_at) VALUES('11111111-1111-1111-1111-111111111111','owner','owner','" + now + "','" + now + "')",
		"INSERT INTO media_servers(id,server_nickname,service_type,url) VALUES(1,'fixture','jellyfin','http://fixture.invalid')",
		"INSERT INTO service_accounts(uuid,server_id,external_user_id,created_at,updated_at) VALUES('22222222-2222-2222-2222-222222222222',1,'done','" + now + "','" + now + "'),('33333333-3333-3333-3333-333333333333',1,'lease','" + now + "','" + now + "')",
		"UPDATE service_remote_access SET state='enabled',checked_at='" + now + "',revision=4 WHERE service_uuid='22222222-2222-2222-2222-222222222222'",
		"UPDATE service_remote_access SET state='running',operation_token='lease',operation_kind='enable',actor_uuid='11111111-1111-1111-1111-111111111111',access_hash='x',role_revision=1,config_revision=1,link_revision=1,provider_fingerprint='x',external_user_id='lease',operation_expires_at='2999-01-01T00:00:00Z',revision=5 WHERE service_uuid='33333333-3333-3333-3333-333333333333'",
	} {
		if _, err := db.Exec(statement); err != nil {
			t.Fatal(statement, err)
		}
	}
	snapshot := func(q interface {
		QueryRow(string, ...any) *sql.Row
	}) string {
		var value string
		if err := q.QueryRow("SELECT json_group_array(json_array(service_uuid,revision,state,error_code,checked_at,operation_token,operation_kind,actor_uuid,access_hash,role_revision,config_revision,link_revision,provider_fingerprint,external_user_id,operation_expires_at)) FROM (SELECT * FROM service_remote_access ORDER BY service_uuid)").Scan(&value); err != nil {
			t.Fatal(err)
		}
		return value
	}
	before := snapshot(db)
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	s, err := OpenStore(t.Context(), path)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if after := snapshot(s.reader); after != before {
		t.Fatal("migration 048 changed rows", before, after)
	}
	if _, err := s.writer.Exec("UPDATE service_remote_access SET state='deleted' WHERE service_uuid='22222222-2222-2222-2222-222222222222'"); err != nil {
		t.Fatal("deleted state rejected", err)
	}
	if err := s.CheckIntegrity(t.Context()); err != nil {
		t.Fatal(err)
	}
}
