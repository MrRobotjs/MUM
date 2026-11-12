package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

const invitationPassword = "recipient-private-password"

type provisioningFixture struct {
	server            *httptest.Server
	mode              string
	creates           atomic.Int32
	mu                sync.Mutex
	bootstrap         string
	policies          int
	beforeCreateReply func()
	expectedUsername  string
	expectedPassword  string
}

func newProvisioningFixture(t *testing.T, mode string) *provisioningFixture {
	t.Helper()
	f := &provisioningFixture{mode: mode, expectedPassword: invitationPassword}
	f.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-Emby-Token") != "fixture-secret" {
			t.Error("missing credential header")
			http.Error(w, "bad key", 401)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		switch r.Method + " " + r.URL.Path {
		case "GET /Library/VirtualFolders":
			fmt.Fprint(w, `[{"ItemId":"movies","Name":"Movies","CollectionType":"movies"}]`)
		case "GET /Users":
			fmt.Fprint(w, `[]`)
		case "POST /Users/New":
			f.creates.Add(1)
			var body map[string]string
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Error(err)
			}
			if body["Name"] == "" || len(body["Password"]) < 32 || body["Password"] == invitationPassword {
				t.Error("creation must use a private random bootstrap password")
			}
			if f.expectedUsername != "" && body["Name"] != f.expectedUsername {
				t.Error("wrong per-server username", body["Name"])
			}
			f.mu.Lock()
			f.bootstrap = body["Password"]
			f.mu.Unlock()
			if f.beforeCreateReply != nil {
				f.beforeCreateReply()
			}
			if f.mode == "create" {
				http.Error(w, "upstream-private-secret", 503)
				return
			}
			if f.mode == "missing_id" {
				fmt.Fprint(w, `{}`)
				return
			}
			fmt.Fprint(w, `{"Id":"new-user"}`)
		case "GET /Users/new-user":
			if f.mode == "policy_missing" {
				fmt.Fprint(w, `{"Policy":{}}`)
				return
			}
			fmt.Fprint(w, `{"Policy":{"AuthenticationProviderId":"default-auth","PasswordResetProviderId":"default-reset","IsAdministrator":true,"EnableContentDeletion":true,"EnableContentDeletionFromFolders":["private"],"EnableAllFolders":true}}`)
		case "POST /Users/new-user/Policy":
			var body map[string]any
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Error(err)
			}
			f.mu.Lock()
			f.policies++
			number := f.policies
			f.mu.Unlock()
			if body["IsAdministrator"] != false || body["EnableContentDeletion"] != false || body["EnableLiveTvAccess"] != false || body["EnableContentDownloading"] != false || body["AuthenticationProviderId"] != "default-auth" || body["EnableAllFolders"] != false {
				t.Error("unsafe or incomplete policy", body)
			}
			folders, _ := body["EnabledFolders"].([]any)
			if len(folders) != 1 || folders[0] != "movies" {
				t.Error("explicit library restriction lost", body)
			}
			deletions, _ := body["EnableContentDeletionFromFolders"].([]any)
			if len(deletions) != 0 {
				t.Error("deletion grants retained")
			}
			if body["IsDisabled"] != (number == 1) {
				t.Error("account must stay disabled until configured")
			}
			if f.mode == "policy" || f.mode == "enable" && number == 2 {
				http.Error(w, "upstream-private-secret", 500)
				return
			}
			w.WriteHeader(204)
		case "POST /Users/Password":
			var body map[string]any
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Error(err)
			}
			f.mu.Lock()
			bootstrap, policies := f.bootstrap, f.policies
			f.mu.Unlock()
			if body["CurrentPw"] != bootstrap || body["NewPw"] != f.expectedPassword || body["ResetPassword"] != false || policies != 1 {
				t.Error("password set before disabled policy or invalid password request")
			}
			if f.mode == "password" {
				http.Error(w, "upstream-private-secret", 500)
				return
			}
			w.WriteHeader(204)
		default:
			t.Error("unexpected provisioning request", r.Method, r.URL.Path)
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(f.server.Close)
	return f
}

func TestInvitationPerServerCredentialsAndEmail(t *testing.T) {
	a, s := testApp(t)
	admin, _ := bootstrapOwner(t, a)
	first, second := newProvisioningFixture(t, ""), newProvisioningFixture(t, "")
	first.expectedUsername, first.expectedPassword = "First Remote", "first-remote-private-password"
	second.expectedUsername, second.expectedPassword = "Second Remote", "second-remote-private-password"
	_, token, ids := prepareInvitation(t, a, admin, first, second)
	body := redeemBody("Local Recipient", newUUID())
	body["email"] = "recipient@example.invalid"
	body["server_credentials"] = []redemptionCredentials{{ids[0], first.expectedUsername, first.expectedPassword}, {ids[1], second.expectedUsername, second.expectedPassword}}
	w := apiRequest(a, "POST", "/api/public/invitations/"+token+"/redeem", "", body, nil)
	if w.Code != 201 || responseData(t, w)["status"] != "completed" {
		t.Fatal(w.Code, w.Body.String())
	}
	var email, hash string
	if err := s.reader.QueryRow("SELECT email,password_hash FROM user_accounts WHERE local_username='Local Recipient'").Scan(&email, &hash); err != nil {
		t.Fatal(err)
	}
	if email != "recipient@example.invalid" || !verifyPassword(hash, invitationPassword) || verifyPassword(hash, first.expectedPassword) {
		t.Fatal("local and remote credentials were conflated")
	}
	for i, f := range []*provisioningFixture{first, second} {
		var username string
		if err := s.reader.QueryRow("SELECT external_username FROM service_accounts WHERE server_id=?", ids[i]).Scan(&username); err != nil || username != f.expectedUsername {
			t.Fatal(username, err)
		}
	}
	if w := apiRequest(a, "POST", "/api/public/invitations/"+token+"/redeem", "", body, nil); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	if first.creates.Load() != 1 || second.creates.Load() != 1 {
		t.Fatal("receipt repeated per-server creates")
	}
}

func TestInvitationRejectsUninvitedAndInvalidCredentialsBeforeReserving(t *testing.T) {
	a, s := testApp(t)
	admin, _ := bootstrapOwner(t, a)
	f := newProvisioningFixture(t, "")
	_, token, ids := prepareInvitation(t, a, admin, f)
	path := "/api/public/invitations/" + token + "/redeem"
	for _, credentials := range [][]redemptionCredentials{
		{{99999, "Reader", invitationPassword}},
		{{ids[0], "Reader", invitationPassword}, {ids[0], "Reader", invitationPassword}},
		{{ids[0], "Reader", "short"}},
	} {
		body := redeemBody("Invalid Credentials", newUUID())
		body["server_credentials"] = credentials
		w := apiRequest(a, "POST", path, "", body, nil)
		if w.Code != 400 && w.Code != 409 {
			t.Fatal(w.Code, w.Body.String())
		}
	}
	body := redeemBody("Invalid Email", newUUID())
	body["email"] = "Recipient <recipient@example.invalid>"
	if w := apiRequest(a, "POST", path, "", body, nil); w.Code != 400 {
		t.Fatal(w.Code, w.Body.String())
	}
	var jobs int
	if err := s.reader.QueryRow("SELECT count(*) FROM provisioning_jobs").Scan(&jobs); err != nil || jobs != 0 || f.creates.Load() != 0 {
		t.Fatal("invalid input reserved capacity or contacted upstream", jobs, err)
	}
}

func prepareInvitation(t *testing.T, a *App, token string, fixtures ...*provisioningFixture) (int64, string, []int64) {
	t.Helper()
	grants := []InvitationGrant{}
	ids := []int64{}
	for i, f := range fixtures {
		w := apiRequest(a, "POST", "/api/servers", token, map[string]any{"server_nickname": fmt.Sprintf("Provision %d", i), "service_type": "jellyfin", "url": f.server.URL, "api_key": "fixture-secret"}, nil)
		if w.Code != 201 {
			t.Fatal(w.Code, w.Body.String())
		}
		id := int64(responseData(t, w)["id"].(float64))
		ids = append(ids, id)
		if w := apiRequest(a, "POST", fmt.Sprintf("/api/servers/%d/sync", id), token, nil, nil); w.Code != 200 {
			t.Fatal(w.Code, w.Body.String())
		}
		grants = append(grants, InvitationGrant{ServerID: id, LibraryIDs: []string{"movies"}})
	}
	w := apiRequest(a, "POST", "/api/invitations", token, map[string]any{"expires_at": time.Now().Add(time.Hour).UTC().Format(time.RFC3339Nano), "max_uses": 1, "grants": grants}, nil)
	if w.Code != 201 {
		t.Fatal(w.Code, w.Body.String())
	}
	data := responseData(t, w)
	return int64(data["id"].(float64)), data["token"].(string), ids
}

func redeemBody(username, requestID string) map[string]any {
	return map[string]any{"username": username, "password": invitationPassword, "request_id": requestID}
}

func TestInvitationMultiServerSuccessAndIdempotentReceipt(t *testing.T) {
	a, s := testApp(t)
	admin, _ := bootstrapOwner(t, a)
	first, second := newProvisioningFixture(t, ""), newProvisioningFixture(t, "")
	inviteID, token, _ := prepareInvitation(t, a, admin, first, second)
	var stored string
	if err := s.reader.QueryRow("SELECT token FROM invites WHERE id=?", inviteID).Scan(&stored); err != nil || stored == token || stored != tokenHash(token) {
		t.Fatal("invitation secret must only be stored as a digest", err)
	}
	path := "/api/public/invitations/" + token
	w := apiRequest(a, "GET", path, "", nil, nil)
	if w.Code != 200 || strings.Contains(w.Body.String(), "fixture-secret") || strings.Contains(w.Body.String(), first.server.URL) {
		t.Fatal(w.Code, w.Body.String())
	}
	// A concurrent ordinary write inside the upstream handler proves that provider
	// network I/O does not hold the SQLite writer transaction.
	first.beforeCreateReply = func() {
		ctx, cancel := context.WithTimeout(t.Context(), time.Second)
		defer cancel()
		if err := s.write(ctx, func(tx *sql.Tx) error { return auditAction(ctx, tx, "", "fixture.concurrent_write") }); err != nil {
			t.Error("provider request held SQLite writer", err)
		}
	}
	requestID := newUUID()
	body := redeemBody("New Recipient", requestID)
	w = apiRequest(a, "POST", path+"/redeem", "", body, nil)
	if w.Code != 201 {
		t.Fatal(w.Code, w.Body.String())
	}
	data := responseData(t, w)
	if data["status"] != "completed" || data["requires_review"] != false {
		t.Fatal(data)
	}
	if strings.Contains(w.Body.String(), "remote_id") || strings.Contains(w.Body.String(), "user_uuid") || strings.Contains(w.Body.String(), invitationPassword) {
		t.Fatal("public receipt leaked private data")
	}
	jobID := data["id"].(string)
	var active, uses, reserved, links int
	if err := s.reader.QueryRow("SELECT is_active FROM user_accounts WHERE local_username='New Recipient'").Scan(&active); err != nil {
		t.Fatal(err)
	}
	if err := s.reader.QueryRow("SELECT current_uses FROM invites WHERE id=?", inviteID).Scan(&uses); err != nil {
		t.Fatal(err)
	}
	if err := s.reader.QueryRow("SELECT reservation_held FROM provisioning_jobs WHERE id=?", jobID).Scan(&reserved); err != nil {
		t.Fatal(err)
	}
	if err := s.reader.QueryRow("SELECT count(*) FROM service_links l JOIN provisioning_jobs j ON l.user_uuid=j.user_uuid WHERE j.id=?", jobID).Scan(&links); err != nil {
		t.Fatal(err)
	}
	if active != 1 || uses != 1 || reserved != 0 || links != 2 {
		t.Fatal(active, uses, reserved, links)
	}
	if w := apiRequest(a, "POST", path+"/redeem", "", body, nil); w.Code != 200 || responseData(t, w)["id"] != jobID {
		t.Fatal(w.Code, w.Body.String())
	}
	if first.creates.Load() != 1 || second.creates.Load() != 1 {
		t.Fatal("receipt replay repeated remote writes")
	}
	if w := apiRequest(a, "GET", path, "", nil, nil); w.Code != 410 {
		t.Fatal(w.Code, w.Body.String())
	}
	bad := redeemBody("New Recipient", requestID)
	bad["password"] = "another-private-password"
	if w := apiRequest(a, "POST", path+"/redeem", "", bad, nil); w.Code != 409 {
		t.Fatal(w.Code, w.Body.String())
	}
	if w := apiRequest(a, "GET", "/api/provisioning-jobs/"+jobID, admin, nil, nil); w.Code != 200 || !strings.Contains(w.Body.String(), `"remote_id":"new-user"`) {
		t.Fatal(w.Code, w.Body.String())
	}
	if w := apiRequest(a, "GET", "/api/provisioning-jobs/"+jobID, "", nil, nil); w.Code != 401 {
		t.Fatal(w.Code)
	}
	if w := apiRequest(a, "GET", "/api/provisioning-jobs", admin, nil, nil); w.Code != 200 || !strings.Contains(w.Body.String(), jobID) {
		t.Fatal(w.Code, w.Body.String())
	}
	if w := apiRequest(a, "GET", "/api/invitations", admin, nil, nil); w.Code != 200 || strings.Contains(w.Body.String(), token) || strings.Contains(w.Body.String(), stored) {
		t.Fatal("invitation listing leaked a secret", w.Code, w.Body.String())
	}
	if w := apiRequest(a, "POST", "/api/auth/login", "", map[string]any{"username": "New Recipient", "password": invitationPassword}, nil); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
}

func TestInvitationFailureRetainsReservationAndDoesNotReplay(t *testing.T) {
	for _, mode := range []string{"create", "missing_id", "policy_missing", "policy", "password", "enable"} {
		t.Run(mode, func(t *testing.T) {
			a, s := testApp(t)
			admin, _ := bootstrapOwner(t, a)
			f := newProvisioningFixture(t, mode)
			inviteID, token, _ := prepareInvitation(t, a, admin, f)
			path := "/api/public/invitations/" + token + "/redeem"
			body := redeemBody("Incomplete Recipient", newUUID())
			w := apiRequest(a, "POST", path, "", body, nil)
			if w.Code != 201 || responseData(t, w)["status"] != "failed" || responseData(t, w)["requires_review"] != true {
				t.Fatal(w.Code, w.Body.String())
			}
			if strings.Contains(w.Body.String(), "upstream-private-secret") || strings.Contains(w.Body.String(), invitationPassword) {
				t.Fatal("upstream response leaked")
			}
			jobID := responseData(t, w)["id"].(string)
			job, err := a.loadRedemption(t.Context(), jobID)
			if err != nil {
				t.Fatal(err)
			}
			if len(job.Steps) != 1 || job.Steps[0].Status != "failed" {
				t.Fatal(job)
			}
			if mode != "create" && mode != "missing_id" && job.Steps[0].RemoteID != "new-user" {
				t.Fatal("known remote ID lost", job)
			}
			var active, uses, reserved int
			if err := s.reader.QueryRow("SELECT is_active FROM user_accounts WHERE local_username='Incomplete Recipient'").Scan(&active); err != nil {
				t.Fatal(err)
			}
			if err := s.reader.QueryRow("SELECT current_uses FROM invites WHERE id=?", inviteID).Scan(&uses); err != nil {
				t.Fatal(err)
			}
			if err := s.reader.QueryRow("SELECT reservation_held FROM provisioning_jobs WHERE id=?", jobID).Scan(&reserved); err != nil {
				t.Fatal(err)
			}
			if active != 0 || uses != 0 || reserved != 1 {
				t.Fatal(active, uses, reserved)
			}
			if w := apiRequest(a, "POST", path, "", body, nil); w.Code != 200 || responseData(t, w)["status"] != "failed" {
				t.Fatal(w.Code, w.Body.String())
			}
			if w := apiRequest(a, "POST", path, "", redeemBody("Another Recipient", newUUID()), nil); w.Code != 409 {
				t.Fatal(w.Code, w.Body.String())
			}
			if f.creates.Load() != 1 {
				t.Fatal("failed remote create replayed")
			}
			var result, grant, requestHash string
			if err := s.reader.QueryRow("SELECT coalesce(s.result,''),s.grant_snapshot,j.request_hash FROM provisioning_steps s JOIN provisioning_jobs j ON j.id=s.job_id WHERE j.id=?", jobID).Scan(&result, &grant, &requestHash); err != nil {
				t.Fatal(err)
			}
			if strings.Contains(result+grant, invitationPassword) || strings.Contains(result+grant, f.bootstrap) || requestHash == body["request_id"] {
				t.Fatal("provisioning persisted a raw secret")
			}
		})
	}
}

func TestInvitationCapacityAndRevocationDuringCreate(t *testing.T) {
	a, s := testApp(t)
	admin, _ := bootstrapOwner(t, a)
	f := newProvisioningFixture(t, "")
	inviteID, token, _ := prepareInvitation(t, a, admin, f)
	started, release := make(chan struct{}), make(chan struct{})
	var releaseOnce sync.Once
	defer releaseOnce.Do(func() { close(release) })
	f.beforeCreateReply = func() { close(started); <-release }
	path := "/api/public/invitations/" + token + "/redeem"
	done := make(chan *httptest.ResponseRecorder, 1)
	go func() { done <- apiRequest(a, "POST", path, "", redeemBody("First Recipient", newUUID()), nil) }()
	select {
	case <-started:
	case <-time.After(5 * time.Second):
		t.Fatal("provisioning did not start")
	}
	if w := apiRequest(a, "POST", path, "", redeemBody("Second Recipient", newUUID()), nil); w.Code != 409 {
		t.Fatal(w.Code, w.Body.String())
	}
	if w := apiRequest(a, "POST", "/api/auth/login", "", map[string]any{"username": "First Recipient", "password": invitationPassword}, nil); w.Code != 401 {
		t.Fatal("incomplete profile can log in", w.Code)
	}
	if w := apiRequest(a, "DELETE", fmt.Sprintf("/api/invitations/%d", inviteID), admin, nil, nil); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	releaseOnce.Do(func() { close(release) })
	select {
	case w := <-done:
		if w.Code != 201 || responseData(t, w)["status"] != "failed" {
			t.Fatal(w.Code, w.Body.String())
		}
		job, err := a.loadRedemption(t.Context(), responseData(t, w)["id"].(string))
		if err != nil || len(job.Steps) != 1 || job.Steps[0].RemoteID != "new-user" {
			t.Fatal("revocation discarded returned remote identity", job, err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("provisioning failed to stop")
	}
	var profiles int
	if err := s.reader.QueryRow("SELECT count(*) FROM user_accounts WHERE local_username='Second Recipient'").Scan(&profiles); err != nil || profiles != 0 {
		t.Fatal("capacity loser left a profile", profiles, err)
	}
	if f.creates.Load() != 1 {
		t.Fatal("capacity oversubscribed")
	}
}

func TestInvitationGrantValidationAndRestartRecovery(t *testing.T) {
	a, s := testApp(t)
	admin, _ := bootstrapOwner(t, a)
	f := newProvisioningFixture(t, "")
	_, token, ids := prepareInvitation(t, a, admin, f)
	for _, grants := range [][]InvitationGrant{
		{{ServerID: ids[0]}},
		{{ServerID: ids[0], AllLibraries: true, LibraryIDs: []string{"movies"}}},
		{{ServerID: ids[0], LibraryIDs: []string{"missing"}}},
		{{ServerID: ids[0], LibraryIDs: []string{"movies", "movies"}}},
		{{ServerID: ids[0], AllLibraries: true}, {ServerID: ids[0], AllLibraries: true}},
	} {
		w := apiRequest(a, "POST", "/api/invitations", admin, map[string]any{"expires_at": time.Now().Add(time.Hour).UTC().Format(time.RFC3339Nano), "max_uses": 1, "grants": grants}, nil)
		if w.Code != 409 {
			t.Fatal(w.Code, w.Body.String())
		}
	}
	if w := apiRequest(a, "POST", "/api/invitations", "", map[string]any{}, nil); w.Code != 401 {
		t.Fatal(w.Code)
	}
	// Simulate a crash after an uncertain remote request. Recovery must retain
	// capacity, keep the profile inactive and never issue a replacement create.
	f.mode = "create"
	w := apiRequest(a, "POST", "/api/public/invitations/"+token+"/redeem", "", redeemBody("Interrupted", newUUID()), nil)
	if w.Code != 201 {
		t.Fatal(w.Code, w.Body.String())
	}
	jobID := responseData(t, w)["id"].(string)
	if err := s.write(t.Context(), func(tx *sql.Tx) error {
		if _, err := tx.Exec("UPDATE provisioning_jobs SET status='running',error_code=NULL WHERE id=?", jobID); err != nil {
			return err
		}
		_, err := tx.Exec("UPDATE provisioning_steps SET status='running',stage='creating' WHERE job_id=?", jobID)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	if err := a.recoverProvisioning(t.Context()); err != nil {
		t.Fatal(err)
	}
	job, err := a.loadRedemption(t.Context(), jobID)
	if err != nil || job.Status != "failed" || job.Error != "INTERRUPTED_REVIEW_REQUIRED" {
		t.Fatal(job, err)
	}
	var reserved int
	if err := s.reader.QueryRow("SELECT reservation_held FROM provisioning_jobs WHERE id=?", jobID).Scan(&reserved); err != nil || reserved != 1 {
		t.Fatal(reserved, err)
	}
	if f.creates.Load() != 1 {
		t.Fatal("recovery repeated create")
	}
}

func TestInvitationPartialFailureAndCanceledCheckpoint(t *testing.T) {
	a, s := testApp(t)
	admin, _ := bootstrapOwner(t, a)
	first, second := newProvisioningFixture(t, ""), newProvisioningFixture(t, "password")
	_, token, ids := prepareInvitation(t, a, admin, first, second)
	w := apiRequest(a, "POST", "/api/public/invitations/"+token+"/redeem", "", redeemBody("Partial Recipient", newUUID()), nil)
	if w.Code != 201 {
		t.Fatal(w.Code, w.Body.String())
	}
	jobID := responseData(t, w)["id"].(string)
	job, err := a.loadRedemption(t.Context(), jobID)
	if err != nil || job.Status != "failed" || len(job.Steps) != 2 || job.Steps[0].Status != "completed" || job.Steps[1].Status != "failed" {
		t.Fatal(job, err)
	}
	var active, links int
	if err := s.reader.QueryRow("SELECT u.is_active,(SELECT count(*) FROM service_links WHERE user_uuid=u.uuid) FROM user_accounts u WHERE u.uuid=?", job.UserUUID).Scan(&active, &links); err != nil || active != 0 || links != 1 {
		t.Fatal("partial completion activated profile or lost successful association", active, links, err)
	}
	// Even a canceled caller must not erase an already returned upstream ID.
	if err := s.write(t.Context(), func(tx *sql.Tx) error {
		if _, err := tx.Exec("UPDATE provisioning_jobs SET status='running' WHERE id=?", jobID); err != nil {
			return err
		}
		_, err := tx.Exec("UPDATE provisioning_steps SET status='running',remote_id=NULL WHERE job_id=? AND server_id=?", jobID, ids[1])
		return err
	}); err != nil {
		t.Fatal(err)
	}
	server, err := a.loadServer(t.Context(), ids[1])
	if err != nil {
		t.Fatal(err)
	}
	var inviteID int64
	if err := s.reader.QueryRow("SELECT invite_id FROM provisioning_jobs WHERE id=?", jobID).Scan(&inviteID); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if err := a.provisionCheckpoint(ctx, jobID, inviteID, server, "configuring", "returned-after-cancel"); err != context.Canceled {
		t.Fatal(err)
	}
	var remoteID string
	if err := s.reader.QueryRow("SELECT remote_id FROM provisioning_steps WHERE job_id=? AND server_id=?", jobID, ids[1]).Scan(&remoteID); err != nil || remoteID != "returned-after-cancel" {
		t.Fatal(remoteID, err)
	}
	if err := a.failRedemption(jobID, "REVIEW_REQUIRED"); err != nil {
		t.Fatal(err)
	}
	if err := s.CheckIntegrity(t.Context()); err != nil {
		t.Fatal(err)
	}
}

func TestInvitationServerRevisionChangeStopsFurtherRemoteWrites(t *testing.T) {
	a, s := testApp(t)
	admin, _ := bootstrapOwner(t, a)
	f := newProvisioningFixture(t, "")
	_, token, ids := prepareInvitation(t, a, admin, f)
	f.beforeCreateReply = func() {
		if err := s.write(t.Context(), func(tx *sql.Tx) error {
			_, err := tx.Exec("UPDATE media_servers SET revision=revision+1 WHERE id=?", ids[0])
			return err
		}); err != nil {
			t.Error(err)
		}
	}
	w := apiRequest(a, "POST", "/api/public/invitations/"+token+"/redeem", "", redeemBody("Changed Server", newUUID()), nil)
	if w.Code != 201 || responseData(t, w)["status"] != "failed" {
		t.Fatal(w.Code, w.Body.String())
	}
	job, err := a.loadRedemption(t.Context(), responseData(t, w)["id"].(string))
	if err != nil || job.Steps[0].RemoteID != "new-user" {
		t.Fatal(job, err)
	}
	f.mu.Lock()
	policies := f.policies
	f.mu.Unlock()
	if policies != 0 {
		t.Fatal("changed credentials allowed subsequent policy writes")
	}
}

func TestProvisioningShutdownCancelsAndPersistsFailure(t *testing.T) {
	a, s := testApp(t)
	admin, _ := bootstrapOwner(t, a)
	f := newProvisioningFixture(t, "")
	_, token, _ := prepareInvitation(t, a, admin, f)
	started, release := make(chan struct{}), make(chan struct{})
	var once sync.Once
	defer once.Do(func() { close(release) })
	f.beforeCreateReply = func() { close(started); <-release }
	path := "/api/public/invitations/" + token + "/redeem"
	done := make(chan *httptest.ResponseRecorder, 1)
	go func() { done <- apiRequest(a, "POST", path, "", redeemBody("Stopping Recipient", newUUID()), nil) }()
	select {
	case <-started:
	case <-time.After(5 * time.Second):
		t.Fatal("provider did not start")
	}
	closed := make(chan struct{})
	go func() { a.CloseProvisioning(); close(closed) }()
	select {
	case <-closed:
	case <-time.After(5 * time.Second):
		t.Fatal("provisioning did not stop")
	}
	once.Do(func() { close(release) })
	select {
	case w := <-done:
		if w.Code != 201 || responseData(t, w)["status"] != "failed" {
			t.Fatal(w.Code, w.Body.String())
		}
	case <-time.After(time.Second):
		t.Fatal("request did not finish")
	}
	if w := apiRequest(a, "POST", path, "", redeemBody("Late Recipient", newUUID()), nil); w.Code != 503 {
		t.Fatal(w.Code, w.Body.String())
	}
	var status string
	if err := s.reader.QueryRow("SELECT status FROM provisioning_jobs").Scan(&status); err != nil || status != "failed" {
		t.Fatal("shutdown closed writer before failure checkpoint", status, err)
	}
}

func TestInvitationAllLibrariesIsExplicitAndUnsupportedProvidersAreRejected(t *testing.T) {
	a, _ := testApp(t)
	admin, _ := bootstrapOwner(t, a)
	f := newProvisioningFixture(t, "")
	id := createManagedServer(t, a, admin, "jellyfin", f.server.URL)
	body := map[string]any{"expires_at": time.Now().Add(time.Hour).UTC().Format(time.RFC3339Nano), "max_uses": 1, "grants": []InvitationGrant{{ServerID: id, AllLibraries: true}}}
	w := apiRequest(a, "POST", "/api/invitations", admin, body, nil)
	if w.Code != 201 {
		t.Fatal(w.Code, w.Body.String())
	}
	inviteID := int64(responseData(t, w)["id"].(float64))
	if w := apiRequest(a, "DELETE", fmt.Sprintf("/api/servers/%d", id), admin, nil, nil); w.Code != 409 {
		t.Fatal("server referenced only by invitation must not be deleted", w.Code, w.Body.String())
	}
	if w := apiRequest(a, "DELETE", fmt.Sprintf("/api/invitations/%d", inviteID), admin, nil, nil); w.Code != 200 {
		t.Fatal(w.Code)
	}
	// Every compiled provider now supports invitations (Plex since 2026-11-07),
	// so there is no unsupported provider left to reject here.
	body["grants"] = []InvitationGrant{{ServerID: id, AllLibraries: true}}
	// Discord sign-in is a supported condition, refused until verified OAuth is configured.
	body["require_discord_auth"] = true
	if w := apiRequest(a, "POST", "/api/invitations", admin, body, nil); w.Code != 409 || !strings.Contains(w.Body.String(), "DISCORD_NOT_CONFIGURED") {
		t.Fatal("unconfigured Discord requirement was silently accepted", w.Code, w.Body.String())
	}
	for _, path := range []string{"/api/invitations?before=invalid", "/api/provisioning-jobs?before=0"} {
		if w := apiRequest(a, "GET", path, admin, nil, nil); w.Code != 400 {
			t.Fatal(w.Code, w.Body.String())
		}
	}
}
