package main

import (
	"app/server/providers/kavita"
	"database/sql"
	"fmt"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"
)

func failedKavitaRecoveryJob(t *testing.T, a *App, admin string, f *kavitaProvisionFixture) (redemptionJob, string, map[string]any, int64) {
	t.Helper()
	path, id := kavitaInvitation(t, a, admin, f, false)
	body := redeemBody("RecoveryReader", newUUID())
	w := apiRequest(a, "POST", path, "", body, nil)
	if w.Code != 201 || responseData(t, w)["status"] != "failed" {
		t.Fatal(w.Code, w.Body.String())
	}
	return currentReview(t, a, responseData(t, w)["id"].(string)), path, body, id
}

func TestKavitaDisablePreservesAccessMetadataAndResumeCompletesOriginalIdentity(t *testing.T) {
	a, s := testApp(t)
	admin, _ := bootstrapOwner(t, a)
	f := newKavitaProvisionFixture(t, "enable")
	job, receipt, original, id := failedKavitaRecoveryJob(t, a, admin, f)
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
	f.age = kavita.AgeRestriction{AgeRating: 12, IncludeUnknowns: false}
	f.roles = append(f.roles, "Bookmark", "Download")
	f.libraries = []int64{2, 3}
	f.mu.Unlock()
	path := "/api/provisioning-jobs/" + job.ID
	w := apiRequest(a, "POST", path+"/disable-accounts", admin, reviewBody(job), nil)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	job = currentReview(t, a, job.ID)
	if job.Steps[0].Cleanup != "disabled" || !job.Reserved {
		t.Fatal(job)
	}
	f.mu.Lock()
	preserved := slices.Contains(f.roles, "Bookmark") && slices.Contains(f.roles, "Download") && !slices.Contains(f.roles, "Login") && slices.Equal(f.libraries, []int64{2, 3}) && f.age == (kavita.AgeRestriction{AgeRating: 12, IncludeUnknowns: false})
	f.mu.Unlock()
	if !preserved {
		t.Fatal("disable changed unrelated access metadata")
	}
	w = apiRequest(a, "POST", path+"/resume", admin, resumeBody(job, []int64{id}), nil)
	if w.Code != 200 || responseData(t, w)["status"] != "completed" {
		t.Fatal(w.Code, w.Body.String())
	}
	var currentUUID, currentHash string
	var active bool
	var uses, links int
	if err := s.reader.QueryRow("SELECT uuid FROM service_accounts WHERE server_id=?", id).Scan(&currentUUID); err != nil || currentUUID != uuid {
		t.Fatal(currentUUID, err)
	}
	if err := s.reader.QueryRow("SELECT password_hash,is_active FROM user_accounts WHERE uuid=?", job.UserUUID).Scan(&currentHash, &active); err != nil || currentHash != hash || !active {
		t.Fatal(active, err)
	}
	if err := s.reader.QueryRow("SELECT current_uses FROM invites WHERE id=?", job.InviteID).Scan(&uses); err != nil || uses != 1 {
		t.Fatal(uses, err)
	}
	if err := s.reader.QueryRow("SELECT count(*) FROM service_links WHERE user_uuid=?", job.UserUUID).Scan(&links); err != nil || links != 1 {
		t.Fatal(links, err)
	}
	f.mu.Lock()
	verified := f.invites == 1 && f.confirmations == 1 && f.resets == 1 && f.lastPassword == fmt.Sprintf("new-server-password-%d", id) && !slices.Contains(f.roles, "Bookmark") && !slices.Contains(f.roles, "Download") && slices.Contains(f.roles, "Login") && slices.Equal(f.libraries, []int64{2}) && f.age == (kavita.AgeRestriction{AgeRating: 12, IncludeUnknowns: false})
	f.mu.Unlock()
	if !verified {
		t.Fatal("resume failed to restore frozen grants or recreated the account")
	}
	if w := apiRequest(a, "POST", receipt, "", original, nil); w.Code != 200 || responseData(t, w)["status"] != "completed" {
		t.Fatal(w.Code, w.Body.String())
	}
	if w := apiRequest(a, "POST", path+"/resume", admin, resumeBody(job, []int64{id}), nil); w.Code != 409 {
		t.Fatal("duplicate completion", w.Code)
	}
}

func TestKavitaRecoveryGuardsBeforeMutation(t *testing.T) {
	for _, mode := range []string{"unsafe_roles", "oidc", "pending", "wrong_name", "missing_age", "duplicate", "null_members", "broken_users", "configuration", "long_password"} {
		t.Run(mode, func(t *testing.T) {
			a, s := testApp(t)
			admin, _ := bootstrapOwner(t, a)
			f := newKavitaProvisionFixture(t, "enable")
			job, _, _, id := failedKavitaRecoveryJob(t, a, admin, f)
			f.mu.Lock()
			f.mode = mode
			updates := f.updates
			f.mu.Unlock()
			if mode == "configuration" {
				if _, err := s.writer.Exec("UPDATE media_servers SET revision=revision+1,api_key='changed-key' WHERE id=?", id); err != nil {
					t.Fatal(err)
				}
			}
			body := resumeBody(job, []int64{id})
			if mode == "long_password" {
				body["server_passwords"] = []resumePassword{{id, strings.Repeat("x", 257)}}
			}
			w := apiRequest(a, "POST", "/api/provisioning-jobs/"+job.ID+"/resume", admin, body, nil)
			if w.Code == 200 || mode == "long_password" && w.Code != 400 {
				t.Fatal(w.Code, w.Body.String())
			}
			f.mu.Lock()
			mutated := f.updates != updates || f.resets != 0
			f.mu.Unlock()
			if mutated || !currentReview(t, a, job.ID).Reserved {
				t.Fatal("unsafe target mutated or reservation released")
			}
		})
	}
}

func TestKavitaUncertainPasswordResetRequiresExplicitRetry(t *testing.T) {
	a, _ := testApp(t)
	admin, _ := bootstrapOwner(t, a)
	f := newKavitaProvisionFixture(t, "enable")
	job, _, _, id := failedKavitaRecoveryJob(t, a, admin, f)
	f.mu.Lock()
	f.mode = "reset"
	f.mu.Unlock()
	path := "/api/provisioning-jobs/" + job.ID + "/resume"
	if w := apiRequest(a, "POST", path, admin, resumeBody(job, []int64{id}), nil); w.Code != 502 {
		t.Fatal(w.Code, w.Body.String())
	}
	job = currentReview(t, a, job.ID)
	if !job.Reserved || job.Reviewing || job.Steps[0].ResumeState != "unknown" {
		t.Fatal(job)
	}
	f.mu.Lock()
	resets := f.resets
	enabled := slices.Contains(f.roles, "Login")
	f.mode = ""
	f.mu.Unlock()
	if resets != 1 || enabled {
		t.Fatal("uncertain reset replayed or account enabled")
	}
	if err := a.recoverProvisioning(t.Context()); err != nil {
		t.Fatal(err)
	}
	f.mu.Lock()
	resets = f.resets
	f.mu.Unlock()
	if resets != 1 {
		t.Fatal("startup replayed password reset")
	}
	if w := apiRequest(a, "POST", path, admin, resumeBody(job, []int64{id}), nil); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
}

func TestKavitaUnknownConfirmationNeverAdoptsAnExistingUsername(t *testing.T) {
	a, _ := testApp(t)
	admin, _ := bootstrapOwner(t, a)
	f := newKavitaProvisionFixture(t, "confirm")
	job, _, _, id := failedKavitaRecoveryJob(t, a, admin, f)
	if job.Steps[0].RemoteID != "" {
		t.Fatal("uncertain confirmation claimed a remote identity")
	}
	path := "/api/provisioning-jobs/" + job.ID
	if w := apiRequest(a, "POST", path+"/resume", admin, resumeBody(job, []int64{id}), nil); w.Code != 409 {
		t.Fatal(w.Code, w.Body.String())
	}
	job = currentReview(t, a, job.ID)
	body := reviewBody(job)
	body["manual_resolutions"] = []manualReview{{ServerID: id, Reason: "Externally reconciled the unrecorded confirmation and confirmed login access is disabled"}}
	w := apiRequest(a, "POST", path+"/cancel", admin, body, nil)
	if w.Code != 200 || responseData(t, w)["status"] != "cancelled" {
		t.Fatal(w.Code, w.Body.String())
	}
	job = currentReview(t, a, job.ID)
	if job.Steps[0].Cleanup != "manual" {
		t.Fatal("external assertion mislabeled as automated verification")
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.invites != 1 || f.confirmations != 1 || f.resets != 0 || f.updates != 0 {
		t.Fatal("unknown confirmation was adopted or replayed")
	}
}

func TestKavitaUncertainDisableDoesNotClaimVerifiedSuccess(t *testing.T) {
	a, _ := testApp(t)
	admin, _ := bootstrapOwner(t, a)
	f := newKavitaProvisionFixture(t, "enable")
	job, _, _, _ := failedKavitaRecoveryJob(t, a, admin, f)
	f.mu.Lock()
	f.mode = "disable"
	f.mu.Unlock()
	path := "/api/provisioning-jobs/" + job.ID + "/disable-accounts"
	if w := apiRequest(a, "POST", path, admin, reviewBody(job), nil); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	job = currentReview(t, a, job.ID)
	if !job.Reserved || job.Steps[0].Cleanup != "failed" {
		t.Fatal(job)
	}
	f.mu.Lock()
	f.mode = ""
	f.mu.Unlock()
	if w := apiRequest(a, "POST", path, admin, reviewBody(job), nil); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	if currentReview(t, a, job.ID).Steps[0].Cleanup != "disabled" {
		t.Fatal("fresh inspection did not reconcile disable")
	}
}

func TestKavitaDisableAndAbsencePermitVerifiedCancellation(t *testing.T) {
	for _, absent := range []bool{false, true} {
		t.Run(fmt.Sprint(absent), func(t *testing.T) {
			a, _ := testApp(t)
			admin, _ := bootstrapOwner(t, a)
			f := newKavitaProvisionFixture(t, "enable")
			job, _, _, _ := failedKavitaRecoveryJob(t, a, admin, f)
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

func TestKavitaRecoveryRejectsServerRevisionChangeDuringInspection(t *testing.T) {
	a, s := testApp(t)
	admin, _ := bootstrapOwner(t, a)
	f := newKavitaProvisionFixture(t, "enable")
	job, _, _, id := failedKavitaRecoveryJob(t, a, admin, f)
	var once sync.Once
	f.mu.Lock()
	f.mode = ""
	updates := f.updates
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
	w := apiRequest(a, "POST", "/api/provisioning-jobs/"+job.ID+"/resume", admin, resumeBody(job, []int64{id}), nil)
	if w.Code != 409 {
		t.Fatal(w.Code, w.Body.String())
	}
	f.mu.Lock()
	mutated := f.updates != updates || f.resets != 0
	f.mu.Unlock()
	if mutated {
		t.Fatal("stale revision performed a remote mutation")
	}
}

func TestMixedKavitaJellyfinPreflightBeforeAnyPasswordMutation(t *testing.T) {
	a, _ := testApp(t)
	admin, _ := bootstrapOwner(t, a)
	jellyfin := newReviewFixture(t, false)
	kavita := newKavitaProvisionFixture(t, "enable")
	first := createManagedServer(t, a, admin, "jellyfin", jellyfin.server.URL)
	second := createManagedServer(t, a, admin, "kavita", kavita.server.URL)
	for _, id := range []int64{first, second} {
		if w := apiRequest(a, "POST", fmt.Sprintf("/api/servers/%d/sync", id), admin, nil, nil); w.Code != 200 {
			t.Fatal(w.Code, w.Body.String())
		}
	}
	w := apiRequest(a, "POST", "/api/invitations", admin, map[string]any{"expires_at": time.Now().Add(time.Hour).UTC().Format(time.RFC3339Nano), "max_uses": 1, "grants": []InvitationGrant{{ServerID: first, LibraryIDs: []string{"movies"}}, {ServerID: second, LibraryIDs: []string{"2"}}}}, nil)
	if w.Code != 201 {
		t.Fatal(w.Code, w.Body.String())
	}
	w = apiRequest(a, "POST", "/api/public/invitations/"+responseData(t, w)["token"].(string)+"/redeem", "", redeemBody("MixedReader", newUUID()), nil)
	if w.Code != 201 || responseData(t, w)["status"] != "failed" {
		t.Fatal(w.Code, w.Body.String())
	}
	job := currentReview(t, a, responseData(t, w)["id"].(string))
	path := "/api/provisioning-jobs/" + job.ID + "/resume"
	kavita.mu.Lock()
	kavita.mode = "unsafe_roles"
	kavita.mu.Unlock()
	if w := apiRequest(a, "POST", path, admin, resumeBody(job, []int64{first, second}), nil); w.Code == 200 {
		t.Fatal("unsafe second target accepted")
	}
	jellyfin.mu.Lock()
	writes := jellyfin.passwordWrites
	jellyfin.mu.Unlock()
	if writes != 1 {
		t.Fatal("first password changed before full preflight")
	}
	kavita.mu.Lock()
	kavita.mode = ""
	kavita.mu.Unlock()
	job = currentReview(t, a, job.ID)
	if w := apiRequest(a, "POST", path, admin, resumeBody(job, []int64{first, second}), nil); w.Code != 200 || responseData(t, w)["status"] != "completed" {
		t.Fatal(w.Code, w.Body.String())
	}
}
