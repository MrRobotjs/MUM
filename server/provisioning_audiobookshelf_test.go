package main

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"maps"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"
)

type absProvisionFixture struct {
	server                      *httptest.Server
	mu                          sync.Mutex
	mode, name                  string
	created, active, absent     bool
	permissions                 map[string]bool
	libraries, tags             []string
	creates, passwords, patches int
	lastPassword                string
	beforeInspect               func()
}

func (f *absProvisionFixture) snapshot() map[string]any {
	permissions := map[string]any{}
	for key, value := range f.permissions {
		permissions[key] = value
	}
	user := map[string]any{"id": "abs-user", "username": f.name, "type": "user", "isActive": f.active, "isLocked": false, "hasOpenIDLink": false, "permissions": permissions, "librariesAccessible": f.libraries, "itemTagsSelected": f.tags, "token": "private-abs-token"}
	switch f.mode {
	case "admin", "root", "guest":
		user["type"] = f.mode
	case "oidc":
		user["hasOpenIDLink"] = true
	case "locked":
		user["isLocked"] = true
	case "renamed":
		user["username"] = "OtherReader"
	case "missing_policy":
		delete(permissions, "download")
	case "null_permission":
		permissions["download"] = nil
	case "unknown_permission":
		permissions["superuser"] = true
	case "missing_identity":
		delete(user, "hasOpenIDLink")
	}
	return user
}

func newABSProvisionFixture(t *testing.T, mode string) *absProvisionFixture {
	f := &absProvisionFixture{mode: mode}
	f.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer fixture-secret" || r.URL.RawQuery != "" {
			t.Error("missing Bearer header or unexpected query")
			http.Error(w, "bad key", 401)
			return
		}
		f.mu.Lock()
		hook := f.beforeInspect
		f.mu.Unlock()
		if r.Method == "GET" && r.URL.Path == "/proxy/api/users" && hook != nil {
			hook()
		}
		f.mu.Lock()
		defer f.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		switch r.Method + " " + r.URL.Path {
		case "GET /proxy/api/libraries":
			fmt.Fprint(w, `{"libraries":[{"id":"abs-books","name":"Books","mediaType":"book"}]}`)
		case "GET /proxy/api/users":
			if f.mode == "broken_prefix" {
				http.NotFound(w, r)
				return
			}
			if f.mode == "null_users" {
				fmt.Fprint(w, `{"users":null}`)
				return
			}
			users := []map[string]any{}
			if f.created && !f.absent {
				users = append(users, f.snapshot())
			}
			if f.mode == "duplicate" && len(users) > 0 {
				users = append(users, f.snapshot())
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"users": users})
		case "POST /proxy/api/users":
			var body struct {
				Username, Password, Type              string
				IsActive                              bool
				Permissions                           map[string]bool
				LibrariesAccessible, ItemTagsSelected []string
			}
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Error(err)
			}
			if body.Username == "" || body.Type != "user" || body.IsActive || len(body.Password) < 32 || body.Password == invitationPassword || body.Permissions["update"] || body.Permissions["delete"] || body.Permissions["upload"] || body.Permissions["createEreader"] {
				t.Error("unsafe account creation", body.Type, body.IsActive)
			}
			f.created = true
			f.creates++
			f.name = body.Username
			f.permissions = body.Permissions
			f.libraries = body.LibrariesAccessible
			f.tags = body.ItemTagsSelected
			if f.mode == "active_create" {
				f.active = true
			}
			if f.mode == "create" {
				http.Error(w, "private-abs-token uncertain create", 503)
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"user": f.snapshot()})
		case "PATCH /proxy/api/users/abs-user":
			var body map[string]json.RawMessage
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Error(err)
			}
			f.patches++
			if _, ok := body["username"]; ok {
				t.Error("unexpected identity update")
			}
			if _, ok := body["email"]; ok {
				t.Error("unexpected email update")
			}
			if value, ok := body["permissions"]; ok {
				if f.mode != "ignore_permissions" {
					_ = json.Unmarshal(value, &f.permissions)
				}
			}
			if value, ok := body["librariesAccessible"]; ok {
				_ = json.Unmarshal(value, &f.libraries)
			}
			if value, ok := body["itemTagsSelected"]; ok {
				_ = json.Unmarshal(value, &f.tags)
			}
			if value, ok := body["password"]; ok {
				if f.active {
					t.Error("password changed before disabling")
				}
				_ = json.Unmarshal(value, &f.lastPassword)
				f.passwords++
				if f.mode == "password" {
					http.Error(w, "private-abs-token uncertain password", 503)
					return
				}
			}
			if value, ok := body["isActive"]; ok {
				_ = json.Unmarshal(value, &f.active)
				if f.mode == "enable" && f.active || f.mode == "disable" && !f.active {
					http.Error(w, "private-abs-token uncertain active flag", 503)
					return
				}
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"user": f.snapshot()})
		default:
			t.Error("unexpected Audiobookshelf request", r.Method, r.URL.Path)
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(f.server.Close)
	return f
}

func absInvitation(t *testing.T, a *App, admin string, f *absProvisionFixture, all bool) (string, int64) {
	t.Helper()
	wServer := apiRequest(a, "POST", "/api/servers", admin, map[string]any{"server_nickname": "ABS fixture " + f.server.URL, "service_type": "audiobookshelf", "url": f.server.URL + "/proxy", "api_key": "fixture-secret"}, nil)
	if wServer.Code != 201 {
		t.Fatal(wServer.Code, wServer.Body.String())
	}
	id := int64(responseData(t, wServer)["id"].(float64))
	if w := apiRequest(a, "POST", fmt.Sprintf("/api/servers/%d/sync", id), admin, nil, nil); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	ids := []string{}
	if !all {
		ids = []string{"abs-books"}
	}
	w := apiRequest(a, "POST", "/api/invitations", admin, map[string]any{"expires_at": time.Now().Add(time.Hour).UTC().Format(time.RFC3339Nano), "max_uses": 1, "grants": []InvitationGrant{{ServerID: id, AllLibraries: all, LibraryIDs: ids, AllowDownloads: all}}}, nil)
	if w.Code != 201 {
		t.Fatal(w.Code, w.Body.String())
	}
	return "/api/public/invitations/" + responseData(t, w)["token"].(string) + "/redeem", id
}

func failedABSJob(t *testing.T, a *App, admin string, f *absProvisionFixture) (redemptionJob, string, map[string]any, int64) {
	t.Helper()
	path, id := absInvitation(t, a, admin, f, false)
	body := redeemBody("ABSReader", newUUID())
	w := apiRequest(a, "POST", path, "", body, nil)
	if w.Code != 201 || responseData(t, w)["status"] != "failed" {
		t.Fatal(w.Code, w.Body.String())
	}
	return currentReview(t, a, responseData(t, w)["id"].(string)), path, body, id
}

func TestABSProvisioningStartsInactiveAndVerifiesExplicitGrants(t *testing.T) {
	for _, all := range []bool{false, true} {
		t.Run(fmt.Sprint(all), func(t *testing.T) {
			a, s := testApp(t)
			admin, _ := bootstrapOwner(t, a)
			f := newABSProvisionFixture(t, "")
			path, id := absInvitation(t, a, admin, f, all)
			body := redeemBody("ABSReader", newUUID())
			w := apiRequest(a, "POST", path, "", body, nil)
			if w.Code != 201 || responseData(t, w)["status"] != "completed" || strings.Contains(w.Body.String(), "private-abs-token") {
				t.Fatal(w.Code, w.Body.String())
			}
			if w := apiRequest(a, "POST", path, "", body, nil); w.Code != 200 {
				t.Fatal(w.Code)
			}
			var links int
			if err := s.reader.QueryRow("SELECT count(*) FROM service_links l JOIN service_accounts a ON a.uuid=l.service_uuid WHERE a.server_id=? AND a.external_user_id='abs-user'", id).Scan(&links); err != nil || links != 1 {
				t.Fatal(links, err)
			}
			f.mu.Lock()
			defer f.mu.Unlock()
			if f.creates != 1 || f.passwords != 1 || !f.active || f.lastPassword != invitationPassword || f.permissions["download"] != all || f.permissions["accessAllLibraries"] != all {
				t.Fatal("incorrect provisioning")
			}
		})
	}
}

func TestABSFailuresRetainReservationWithoutCreateReplay(t *testing.T) {
	for _, mode := range []string{"create", "password", "enable", "active_create"} {
		t.Run(mode, func(t *testing.T) {
			a, _ := testApp(t)
			admin, _ := bootstrapOwner(t, a)
			f := newABSProvisionFixture(t, mode)
			job, path, body, _ := failedABSJob(t, a, admin, f)
			if !job.Reserved {
				t.Fatal(job)
			}
			if w := apiRequest(a, "POST", path, "", body, nil); w.Code != 200 || responseData(t, w)["status"] != "failed" {
				t.Fatal(w.Code, w.Body.String())
			}
			f.mu.Lock()
			defer f.mu.Unlock()
			if f.creates != 1 {
				t.Fatal("uncertain create replayed")
			}
		})
	}
}

func TestABSDisableAndResumePreserveContentRestrictionsAndLocalIdentity(t *testing.T) {
	a, s := testApp(t)
	admin, _ := bootstrapOwner(t, a)
	f := newABSProvisionFixture(t, "enable")
	job, receipt, body, id := failedABSJob(t, a, admin, f)
	if w := apiRequest(a, "POST", fmt.Sprintf("/api/servers/%d/sync", id), admin, nil, nil); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	var uuid, hash string
	_ = s.reader.QueryRow("SELECT uuid FROM service_accounts WHERE server_id=?", id).Scan(&uuid)
	_ = s.reader.QueryRow("SELECT password_hash FROM user_accounts WHERE uuid=?", job.UserUUID).Scan(&hash)
	f.mu.Lock()
	f.mode = ""
	f.permissions["accessAllTags"] = false
	f.permissions["accessExplicitContent"] = true
	f.permissions["selectedTagsNotAccessible"] = true
	f.permissions["update"] = true
	f.tags = []string{"restricted"}
	f.libraries = []string{"abs-books", "other-library"}
	before := maps.Clone(f.permissions)
	f.mu.Unlock()
	path := "/api/provisioning-jobs/" + job.ID
	if w := apiRequest(a, "POST", path+"/disable-accounts", admin, reviewBody(job), nil); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	job = currentReview(t, a, job.ID)
	if job.Steps[0].Cleanup != "disabled" {
		t.Fatal(job)
	}
	f.mu.Lock()
	unchanged := maps.Equal(before, f.permissions) && slices.Equal(f.libraries, []string{"abs-books", "other-library"}) && slices.Equal(f.tags, []string{"restricted"})
	f.mu.Unlock()
	if !unchanged {
		t.Fatal("disable changed content or access policy")
	}
	w := apiRequest(a, "POST", path+"/resume", admin, resumeBody(job, []int64{id}), nil)
	if w.Code != 200 || responseData(t, w)["status"] != "completed" {
		t.Fatal(w.Code, w.Body.String())
	}
	var actualUUID, actualHash string
	var active bool
	if err := s.reader.QueryRow("SELECT uuid FROM service_accounts WHERE server_id=?", id).Scan(&actualUUID); err != nil || actualUUID != uuid {
		t.Fatal("service identity changed", err)
	}
	if err := s.reader.QueryRow("SELECT password_hash,is_active FROM user_accounts WHERE uuid=?", job.UserUUID).Scan(&actualHash, &active); err != nil || actualHash != hash || !active {
		t.Fatal("local credentials changed", err)
	}
	f.mu.Lock()
	valid := f.active && f.creates == 1 && f.passwords == 2 && f.lastPassword == fmt.Sprintf("new-server-password-%d", id) && !f.permissions["update"] && !f.permissions["accessAllTags"] && f.permissions["accessExplicitContent"] && f.permissions["selectedTagsNotAccessible"] && slices.Equal(f.tags, []string{"restricted"}) && slices.Equal(f.libraries, []string{"abs-books"})
	f.mu.Unlock()
	if !valid {
		t.Fatal("resumption lost restrictions or replayed create")
	}
	if w := apiRequest(a, "POST", receipt, "", body, nil); w.Code != 200 || responseData(t, w)["status"] != "completed" {
		t.Fatal(w.Code, w.Body.String())
	}
	if w := apiRequest(a, "POST", path+"/resume", admin, resumeBody(job, []int64{id}), nil); w.Code != 409 {
		t.Fatal("completed job repeated")
	}
}

func TestABSRecoveryRejectsUnsafeOrUnverifiableTargetsBeforeMutation(t *testing.T) {
	for _, mode := range []string{"root", "admin", "guest", "oidc", "locked", "renamed", "missing_policy", "null_permission", "unknown_permission", "missing_identity", "duplicate", "null_users", "broken_prefix", "configuration"} {
		t.Run(mode, func(t *testing.T) {
			a, s := testApp(t)
			admin, _ := bootstrapOwner(t, a)
			f := newABSProvisionFixture(t, "enable")
			job, _, _, id := failedABSJob(t, a, admin, f)
			f.mu.Lock()
			f.mode = mode
			patches, passwords := f.patches, f.passwords
			f.mu.Unlock()
			if mode == "configuration" {
				if _, err := s.writer.Exec("UPDATE media_servers SET revision=revision+1,api_key='changed-key' WHERE id=?", id); err != nil {
					t.Fatal(err)
				}
			}
			if w := apiRequest(a, "POST", "/api/provisioning-jobs/"+job.ID+"/resume", admin, resumeBody(job, []int64{id}), nil); w.Code == 200 {
				t.Fatal("unsafe resumption")
			}
			f.mu.Lock()
			mutated := f.patches != patches || f.passwords != passwords
			f.mu.Unlock()
			if mutated || !currentReview(t, a, job.ID).Reserved {
				t.Fatal("unsafe mutation or released reservation")
			}
		})
	}
}

func TestABSUncertainPasswordRequiresExplicitRetryAndNoStartupReplay(t *testing.T) {
	a, _ := testApp(t)
	admin, _ := bootstrapOwner(t, a)
	f := newABSProvisionFixture(t, "enable")
	job, _, _, id := failedABSJob(t, a, admin, f)
	f.mu.Lock()
	f.mode = "password"
	f.mu.Unlock()
	path := "/api/provisioning-jobs/" + job.ID + "/resume"
	if w := apiRequest(a, "POST", path, admin, resumeBody(job, []int64{id}), nil); w.Code != 502 {
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
		t.Fatal("unexpected automatic password replay", writes)
	}
	if w := apiRequest(a, "POST", path, admin, resumeBody(job, []int64{id}), nil); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
}

func TestABSAbsentOrDisabledAccountPermitsCancellation(t *testing.T) {
	for _, absent := range []bool{false, true} {
		t.Run(fmt.Sprint(absent), func(t *testing.T) {
			a, _ := testApp(t)
			admin, _ := bootstrapOwner(t, a)
			f := newABSProvisionFixture(t, "enable")
			job, _, _, _ := failedABSJob(t, a, admin, f)
			f.mu.Lock()
			f.mode = ""
			f.absent = absent
			f.mu.Unlock()
			path := "/api/provisioning-jobs/" + job.ID
			if w := apiRequest(a, "POST", path+"/disable-accounts", admin, reviewBody(job), nil); w.Code != 200 {
				t.Fatal(w.Code, w.Body.String())
			}
			job = currentReview(t, a, job.ID)
			want := "disabled"
			if absent {
				want = "absent"
			}
			if job.Steps[0].Cleanup != want {
				t.Fatal(job)
			}
			if w := apiRequest(a, "POST", path+"/cancel", admin, reviewBody(job), nil); w.Code != 200 || responseData(t, w)["status"] != "cancelled" {
				t.Fatal(w.Code, w.Body.String())
			}
		})
	}
}

func TestABSRecoveryRejectsServerRevisionRace(t *testing.T) {
	a, s := testApp(t)
	admin, _ := bootstrapOwner(t, a)
	f := newABSProvisionFixture(t, "enable")
	job, _, _, id := failedABSJob(t, a, admin, f)
	var once sync.Once
	f.mu.Lock()
	patches := f.patches
	f.mode = ""
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
		t.Fatal("stale revision mutated target")
	}
}

func TestABSUnknownCreateIsNotAdoptedByUsername(t *testing.T) {
	a, _ := testApp(t)
	admin, _ := bootstrapOwner(t, a)
	f := newABSProvisionFixture(t, "create")
	job, _, _, id := failedABSJob(t, a, admin, f)
	if job.Steps[0].RemoteID != "" {
		t.Fatal("uncertain create claimed identity")
	}
	path := "/api/provisioning-jobs/" + job.ID
	if w := apiRequest(a, "POST", path+"/resume", admin, resumeBody(job, []int64{id}), nil); w.Code != 409 {
		t.Fatal(w.Code, w.Body.String())
	}
	job = currentReview(t, a, job.ID)
	body := reviewBody(job)
	body["manual_resolutions"] = []manualReview{{ServerID: id, Reason: "Externally reconciled the timed-out create and confirmed access is revoked"}}
	if w := apiRequest(a, "POST", path+"/cancel", admin, body, nil); w.Code != 200 || responseData(t, w)["status"] != "cancelled" {
		t.Fatal(w.Code, w.Body.String())
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.creates != 1 || f.passwords != 0 || f.patches != 0 {
		t.Fatal("unknown identity was mutated or recreated")
	}
}

func TestABSUncertainDisableRequiresFreshVerification(t *testing.T) {
	a, _ := testApp(t)
	admin, _ := bootstrapOwner(t, a)
	f := newABSProvisionFixture(t, "enable")
	job, _, _, _ := failedABSJob(t, a, admin, f)
	f.mu.Lock()
	f.mode = "disable"
	f.mu.Unlock()
	path := "/api/provisioning-jobs/" + job.ID + "/disable-accounts"
	if w := apiRequest(a, "POST", path, admin, reviewBody(job), nil); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	job = currentReview(t, a, job.ID)
	if !job.Reserved || job.Steps[0].Cleanup != "failed" {
		t.Fatal("uncertain write labeled verified", job)
	}
	f.mu.Lock()
	f.mode = ""
	f.mu.Unlock()
	if w := apiRequest(a, "POST", path, admin, reviewBody(job), nil); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	if currentReview(t, a, job.ID).Steps[0].Cleanup != "disabled" {
		t.Fatal("explicit inspection did not reconcile disable")
	}
}

func TestMixedABSAndJellyfinJobPreflightsAllTargets(t *testing.T) {
	a, _ := testApp(t)
	admin, _ := bootstrapOwner(t, a)
	first := newReviewFixture(t, false)
	second := newABSProvisionFixture(t, "enable")
	firstID := createManagedServer(t, a, admin, "jellyfin", first.server.URL)
	secondID := createManagedServer(t, a, admin, "audiobookshelf", second.server.URL+"/proxy")
	for _, id := range []int64{firstID, secondID} {
		if w := apiRequest(a, "POST", fmt.Sprintf("/api/servers/%d/sync", id), admin, nil, nil); w.Code != 200 {
			t.Fatal(w.Code, w.Body.String())
		}
	}
	w := apiRequest(a, "POST", "/api/invitations", admin, map[string]any{"expires_at": time.Now().Add(time.Hour).UTC().Format(time.RFC3339Nano), "max_uses": 1, "grants": []InvitationGrant{{ServerID: firstID, LibraryIDs: []string{"movies"}}, {ServerID: secondID, LibraryIDs: []string{"abs-books"}}}}, nil)
	if w.Code != 201 {
		t.Fatal(w.Code, w.Body.String())
	}
	w = apiRequest(a, "POST", "/api/public/invitations/"+responseData(t, w)["token"].(string)+"/redeem", "", redeemBody("MixedReader", newUUID()), nil)
	if w.Code != 201 || responseData(t, w)["status"] != "failed" {
		t.Fatal(w.Code, w.Body.String())
	}
	job := currentReview(t, a, responseData(t, w)["id"].(string))
	path := "/api/provisioning-jobs/" + job.ID + "/resume"
	second.mu.Lock()
	second.mode = "admin"
	second.mu.Unlock()
	if w := apiRequest(a, "POST", path, admin, resumeBody(job, []int64{firstID, secondID}), nil); w.Code == 200 {
		t.Fatal("privileged second target accepted")
	}
	first.mu.Lock()
	writes := first.passwordWrites
	first.mu.Unlock()
	if writes != 1 {
		t.Fatal("first target mutated before full preflight")
	}
	second.mu.Lock()
	second.mode = ""
	second.mu.Unlock()
	job = currentReview(t, a, job.ID)
	if w := apiRequest(a, "POST", path, admin, resumeBody(job, []int64{firstID, secondID}), nil); w.Code != 200 || responseData(t, w)["status"] != "completed" {
		t.Fatal(w.Code, w.Body.String())
	}
}

func TestABSBcryptByteLimitBeforeReservationAndRecoveryMutation(t *testing.T) {
	a, s := testApp(t)
	admin, _ := bootstrapOwner(t, a)
	f := newABSProvisionFixture(t, "")
	path, id := absInvitation(t, a, admin, f, false)
	tooLong := strings.Repeat("é", 37)
	body := redeemBody("LongPassword", newUUID())
	body["password"] = tooLong
	if w := apiRequest(a, "POST", path, "", body, nil); w.Code != 400 {
		t.Fatal(w.Code, w.Body.String())
	}
	var jobs int
	if err := s.reader.QueryRow("SELECT count(*) FROM provisioning_jobs").Scan(&jobs); err != nil || jobs != 0 {
		t.Fatal("invalid remote password reserved capacity", jobs, err)
	}
	local := strings.Repeat("x", 100)
	remote := strings.Repeat("é", 36)
	body = redeemBody("SeparatePasswords", newUUID())
	body["password"] = local
	body["server_credentials"] = []redemptionCredentials{{id, "RemoteABS", remote}}
	if w := apiRequest(a, "POST", path, "", body, nil); w.Code != 201 || responseData(t, w)["status"] != "completed" {
		t.Fatal(w.Code, w.Body.String())
	}
	f.mu.Lock()
	password := f.lastPassword
	f.mu.Unlock()
	if password != remote {
		t.Fatal("remote password boundary changed")
	}
	second := newABSProvisionFixture(t, "enable")
	job, _, _, secondID := failedABSJob(t, a, admin, second)
	decision := resumeBody(job, []int64{secondID})
	decision["server_passwords"] = []resumePassword{{secondID, tooLong}}
	second.mu.Lock()
	patches := second.patches
	second.mu.Unlock()
	if w := apiRequest(a, "POST", "/api/provisioning-jobs/"+job.ID+"/resume", admin, decision, nil); w.Code != 400 {
		t.Fatal(w.Code, w.Body.String())
	}
	second.mu.Lock()
	mutated := second.patches != patches
	second.mu.Unlock()
	if mutated {
		t.Fatal("oversized recovery password reached provider")
	}
}
