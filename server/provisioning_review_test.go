package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

type reviewFixture struct {
	server                                                                                          *httptest.Server
	mu                                                                                              sync.Mutex
	name                                                                                            string
	kind                                                                                            string
	ignorePolicy                                                                                    bool
	policy                                                                                          map[string]any
	failEnable, failCreate, failDisable, absent, badIdentity, adminPolicy, missingPolicy, badPrefix bool
	creates, disables, inspections                                                                  int
	passwordWrites                                                                                  int
	lastPassword                                                                                    string
	failPassword                                                                                    bool
	beforeInspect                                                                                   func()
}

func newReviewFixture(t *testing.T, failEnable bool) *reviewFixture {
	return newReviewFixtureFor(t, "jellyfin", failEnable)
}

func newReviewFixtureFor(t *testing.T, kind string, failEnable bool) *reviewFixture {
	f := &reviewFixture{kind: kind, failEnable: failEnable, policy: map[string]any{"IsAdministrator": false, "IsDisabled": false, "AuthenticationProviderId": "default-auth", "PasswordResetProviderId": "default-reset", "CustomPolicyField": "preserve-me"}}
	if kind == "emby" {
		delete(f.policy, "AuthenticationProviderId")
		delete(f.policy, "PasswordResetProviderId")
	}
	f.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-Emby-Token") != "fixture-secret" {
			http.Error(w, "bad key", 401)
			return
		}
		if kind == "emby" {
			if !strings.HasPrefix(r.URL.Path, "/emby/") {
				t.Error("missing Emby prefix", r.URL.Path)
				http.NotFound(w, r)
				return
			}
			r.URL.Path = strings.TrimPrefix(r.URL.Path, "/emby")
		}
		w.Header().Set("Content-Type", "application/json")
		f.mu.Lock()
		hook := f.beforeInspect
		f.mu.Unlock()
		if r.Method == "GET" && r.URL.Path == "/Users/remote-user" && hook != nil {
			hook()
		}
		f.mu.Lock()
		defer f.mu.Unlock()
		switch r.Method + " " + r.URL.Path {
		case "GET /System/Info":
			if f.badPrefix {
				http.NotFound(w, r)
				return
			}
			fmt.Fprint(w, `{"ServerName":"Fixture","Version":"1"}`)
		case "GET /Library/VirtualFolders":
			fmt.Fprint(w, `[{"ItemId":"movies","Name":"Movies","CollectionType":"movies"}]`)
		case "GET /Users":
			fmt.Fprint(w, `[]`)
		case "POST /Users/New":
			var body map[string]string
			_ = json.NewDecoder(r.Body).Decode(&body)
			f.name = body["Name"]
			f.creates++
			if f.failCreate {
				http.Error(w, "private uncertain upstream response", 503)
				return
			}
			if kind == "emby" {
				if len(body) != 1 || body["Name"] == "" {
					t.Error("Emby create accepts Name only")
				}
				_ = json.NewEncoder(w).Encode(map[string]any{"Id": "remote-user", "Name": f.name, "Policy": f.policy})
			} else {
				fmt.Fprint(w, `{"Id":"remote-user"}`)
			}
		case "GET /Users/remote-user":
			f.inspections++
			if f.absent {
				http.NotFound(w, r)
				return
			}
			policy := map[string]any{}
			for k, v := range f.policy {
				policy[k] = v
			}
			if f.adminPolicy {
				policy["IsAdministrator"] = true
			}
			if f.missingPolicy {
				delete(policy, "IsDisabled")
			}
			name := f.name
			if f.badIdentity {
				name = "Someone Else"
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"Id": "remote-user", "Name": name, "Policy": policy})
		case "POST /Users/Password", "POST /Users/remote-user/Password":
			var body struct {
				NewPw         string
				ResetPassword bool
			}
			_ = json.NewDecoder(r.Body).Decode(&body)
			if (kind == "jellyfin" && (r.URL.Path != "/Users/Password" || r.URL.Query().Get("userId") != "remote-user")) || (kind == "emby" && (r.URL.Path != "/Users/remote-user/Password" || r.URL.RawQuery != "")) || body.NewPw == "" || body.ResetPassword {
				t.Error("unsafe password request")
			}
			f.passwordWrites++
			f.lastPassword = body.NewPw
			if f.failPassword {
				http.Error(w, "uncertain password response", 503)
				return
			}
			w.WriteHeader(204)
		case "POST /Users/remote-user/Policy":
			var policy map[string]any
			_ = json.NewDecoder(r.Body).Decode(&policy)
			if f.policy["IsDisabled"] == false && policy["IsDisabled"] == true && f.failEnable {
				// Only count compensation after the initial provisioning enable was
				// attempted; initial configuration also posts a disabled policy.
				if f.policy["EnableAllFolders"] != nil {
					f.disables++
					if f.failDisable {
						http.Error(w, "private failure", 503)
						return
					}
				}
			}
			if !f.ignorePolicy {
				f.policy = policy
			}
			if f.failEnable && policy["IsDisabled"] == false {
				http.Error(w, "uncertain enable response", 503)
				return
			}
			w.WriteHeader(204)
		default:
			t.Error("unexpected fixture request", r.Method, r.URL.Path)
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(f.server.Close)
	return f
}

func createFailedReviewJob(t *testing.T, a *App, admin string, fixtures ...*reviewFixture) (redemptionJob, string, map[string]any, []int64) {
	t.Helper()
	grants := []InvitationGrant{}
	ids := []int64{}
	for index, f := range fixtures {
		w := apiRequest(a, "POST", "/api/servers", admin, map[string]any{"server_nickname": fmt.Sprintf("Review fixture %d", index), "service_type": f.kind, "url": f.server.URL, "api_key": "fixture-secret"}, nil)
		if w.Code != 201 {
			t.Fatal(w.Code, w.Body.String())
		}
		id := int64(responseData(t, w)["id"].(float64))
		ids = append(ids, id)
		if w := apiRequest(a, "POST", fmt.Sprintf("/api/servers/%d/sync", id), admin, nil, nil); w.Code != 200 {
			t.Fatal(w.Code, w.Body.String())
		}
		grants = append(grants, InvitationGrant{ServerID: id, LibraryIDs: []string{"movies"}})
	}
	w := apiRequest(a, "POST", "/api/invitations", admin, map[string]any{"expires_at": time.Now().Add(time.Hour).UTC().Format(time.RFC3339Nano), "max_uses": 1, "grants": grants}, nil)
	if w.Code != 201 {
		t.Fatal(w.Code, w.Body.String())
	}
	token := responseData(t, w)["token"].(string)
	body := redeemBody("Review Recipient", newUUID())
	w = apiRequest(a, "POST", "/api/public/invitations/"+token+"/redeem", "", body, nil)
	if w.Code != 201 || responseData(t, w)["status"] != "failed" {
		t.Fatal(w.Code, w.Body.String())
	}
	job, err := a.loadRedemption(t.Context(), responseData(t, w)["id"].(string))
	if err != nil {
		t.Fatal(err)
	}
	return job, token, body, ids
}

func reviewBody(job redemptionJob) map[string]any {
	return map[string]any{"revision": job.Revision, "reason": "Administrator reconciled the failed provisioning attempt", "acknowledge_in_flight_risk": true}
}
func currentReview(t *testing.T, a *App, id string) redemptionJob {
	t.Helper()
	job, err := a.loadRedemption(t.Context(), id)
	if err != nil {
		t.Fatal(err)
	}
	return job
}

func TestKnownAccountsDisableThenCancellationReleasesReservation(t *testing.T) {
	a, s := testApp(t)
	admin, _ := bootstrapOwner(t, a)
	first, second := newReviewFixture(t, false), newReviewFixture(t, true)
	job, inviteToken, original, _ := createFailedReviewJob(t, a, admin, first, second)
	base := "/api/provisioning-jobs/" + job.ID
	if w := apiRequest(a, "POST", base+"/cancel", admin, reviewBody(job), nil); w.Code != 409 {
		t.Fatal("cancel released accounts that remain active", w.Code, w.Body.String())
	}
	job = currentReview(t, a, job.ID)
	if w := apiRequest(a, "POST", base+"/disable-accounts", admin, reviewBody(job), nil); w.Code != 200 || responseData(t, w)["review_error_code"] != nil {
		t.Fatal(w.Code, w.Body.String())
	}
	job = currentReview(t, a, job.ID)
	if !job.Reserved || job.Status != "failed" {
		t.Fatal(job)
	}
	for _, f := range []*reviewFixture{first, second} {
		f.mu.Lock()
		disabled := f.policy["IsDisabled"]
		custom := f.policy["CustomPolicyField"]
		creates := f.creates
		f.mu.Unlock()
		if disabled != true || custom != "preserve-me" || creates != 1 {
			t.Fatal("compensation changed account identity/policy", disabled, custom, creates)
		}
	}
	body := reviewBody(job)
	body["release_username"] = true
	if w := apiRequest(a, "POST", base+"/cancel", admin, body, nil); w.Code != 200 || responseData(t, w)["status"] != "cancelled" {
		t.Fatal(w.Code, w.Body.String())
	}
	job = currentReview(t, a, job.ID)
	if job.Reserved || job.Status != "cancelled" {
		t.Fatal(job)
	}
	var username sql.NullString
	var active, uses, links int
	if err := s.reader.QueryRow("SELECT local_username,is_active FROM user_accounts WHERE uuid=?", job.UserUUID).Scan(&username, &active); err != nil || username.Valid || active != 0 {
		t.Fatal(username, active, err)
	}
	if err := s.reader.QueryRow("SELECT current_uses FROM invites WHERE id=?", job.InviteID).Scan(&uses); err != nil || uses != 0 {
		t.Fatal(uses, err)
	}
	if err := s.reader.QueryRow("SELECT count(*) FROM service_links WHERE user_uuid=?", job.UserUUID).Scan(&links); err != nil || links != 1 {
		t.Fatal("lost completed association", links, err)
	}
	w := apiRequest(a, "POST", "/api/public/invitations/"+inviteToken+"/redeem", "", original, nil)
	if w.Code != 200 || responseData(t, w)["status"] != "cancelled" || responseData(t, w)["requires_review"] != false {
		t.Fatal(w.Code, w.Body.String())
	}
	if strings.Contains(w.Body.String(), "remote-user") || strings.Contains(w.Body.String(), "remote_username") {
		t.Fatal("public receipt leaked review target")
	}
	if err := s.CheckIntegrity(t.Context()); err != nil {
		t.Fatal(err)
	}
}

func TestUnknownCreateRequiresAuditedExternalResolution(t *testing.T) {
	a, s := testApp(t)
	admin, _ := bootstrapOwner(t, a)
	f := newReviewFixture(t, true)
	f.mu.Lock()
	f.failCreate = true
	f.mu.Unlock()
	job, _, _, ids := createFailedReviewJob(t, a, admin, f)
	base := "/api/provisioning-jobs/" + job.ID
	w := apiRequest(a, "GET", base, admin, nil, nil)
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"manual_resolution_required":true`) {
		t.Fatal(w.Code, w.Body.String())
	}
	if w := apiRequest(a, "POST", base+"/disable-accounts", admin, reviewBody(job), nil); w.Code != 200 || responseData(t, w)["review_error_code"] != "REVIEW_REQUIRED" {
		t.Fatal(w.Code, w.Body.String())
	}
	job = currentReview(t, a, job.ID)
	if w := apiRequest(a, "POST", base+"/cancel", admin, reviewBody(job), nil); w.Code != 409 {
		t.Fatal("unknown remote outcome released automatically", w.Code)
	}
	job = currentReview(t, a, job.ID)
	body := reviewBody(job)
	body["manual_resolutions"] = []manualReview{{ids[0], "Verified upstream request settled and removed its account externally"}}
	if w := apiRequest(a, "POST", base+"/cancel", admin, body, nil); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	var audit string
	if err := s.reader.QueryRow("SELECT details FROM audit_events WHERE action='provisioning.cancel'").Scan(&audit); err != nil || !strings.Contains(audit, "manual_resolutions") || !strings.Contains(audit, "externally") {
		t.Fatal(audit, err)
	}
	f.mu.Lock()
	inspections, disables, creates := f.inspections, f.disables, f.creates
	f.mu.Unlock()
	if inspections != 0 || disables != 0 || creates != 1 {
		t.Fatal("guessed ownership or retried create", inspections, disables, creates)
	}
}

func TestReviewGuardsAndRemoteFailuresKeepReservations(t *testing.T) {
	for _, mode := range []string{"identity", "administrator", "missing_policy", "disable_failure", "wrong_prefix"} {
		t.Run(mode, func(t *testing.T) {
			a, _ := testApp(t)
			admin, _ := bootstrapOwner(t, a)
			f := newReviewFixture(t, true)
			job, _, _, _ := createFailedReviewJob(t, a, admin, f)
			f.mu.Lock()
			switch mode {
			case "identity":
				f.badIdentity = true
			case "administrator":
				f.adminPolicy = true
			case "missing_policy":
				f.missingPolicy = true
			case "disable_failure":
				f.failDisable = true
			case "wrong_prefix":
				f.badPrefix = true
				f.absent = true
			}
			f.mu.Unlock()
			base := "/api/provisioning-jobs/" + job.ID
			w := apiRequest(a, "POST", base+"/disable-accounts", admin, reviewBody(job), nil)
			if w.Code != 200 || responseData(t, w)["review_error_code"] != "REVIEW_REQUIRED" {
				t.Fatal(w.Code, w.Body.String())
			}
			job = currentReview(t, a, job.ID)
			if w := apiRequest(a, "POST", base+"/cancel", admin, reviewBody(job), nil); w.Code != 409 {
				t.Fatal(w.Code, w.Body.String())
			}
			job = currentReview(t, a, job.ID)
			if !job.Reserved || job.Reviewing {
				t.Fatal(job)
			}
		})
	}
}

func TestReviewRevisionLeasePermissionAndConfigGuards(t *testing.T) {
	a, s := testApp(t)
	admin, _ := bootstrapOwner(t, a)
	f := newReviewFixture(t, true)
	job, _, _, ids := createFailedReviewJob(t, a, admin, f)
	base := "/api/provisioning-jobs/" + job.ID
	if w := apiRequest(a, "POST", base+"/disable-accounts", "", reviewBody(job), nil); w.Code != 401 {
		t.Fatal(w.Code)
	}
	body := reviewBody(job)
	body["acknowledge_in_flight_risk"] = false
	if w := apiRequest(a, "POST", base+"/disable-accounts", admin, body, nil); w.Code != 400 {
		t.Fatal(w.Code)
	}
	started, release := make(chan struct{}), make(chan struct{})
	var once sync.Once
	defer once.Do(func() { close(release) })
	var blockOnce sync.Once
	f.mu.Lock()
	f.beforeInspect = func() { blockOnce.Do(func() { close(started); <-release }) }
	f.mu.Unlock()
	done := make(chan *httptest.ResponseRecorder, 1)
	go func() { done <- apiRequest(a, "POST", base+"/disable-accounts", admin, reviewBody(job), nil) }()
	select {
	case <-started:
	case <-time.After(5 * time.Second):
		t.Fatal("review did not start")
	}
	busy := currentReview(t, a, job.ID)
	if !busy.Reviewing {
		t.Fatal(busy)
	}
	if w := apiRequest(a, "POST", base+"/cancel", admin, reviewBody(busy), nil); w.Code != 409 {
		t.Fatal("concurrent review lease accepted", w.Code)
	}
	if err := s.write(t.Context(), func(tx *sql.Tx) error {
		_, err := tx.Exec("UPDATE media_servers SET revision=revision+1 WHERE id=?", ids[0])
		return err
	}); err != nil {
		t.Fatal(err)
	}
	once.Do(func() { close(release) })
	select {
	case w := <-done:
		if w.Code != 200 && w.Code != 409 {
			t.Fatal(w.Code, w.Body.String())
		}
	case <-time.After(5 * time.Second):
		t.Fatal("review did not finish")
	}
	f.mu.Lock()
	disables := f.disables
	f.mu.Unlock()
	if disables != 0 {
		t.Fatal("server changed during fetch but policy was mutated")
	}
	job = currentReview(t, a, job.ID)
	if !job.Reserved || job.Reviewing {
		t.Fatal(job)
	}
	if w := apiRequest(a, "POST", base+"/disable-accounts", admin, body, nil); w.Code != 400 {
		t.Fatal(w.Code)
	}
	old := reviewBody(job)
	old["revision"] = 1
	if w := apiRequest(a, "POST", base+"/disable-accounts", admin, old, nil); w.Code != 409 {
		t.Fatal("stale review accepted", w.Code)
	}
}

func TestReviewShutdownAndRecoveryDoNotReplayRequests(t *testing.T) {
	a, s := testApp(t)
	admin, _ := bootstrapOwner(t, a)
	f := newReviewFixture(t, true)
	job, _, _, _ := createFailedReviewJob(t, a, admin, f)
	if err := s.write(t.Context(), func(tx *sql.Tx) error {
		if _, err := tx.Exec("UPDATE provisioning_jobs SET review_token='interrupted' WHERE id=?", job.ID); err != nil {
			return err
		}
		_, err := tx.Exec("UPDATE provisioning_steps SET cleanup_state='running' WHERE job_id=?", job.ID)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	if err := a.recoverProvisioning(context.Background()); err != nil {
		t.Fatal(err)
	}
	job = currentReview(t, a, job.ID)
	if job.Reviewing || job.ReviewError != "INTERRUPTED_REVIEW_REQUIRED" || job.Steps[0].Cleanup != "unknown" || !job.Reserved {
		t.Fatal(job)
	}
	a.CloseProvisioning()
	if w := apiRequest(a, "POST", "/api/provisioning-jobs/"+job.ID+"/disable-accounts", admin, reviewBody(job), nil); w.Code != 503 {
		t.Fatal(w.Code)
	}
	f.mu.Lock()
	creates, disables := f.creates, f.disables
	f.mu.Unlock()
	if creates != 1 || disables != 0 {
		t.Fatal("recovery repeated remote mutation")
	}
}

func TestCompensationRejectsStaleUserSyncSnapshots(t *testing.T) {
	a, s := testApp(t)
	admin, _ := bootstrapOwner(t, a)
	first, second := newReviewFixture(t, false), newReviewFixture(t, true)
	job, _, _, ids := createFailedReviewJob(t, a, admin, first, second)
	actor, err := s.Authenticate(t.Context(), admin)
	if err != nil {
		t.Fatal(err)
	}
	snapshot, err := a.loadServer(t.Context(), ids[0])
	if err != nil {
		t.Fatal(err)
	}
	started, release := make(chan struct{}), make(chan struct{})
	var once sync.Once
	defer once.Do(func() { close(release) })
	a.ProviderHTTP = &http.Client{Transport: providerTransport(func(r *http.Request) (*http.Response, error) {
		if r.URL.Path == "/Users" {
			close(started)
			select {
			case <-release:
			case <-r.Context().Done():
				return nil, r.Context().Err()
			}
			return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(`[{"Id":"remote-user","Name":"Review Recipient","Policy":{"IsDisabled":false,"EnableAllFolders":false,"EnabledFolders":["movies"]}}]`)), Request: r}, nil
		}
		return http.DefaultTransport.RoundTrip(r)
	})}
	done := make(chan error, 1)
	go func() { _, err := a.syncServer(t.Context(), actor.UUID, admin, snapshot, false, true); done <- err }()
	select {
	case <-started:
	case <-time.After(5 * time.Second):
		t.Fatal("sync did not start")
	}
	w := apiRequest(a, "POST", "/api/provisioning-jobs/"+job.ID+"/disable-accounts", admin, reviewBody(job), nil)
	if w.Code != 200 || responseData(t, w)["review_error_code"] != nil {
		t.Fatal(w.Code, w.Body.String())
	}
	once.Do(func() { close(release) })
	select {
	case err := <-done:
		if err != ErrConflict {
			t.Fatal("old active-user snapshot overwrote cleanup", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("sync did not finish")
	}
	var active bool
	if err := s.reader.QueryRow("SELECT is_active FROM service_accounts WHERE server_id=?", ids[0]).Scan(&active); err != nil || active {
		t.Fatal("compensated account reactivated", active, err)
	}
}

func TestReviewDeniesStandardUsersAndActivatedProfiles(t *testing.T) {
	a, s := testApp(t)
	admin, _ := bootstrapOwner(t, a)
	f := newReviewFixture(t, true)
	job, _, _, _ := createFailedReviewJob(t, a, admin, f)
	owner, err := s.Authenticate(t.Context(), admin)
	if err != nil {
		t.Fatal(err)
	}
	hash, err := hashPassword("standard-review-password")
	if err != nil {
		t.Fatal(err)
	}
	uuid, err := s.CreateAccount(t.Context(), owner.UUID, "Standard Reviewer", hash, false)
	if err != nil {
		t.Fatal(err)
	}
	tokens, err := s.issueSession(t.Context(), uuid, false)
	if err != nil {
		t.Fatal(err)
	}
	if w := apiRequest(a, "POST", "/api/provisioning-jobs/"+job.ID+"/disable-accounts", tokens.Access, reviewBody(job), nil); w.Code != 403 {
		t.Fatal(w.Code, w.Body.String())
	}
	if _, err := s.writer.Exec("UPDATE user_accounts SET is_active=1 WHERE uuid=?", job.UserUUID); err != nil {
		t.Fatal(err)
	}
	if w := apiRequest(a, "POST", "/api/provisioning-jobs/"+job.ID+"/disable-accounts", admin, reviewBody(job), nil); w.Code != 409 {
		t.Fatal("review touched activated profile", w.Code, w.Body.String())
	}
}

func TestReviewShutdownPersistsUnknownOutcomeBeforeStoreClose(t *testing.T) {
	a, _ := testApp(t)
	admin, _ := bootstrapOwner(t, a)
	f := newReviewFixture(t, true)
	job, _, _, _ := createFailedReviewJob(t, a, admin, f)
	started, release := make(chan struct{}), make(chan struct{})
	var once sync.Once
	defer once.Do(func() { close(release) })
	f.mu.Lock()
	f.beforeInspect = func() { close(started); <-release }
	f.mu.Unlock()
	done := make(chan *httptest.ResponseRecorder, 1)
	go func() {
		done <- apiRequest(a, "POST", "/api/provisioning-jobs/"+job.ID+"/disable-accounts", admin, reviewBody(job), nil)
	}()
	select {
	case <-started:
	case <-time.After(5 * time.Second):
		t.Fatal("review did not start")
	}
	closed := make(chan struct{})
	go func() { a.CloseProvisioning(); close(closed) }()
	select {
	case <-closed:
	case <-time.After(5 * time.Second):
		t.Fatal("shutdown did not cancel review")
	}
	once.Do(func() { close(release) })
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("handler did not finish")
	}
	job = currentReview(t, a, job.ID)
	if job.Reviewing || !job.Reserved || job.Steps[0].Cleanup != "unknown" {
		t.Fatal(job)
	}
}

func TestKnownAbsentAccountAllowsCancellationWithoutMutation(t *testing.T) {
	a, _ := testApp(t)
	admin, _ := bootstrapOwner(t, a)
	f := newReviewFixture(t, true)
	job, _, _, _ := createFailedReviewJob(t, a, admin, f)
	f.mu.Lock()
	f.absent = true
	f.mu.Unlock()
	w := apiRequest(a, "POST", "/api/provisioning-jobs/"+job.ID+"/cancel", admin, reviewBody(job), nil)
	if w.Code != 200 || responseData(t, w)["status"] != "cancelled" {
		t.Fatal(w.Code, w.Body.String())
	}
	job = currentReview(t, a, job.ID)
	if job.Steps[0].Cleanup != "absent" || job.Reserved {
		t.Fatal(job)
	}
	f.mu.Lock()
	disables := f.disables
	f.mu.Unlock()
	if disables != 0 {
		t.Fatal("mutated an absent remote account")
	}
}

func TestCleanupIdentityRejectsPathSegmentsBeforeNetwork(t *testing.T) {
	p := &jsonProvider{config: ProviderConfig{Type: "jellyfin", URL: "http://fixture.invalid"}, client: &http.Client{Transport: providerTransport(func(*http.Request) (*http.Response, error) {
		t.Fatal("invalid identity reached the network")
		return nil, nil
	})}}
	for _, id := range []string{"..", ".", "id/escape", "id%2Fescape", "id?query"} {
		if _, err := p.inspectProvisionedUser(t.Context(), id, "Recipient"); err == nil {
			t.Fatal("accepted unsafe provider identity", id)
		}
	}
}
