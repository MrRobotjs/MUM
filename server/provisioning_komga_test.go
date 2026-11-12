package main

import (
	"app/server/providers/komga"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"
)

type komgaProvisionFixture struct {
	server                           *httptest.Server
	mu                               sync.Mutex
	mode, email                      string
	created, absent, all             bool
	roles, libraries, allow, exclude []string
	age                              *komga.AgeRestriction
	creates, passwords, patches      int
	lastPassword                     string
	beforeInspect                    func()
}

func (f *komgaProvisionFixture) snapshot() map[string]any {
	roles := slices.Clone(f.roles)
	row := map[string]any{"id": "komga-user", "email": f.email, "roles": roles, "sharedAllLibraries": f.all, "sharedLibrariesIds": f.libraries, "labelsAllow": f.allow, "labelsExclude": f.exclude}
	if f.age != nil {
		row["ageRestriction"] = f.age
	}
	switch f.mode {
	case "admin":
		row["roles"] = append(roles, "ADMIN")
	case "unknown_role":
		row["roles"] = append(roles, "SUPERUSER")
	case "missing_roles":
		delete(row, "roles")
	case "missing_labels":
		delete(row, "labelsExclude")
	case "null_all":
		row["sharedAllLibraries"] = nil
	case "renamed":
		row["email"] = "someone-else@example.invalid"
	case "malformed_age":
		row["ageRestriction"] = map[string]int{"age": 12}
	}
	return row
}
func newKomgaProvisionFixture(t *testing.T, mode string) *komgaProvisionFixture {
	f := &komgaProvisionFixture{mode: mode, allow: []string{}, exclude: []string{}}
	f.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-API-Key") != "fixture-secret" || r.URL.RawQuery != "" {
			t.Error("bad auth or query credentials")
			http.Error(w, "bad key", 401)
			return
		}
		f.mu.Lock()
		hook := f.beforeInspect
		f.mu.Unlock()
		if r.Method == "GET" && r.URL.Path == "/proxy/api/v2/users" && hook != nil {
			hook()
		}
		f.mu.Lock()
		defer f.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		switch r.Method + " " + r.URL.Path {
		case "GET /proxy/api/v1/libraries":
			fmt.Fprint(w, `[{"id":"komga-shelf","name":"Comics"}]`)
		case "GET /proxy/api/v2/users":
			if f.mode == "broken_prefix" {
				http.NotFound(w, r)
				return
			}
			if f.mode == "null_users" {
				fmt.Fprint(w, `null`)
				return
			}
			rows := []map[string]any{}
			if f.created && !f.absent {
				rows = append(rows, f.snapshot())
			}
			if f.mode == "duplicate" && len(rows) > 0 {
				rows = append(rows, f.snapshot())
			}
			_ = json.NewEncoder(w).Encode(rows)
		case "POST /proxy/api/v2/users":
			var body struct {
				Email, Password string
				Roles           []string
				SharedLibraries komga.LibraryGrant
			}
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Error(err)
			}
			if !komga.ValidEmail(body.Email) || len(body.Password) < 32 || len(body.Password) > 72 || body.Password == invitationPassword || len(body.Roles) != 0 || body.SharedLibraries.All || len(body.SharedLibraries.IDs) != 0 {
				t.Error("unsafe create")
			}
			f.created = true
			f.email = body.Email
			f.roles = []string{"USER"}
			f.libraries = []string{}
			f.creates++
			if f.mode == "create" {
				http.Error(w, "private upstream error", 503)
				return
			}
			w.WriteHeader(201)
			_ = json.NewEncoder(w).Encode(f.snapshot())
		case "PATCH /proxy/api/v2/users/komga-user":
			var body struct {
				Roles           []string
				SharedLibraries komga.LibraryGrant
			}
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Error(err)
			}
			if slices.Contains(body.Roles, "USER") || slices.Contains(body.Roles, "ADMIN") {
				t.Error("unsafe role update")
			}
			f.patches++
			if f.mode != "ignored_grant" {
				f.roles = append([]string{"USER"}, body.Roles...)
				f.all = body.SharedLibraries.All
				f.libraries = body.SharedLibraries.IDs
			}
			if f.mode == "grant" && slices.Contains(body.Roles, "PAGE_STREAMING") || f.mode == "revoke" && len(body.Roles) == 0 {
				http.Error(w, "uncertain sharing update", 503)
				return
			}
			w.WriteHeader(204)
		case "PATCH /proxy/api/v2/users/komga-user/password":
			var body struct{ Password string }
			_ = json.NewDecoder(r.Body).Decode(&body)
			if len(f.roles) != 1 || f.all || len(f.libraries) != 0 || len(body.Password) < 12 || len(body.Password) > 72 {
				t.Error("password changed without verified media revocation")
			}
			f.passwords++
			f.lastPassword = body.Password
			if f.mode == "password" {
				http.Error(w, "uncertain password", 503)
				return
			}
			w.WriteHeader(204)
		default:
			t.Error("unexpected Komga endpoint", r.Method, r.URL.Path)
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(f.server.Close)
	return f
}
func komgaInvitation(t *testing.T, a *App, admin string, f *komgaProvisionFixture, all bool) (string, int64) {
	t.Helper()
	w := apiRequest(a, "POST", "/api/servers", admin, map[string]any{"server_nickname": "Komga " + f.server.URL, "service_type": "komga", "url": f.server.URL + "/proxy", "api_key": "fixture-secret"}, nil)
	if w.Code != 201 {
		t.Fatal(w.Code, w.Body.String())
	}
	id := int64(responseData(t, w)["id"].(float64))
	if w := apiRequest(a, "POST", fmt.Sprintf("/api/servers/%d/sync", id), admin, nil, nil); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	ids := []string{}
	if !all {
		ids = []string{"komga-shelf"}
	}
	w = apiRequest(a, "POST", "/api/invitations", admin, map[string]any{"expires_at": time.Now().Add(time.Hour).UTC().Format(time.RFC3339Nano), "max_uses": 1, "grants": []InvitationGrant{{ServerID: id, AllLibraries: all, LibraryIDs: ids, AllowDownloads: all}}}, nil)
	if w.Code != 201 {
		t.Fatal(w.Code, w.Body.String())
	}
	return "/api/public/invitations/" + responseData(t, w)["token"].(string) + "/redeem", id
}
func komgaRedemption(id int64) map[string]any {
	body := redeemBody("KomgaLocal", newUUID())
	body["server_credentials"] = []redemptionCredentials{{id, "reader@example.invalid", invitationPassword}}
	return body
}
func failedKomgaJob(t *testing.T, a *App, admin string, f *komgaProvisionFixture) (redemptionJob, string, map[string]any, int64) {
	t.Helper()
	path, id := komgaInvitation(t, a, admin, f, false)
	body := komgaRedemption(id)
	body["username"] = fmt.Sprintf("KomgaLocal%d", id)
	w := apiRequest(a, "POST", path, "", body, nil)
	if w.Code != 201 || responseData(t, w)["status"] != "failed" {
		t.Fatal(w.Code, w.Body.String())
	}
	return currentReview(t, a, responseData(t, w)["id"].(string)), path, body, id
}

func TestKomgaProvisioningUsesEmailAndVerifiedRestrictedCreation(t *testing.T) {
	for _, all := range []bool{false, true} {
		t.Run(fmt.Sprint(all), func(t *testing.T) {
			a, s := testApp(t)
			admin, _ := bootstrapOwner(t, a)
			f := newKomgaProvisionFixture(t, "")
			path, id := komgaInvitation(t, a, admin, f, all)
			body := komgaRedemption(id)
			w := apiRequest(a, "POST", path, "", body, nil)
			if w.Code != 201 || responseData(t, w)["status"] != "completed" {
				t.Fatal(w.Code, w.Body.String())
			}
			if w := apiRequest(a, "POST", path, "", body, nil); w.Code != 200 {
				t.Fatal(w.Code)
			}
			var remote string
			if err := s.reader.QueryRow("SELECT external_username FROM service_accounts WHERE server_id=?", id).Scan(&remote); err != nil || remote != "reader@example.invalid" {
				t.Fatal(remote, err)
			}
			f.mu.Lock()
			defer f.mu.Unlock()
			if f.creates != 1 || f.passwords != 1 || f.all != all || !slices.Contains(f.roles, "PAGE_STREAMING") || slices.Contains(f.roles, "FILE_DOWNLOAD") != all {
				t.Fatal("wrong roles or duplicate writes")
			}
		})
	}
}
func TestKomgaFailureRetainsCapacityAndNeverRecreates(t *testing.T) {
	for _, mode := range []string{"create", "password", "grant", "ignored_grant"} {
		t.Run(mode, func(t *testing.T) {
			a, _ := testApp(t)
			admin, _ := bootstrapOwner(t, a)
			f := newKomgaProvisionFixture(t, mode)
			job, path, body, _ := failedKomgaJob(t, a, admin, f)
			if !job.Reserved {
				t.Fatal(job)
			}
			if w := apiRequest(a, "POST", path, "", body, nil); w.Code != 200 {
				t.Fatal(w.Code)
			}
			f.mu.Lock()
			defer f.mu.Unlock()
			if f.creates != 1 {
				t.Fatal("uncertain create replayed")
			}
		})
	}
}
func TestKomgaRevocationScopeAndResumePreserveContentRestrictions(t *testing.T) {
	a, s := testApp(t)
	admin, _ := bootstrapOwner(t, a)
	f := newKomgaProvisionFixture(t, "grant")
	job, receipt, original, id := failedKomgaJob(t, a, admin, f)
	if w := apiRequest(a, "POST", fmt.Sprintf("/api/servers/%d/sync", id), admin, nil, nil); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	var uuid, hash string
	if err := s.reader.QueryRow("SELECT uuid FROM service_accounts WHERE server_id=?", id).Scan(&uuid); err != nil {
		t.Fatal(err)
	}
	if err := s.reader.QueryRow("SELECT password_hash FROM user_accounts WHERE uuid=?", job.UserUUID).Scan(&hash); err != nil {
		t.Fatal(err)
	}
	f.mu.Lock()
	f.mode = ""
	f.roles = append(f.roles, "FILE_DOWNLOAD", "KOBO_SYNC")
	f.age = &komga.AgeRestriction{Age: 12, Restriction: "ALLOW_ONLY"}
	f.allow = []string{"kids"}
	f.exclude = []string{"private"}
	f.mu.Unlock()
	path := "/api/provisioning-jobs/" + job.ID
	w := apiRequest(a, "POST", path+"/disable-accounts", admin, reviewBody(job), nil)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	steps := responseData(t, w)["steps"].([]any)
	if steps[0].(map[string]any)["cleanup_scope"] != "media" {
		t.Fatal("revocation mislabeled as account disable")
	}
	job = currentReview(t, a, job.ID)
	if job.Steps[0].Cleanup != "disabled" {
		t.Fatal(job)
	}
	if w := apiRequest(a, "POST", fmt.Sprintf("/api/servers/%d/sync", id), admin, nil, nil); w.Code != 200 {
		t.Fatal(w.Code)
	}
	var active bool
	if err := s.reader.QueryRow("SELECT is_active FROM service_accounts WHERE server_id=?", id).Scan(&active); err != nil || active {
		t.Fatal("fresh sync restored revoked access", err)
	}
	w = apiRequest(a, "POST", path+"/resume", admin, resumeBody(job, []int64{id}), nil)
	if w.Code != 200 || responseData(t, w)["status"] != "completed" {
		t.Fatal(w.Code, w.Body.String())
	}
	var currentUUID, currentHash string
	if err := s.reader.QueryRow("SELECT uuid FROM service_accounts WHERE server_id=?", id).Scan(&currentUUID); err != nil || currentUUID != uuid {
		t.Fatal("service identity changed", err)
	}
	if err := s.reader.QueryRow("SELECT password_hash FROM user_accounts WHERE uuid=?", job.UserUUID).Scan(&currentHash); err != nil || currentHash != hash {
		t.Fatal("local password changed", err)
	}
	f.mu.Lock()
	correct := f.creates == 1 && f.passwords == 2 && slices.Equal(f.roles, []string{"USER", "PAGE_STREAMING"}) && slices.Equal(f.libraries, []string{"komga-shelf"}) && !f.all && f.age.Age == 12 && slices.Equal(f.allow, []string{"kids"}) && slices.Equal(f.exclude, []string{"private"})
	f.mu.Unlock()
	if !correct {
		t.Fatal("grants/content changed unexpectedly")
	}
	if w := apiRequest(a, "POST", receipt, "", original, nil); w.Code != 200 || responseData(t, w)["status"] != "completed" {
		t.Fatal(w.Code, w.Body.String())
	}
}
func TestKomgaRecoveryGuardsBeforeMutation(t *testing.T) {
	for _, mode := range []string{"admin", "unknown_role", "missing_roles", "missing_labels", "null_all", "renamed", "malformed_age", "duplicate", "null_users", "broken_prefix", "configuration", "long_password"} {
		t.Run(mode, func(t *testing.T) {
			a, s := testApp(t)
			admin, _ := bootstrapOwner(t, a)
			f := newKomgaProvisionFixture(t, "grant")
			job, _, _, id := failedKomgaJob(t, a, admin, f)
			f.mu.Lock()
			f.mode = mode
			patches, passwords := f.patches, f.passwords
			f.mu.Unlock()
			if mode == "configuration" {
				if _, err := s.writer.Exec("UPDATE media_servers SET revision=revision+1,api_key='changed-key' WHERE id=?", id); err != nil {
					t.Fatal(err)
				}
			}
			decision := resumeBody(job, []int64{id})
			if mode == "long_password" {
				decision["server_passwords"] = []resumePassword{{id, strings.Repeat("é", 37)}}
			}
			if w := apiRequest(a, "POST", "/api/provisioning-jobs/"+job.ID+"/resume", admin, decision, nil); w.Code == 200 || mode == "long_password" && w.Code != 400 {
				t.Fatal("unsafe resumption")
			}
			f.mu.Lock()
			changed := f.patches != patches || f.passwords != passwords
			f.mu.Unlock()
			if changed || !currentReview(t, a, job.ID).Reserved {
				t.Fatal("unsafe mutation or reservation release")
			}
		})
	}
}
func TestKomgaEmailAndBcryptLimitsBeforeReservation(t *testing.T) {
	a, s := testApp(t)
	admin, _ := bootstrapOwner(t, a)
	f := newKomgaProvisionFixture(t, "")
	path, id := komgaInvitation(t, a, admin, f, false)
	for _, identity := range []string{"LocalName", "reader@localhost", "", "not an email"} {
		body := komgaRedemption(id)
		body["server_credentials"] = []redemptionCredentials{{id, identity, invitationPassword}}
		if w := apiRequest(a, "POST", path, "", body, nil); w.Code != 400 {
			t.Fatal(w.Code, w.Body.String())
		}
	}
	body := komgaRedemption(id)
	body["server_credentials"] = []redemptionCredentials{{id, "reader@example.invalid", strings.Repeat("é", 37)}}
	if w := apiRequest(a, "POST", path, "", body, nil); w.Code != 400 {
		t.Fatal(w.Code, w.Body.String())
	}
	var jobs int
	if err := s.reader.QueryRow("SELECT count(*) FROM provisioning_jobs").Scan(&jobs); err != nil || jobs != 0 {
		t.Fatal(jobs, err)
	}
	body = komgaRedemption(id)
	body["password"] = strings.Repeat("x", 100)
	body["server_credentials"] = []redemptionCredentials{{id, "reader@example.invalid", strings.Repeat("é", 36)}}
	if w := apiRequest(a, "POST", path, "", body, nil); w.Code != 201 || responseData(t, w)["status"] != "completed" {
		t.Fatal(w.Code, w.Body.String())
	}
}
func TestKomgaUncertainPasswordAndUnknownCreateRequireExplicitActions(t *testing.T) {
	a, _ := testApp(t)
	admin, _ := bootstrapOwner(t, a)
	f := newKomgaProvisionFixture(t, "grant")
	job, _, _, id := failedKomgaJob(t, a, admin, f)
	f.mu.Lock()
	f.mode = "password"
	f.mu.Unlock()
	path := "/api/provisioning-jobs/" + job.ID
	if w := apiRequest(a, "POST", path+"/resume", admin, resumeBody(job, []int64{id}), nil); w.Code != 502 {
		t.Fatal(w.Code, w.Body.String())
	}
	job = currentReview(t, a, job.ID)
	if !job.Reserved || job.Steps[0].ResumeState != "unknown" {
		t.Fatal(job)
	}
	if err := a.recoverProvisioning(t.Context()); err != nil {
		t.Fatal(err)
	}
	f.mu.Lock()
	writes := f.passwords
	f.mode = ""
	f.mu.Unlock()
	if writes != 2 {
		t.Fatal("startup replayed password")
	}
	if w := apiRequest(a, "POST", path+"/resume", admin, resumeBody(job, []int64{id}), nil); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	unknown := newKomgaProvisionFixture(t, "create")
	other, _, _, otherID := failedKomgaJob(t, a, admin, unknown)
	if w := apiRequest(a, "POST", "/api/provisioning-jobs/"+other.ID+"/resume", admin, resumeBody(other, []int64{otherID}), nil); w.Code != 409 {
		t.Fatal("unknown identity adopted", w.Code)
	}
}
func TestKomgaAbsentOrRevokedAccountPermitsCancellation(t *testing.T) {
	for _, absent := range []bool{false, true} {
		t.Run(fmt.Sprint(absent), func(t *testing.T) {
			a, _ := testApp(t)
			admin, _ := bootstrapOwner(t, a)
			f := newKomgaProvisionFixture(t, "grant")
			job, _, _, _ := failedKomgaJob(t, a, admin, f)
			f.mu.Lock()
			f.mode = ""
			f.absent = absent
			f.mu.Unlock()
			path := "/api/provisioning-jobs/" + job.ID
			if w := apiRequest(a, "POST", path+"/disable-accounts", admin, reviewBody(job), nil); w.Code != 200 {
				t.Fatal(w.Code, w.Body.String())
			}
			job = currentReview(t, a, job.ID)
			if w := apiRequest(a, "POST", path+"/cancel", admin, reviewBody(job), nil); w.Code != 200 || responseData(t, w)["status"] != "cancelled" {
				t.Fatal(w.Code, w.Body.String())
			}
		})
	}
}
func TestKomgaRevisionRaceRejectsSharingMutation(t *testing.T) {
	a, s := testApp(t)
	admin, _ := bootstrapOwner(t, a)
	f := newKomgaProvisionFixture(t, "grant")
	job, _, _, id := failedKomgaJob(t, a, admin, f)
	var once sync.Once
	f.mu.Lock()
	f.mode = ""
	patches := f.patches
	f.beforeInspect = func() {
		once.Do(func() {
			if err := s.write(t.Context(), func(tx *sql.Tx) error {
				_, err := tx.Exec("UPDATE media_servers SET revision=revision+1 WHERE id=?", id)
				return err
			}); err != nil {
				t.Error(err)
			}
		})
	}
	f.mu.Unlock()
	if w := apiRequest(a, "POST", "/api/provisioning-jobs/"+job.ID+"/resume", admin, resumeBody(job, []int64{id}), nil); w.Code != 409 {
		t.Fatal(w.Code, w.Body.String())
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.patches != patches {
		t.Fatal("stale revision changed sharing")
	}
}

func TestKomgaUncertainRevocationRequiresFreshVerification(t *testing.T) {
	a, _ := testApp(t)
	admin, _ := bootstrapOwner(t, a)
	f := newKomgaProvisionFixture(t, "grant")
	job, _, _, _ := failedKomgaJob(t, a, admin, f)
	f.mu.Lock()
	f.mode = "revoke"
	f.mu.Unlock()
	path := "/api/provisioning-jobs/" + job.ID + "/disable-accounts"
	if w := apiRequest(a, "POST", path, admin, reviewBody(job), nil); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	job = currentReview(t, a, job.ID)
	if !job.Reserved || job.Steps[0].Cleanup != "failed" {
		t.Fatal("uncertain sharing write called verified", job)
	}
	f.mu.Lock()
	f.mode = ""
	f.mu.Unlock()
	if w := apiRequest(a, "POST", path, admin, reviewBody(job), nil); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	if currentReview(t, a, job.ID).Steps[0].Cleanup != "disabled" {
		t.Fatal("revocation not reconciled")
	}
}

func TestMixedKomgaABSJobPreflightsEveryIdentityBeforeWrites(t *testing.T) {
	a, _ := testApp(t)
	admin, _ := bootstrapOwner(t, a)
	first := newABSProvisionFixture(t, "")
	second := newKomgaProvisionFixture(t, "grant")
	firstID := createManagedServer(t, a, admin, "audiobookshelf", first.server.URL+"/proxy")
	secondID := createManagedServer(t, a, admin, "komga", second.server.URL+"/proxy")
	for _, id := range []int64{firstID, secondID} {
		if w := apiRequest(a, "POST", fmt.Sprintf("/api/servers/%d/sync", id), admin, nil, nil); w.Code != 200 {
			t.Fatal(w.Code, w.Body.String())
		}
	}
	w := apiRequest(a, "POST", "/api/invitations", admin, map[string]any{"expires_at": time.Now().Add(time.Hour).UTC().Format(time.RFC3339Nano), "max_uses": 1, "grants": []InvitationGrant{{ServerID: firstID, LibraryIDs: []string{"abs-books"}}, {ServerID: secondID, LibraryIDs: []string{"komga-shelf"}}}}, nil)
	if w.Code != 201 {
		t.Fatal(w.Code, w.Body.String())
	}
	body := redeemBody("MixedLocal", newUUID())
	body["server_credentials"] = []redemptionCredentials{{firstID, "ABSReader", invitationPassword}, {secondID, "reader@example.invalid", invitationPassword}}
	w = apiRequest(a, "POST", "/api/public/invitations/"+responseData(t, w)["token"].(string)+"/redeem", "", body, nil)
	if w.Code != 201 || responseData(t, w)["status"] != "failed" {
		t.Fatal(w.Code, w.Body.String())
	}
	job := currentReview(t, a, responseData(t, w)["id"].(string))
	second.mu.Lock()
	second.mode = "admin"
	second.mu.Unlock()
	path := "/api/provisioning-jobs/" + job.ID + "/resume"
	if w := apiRequest(a, "POST", path, admin, resumeBody(job, []int64{firstID, secondID}), nil); w.Code == 200 {
		t.Fatal("privileged second target accepted")
	}
	first.mu.Lock()
	passwords := first.passwords
	first.mu.Unlock()
	if passwords != 1 {
		t.Fatal("first target changed before all preflight checks")
	}
	second.mu.Lock()
	second.mode = ""
	second.mu.Unlock()
	job = currentReview(t, a, job.ID)
	if w := apiRequest(a, "POST", path, admin, resumeBody(job, []int64{firstID, secondID}), nil); w.Code != 200 || responseData(t, w)["status"] != "completed" {
		t.Fatal(w.Code, w.Body.String())
	}
}
