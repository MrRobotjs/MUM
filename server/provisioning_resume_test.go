package main

import (
	"database/sql"
	"fmt"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

func resumeBody(job redemptionJob, ids []int64) map[string]any {
	passwords := []resumePassword{}
	for _, id := range ids {
		passwords = append(passwords, resumePassword{id, fmt.Sprintf("new-server-password-%d", id)})
	}
	return map[string]any{"revision": job.Revision, "reason": "Administrator resumes the recorded accounts after reviewing upstream outcomes", "acknowledge_in_flight_risk": true, "acknowledge_password_changes": true, "server_passwords": passwords}
}

func TestResumeRecordedAccountsCompletesOriginalJobAndPreservesIdentity(t *testing.T) {
	a, s := testApp(t)
	admin, _ := bootstrapOwner(t, a)
	first, second := newReviewFixture(t, false), newReviewFixture(t, true)
	job, inviteToken, original, ids := createFailedReviewJob(t, a, admin, first, second)
	var originalUUID, hash string
	if err := s.reader.QueryRow("SELECT uuid FROM service_accounts WHERE server_id=?", ids[0]).Scan(&originalUUID); err != nil {
		t.Fatal(err)
	}
	if err := s.reader.QueryRow("SELECT password_hash FROM user_accounts WHERE uuid=?", job.UserUUID).Scan(&hash); err != nil {
		t.Fatal(err)
	}
	second.mu.Lock()
	second.failEnable = false
	second.mu.Unlock()
	w := apiRequest(a, "GET", "/api/provisioning-jobs/"+job.ID, admin, nil, nil)
	if w.Code != 200 || responseData(t, w)["resume_available"] != true {
		t.Fatal(w.Code, w.Body.String())
	}
	body := resumeBody(job, ids)
	path := "/api/provisioning-jobs/" + job.ID + "/resume"
	w = apiRequest(a, "POST", path, admin, body, nil)
	if w.Code != 200 || responseData(t, w)["status"] != "completed" {
		t.Fatal(w.Code, w.Body.String())
	}
	result := currentReview(t, a, job.ID)
	if result.Reserved || result.Reviewing || result.Status != "completed" {
		t.Fatal(result)
	}
	for _, step := range result.Steps {
		if step.ResumeState != "completed" || step.Status != "completed" {
			t.Fatal(step)
		}
	}
	var uuid, newHash string
	var active, uses, links int
	if err := s.reader.QueryRow("SELECT uuid FROM service_accounts WHERE server_id=?", ids[0]).Scan(&uuid); err != nil || uuid != originalUUID {
		t.Fatal("existing identity replaced", uuid, err)
	}
	if err := s.reader.QueryRow("SELECT password_hash,is_active FROM user_accounts WHERE uuid=?", job.UserUUID).Scan(&newHash, &active); err != nil || newHash != hash || active != 1 {
		t.Fatal("local credentials changed or profile inactive", active, err)
	}
	if err := s.reader.QueryRow("SELECT current_uses FROM invites WHERE id=?", job.InviteID).Scan(&uses); err != nil || uses != 1 {
		t.Fatal(uses, err)
	}
	if err := s.reader.QueryRow("SELECT count(*) FROM service_links WHERE user_uuid=?", job.UserUUID).Scan(&links); err != nil || links != 2 {
		t.Fatal(links, err)
	}
	for index, f := range []*reviewFixture{first, second} {
		f.mu.Lock()
		creates, writes, password := f.creates, f.passwordWrites, f.lastPassword
		f.mu.Unlock()
		if creates != 1 || writes != 2 || password != fmt.Sprintf("new-server-password-%d", ids[index]) {
			t.Fatal("resume recreated account or missed explicit password", creates, writes)
		}
	}
	if w := apiRequest(a, "POST", path, admin, body, nil); w.Code != 409 {
		t.Fatal("completed job resumed twice", w.Code)
	}
	w = apiRequest(a, "POST", "/api/public/invitations/"+inviteToken+"/redeem", "", original, nil)
	if w.Code != 200 || responseData(t, w)["status"] != "completed" {
		t.Fatal(w.Code, w.Body.String())
	}
	if w := apiRequest(a, "POST", "/api/auth/login", "", map[string]any{"username": "Review Recipient", "password": invitationPassword}, nil); w.Code != 200 {
		t.Fatal("original local password lost", w.Code, w.Body.String())
	}
	rows, err := s.reader.Query("SELECT details FROM audit_events WHERE action LIKE 'provisioning.resume%'")
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	for rows.Next() {
		var details string
		if err := rows.Scan(&details); err != nil {
			t.Fatal(err)
		}
		if strings.Contains(details, "new-server-password-") {
			t.Fatal("server password leaked into audit")
		}
	}
	if err := s.CheckIntegrity(t.Context()); err != nil {
		t.Fatal(err)
	}
}

func TestResumeRejectsUnknownAbsentAndChangedTargetsBeforeMutation(t *testing.T) {
	for _, mode := range []string{"unknown", "absent", "administrator", "configuration", "revoked", "missing_library"} {
		t.Run(mode, func(t *testing.T) {
			a, s := testApp(t)
			admin, _ := bootstrapOwner(t, a)
			f := newReviewFixture(t, true)
			if mode == "unknown" {
				f.mu.Lock()
				f.failCreate = true
				f.mu.Unlock()
			}
			job, _, _, ids := createFailedReviewJob(t, a, admin, f)
			switch mode {
			case "absent":
				f.mu.Lock()
				f.absent = true
				f.mu.Unlock()
			case "administrator":
				f.mu.Lock()
				f.adminPolicy = true
				f.mu.Unlock()
			case "configuration":
				if _, err := s.writer.Exec("UPDATE media_servers SET api_key='changed-key',revision=revision+1 WHERE id=?", ids[0]); err != nil {
					t.Fatal(err)
				}
			case "revoked":
				if _, err := s.writer.Exec("UPDATE invites SET is_active=0 WHERE id=?", job.InviteID); err != nil {
					t.Fatal(err)
				}
			case "missing_library":
				if _, err := s.writer.Exec("UPDATE media_libraries SET is_available=0 WHERE server_id=?", ids[0]); err != nil {
					t.Fatal(err)
				}
			}
			f.mu.Lock()
			before := f.passwordWrites
			f.mu.Unlock()
			w := apiRequest(a, "POST", "/api/provisioning-jobs/"+job.ID+"/resume", admin, resumeBody(job, ids), nil)
			if w.Code != 409 {
				t.Fatal(w.Code, w.Body.String())
			}
			job = currentReview(t, a, job.ID)
			if !job.Reserved || job.Reviewing || job.Status != "failed" {
				t.Fatal(job)
			}
			f.mu.Lock()
			creates, writes := f.creates, f.passwordWrites
			f.mu.Unlock()
			if creates != 1 || writes != before {
				t.Fatal("invalid target caused a remote create/password mutation", creates, writes)
			}
		})
	}
}

func TestResumePreflightChecksEveryAccountBeforeAnyPasswordChange(t *testing.T) {
	a, _ := testApp(t)
	admin, _ := bootstrapOwner(t, a)
	first, second := newReviewFixture(t, false), newReviewFixture(t, true)
	job, _, _, ids := createFailedReviewJob(t, a, admin, first, second)
	second.mu.Lock()
	second.absent = true
	second.mu.Unlock()
	w := apiRequest(a, "POST", "/api/provisioning-jobs/"+job.ID+"/resume", admin, resumeBody(job, ids), nil)
	if w.Code != 409 {
		t.Fatal(w.Code, w.Body.String())
	}
	first.mu.Lock()
	writes := first.passwordWrites
	first.mu.Unlock()
	if writes != 1 {
		t.Fatal("earlier account was mutated before all identities passed preflight")
	}
}

func TestResumeConfigurationRaceAndInterruptedAttemptRetainReservation(t *testing.T) {
	a, s := testApp(t)
	admin, _ := bootstrapOwner(t, a)
	f := newReviewFixture(t, true)
	job, _, _, ids := createFailedReviewJob(t, a, admin, f)
	started, release := make(chan struct{}), make(chan struct{})
	var once sync.Once
	defer once.Do(func() { close(release) })
	var block sync.Once
	f.mu.Lock()
	f.beforeInspect = func() { block.Do(func() { close(started); <-release }) }
	f.mu.Unlock()
	done := make(chan *httptest.ResponseRecorder, 1)
	go func() {
		done <- apiRequest(a, "POST", "/api/provisioning-jobs/"+job.ID+"/resume", admin, resumeBody(job, ids), nil)
	}()
	select {
	case <-started:
	case <-time.After(5 * time.Second):
		t.Fatal("resume did not inspect target")
	}
	if _, err := s.writer.Exec("UPDATE media_servers SET revision=revision+1 WHERE id=?", ids[0]); err != nil {
		t.Fatal(err)
	}
	once.Do(func() { close(release) })
	select {
	case w := <-done:
		if w.Code != 409 {
			t.Fatal(w.Code, w.Body.String())
		}
	case <-time.After(5 * time.Second):
		t.Fatal("resume did not finish")
	}
	f.mu.Lock()
	writes := f.passwordWrites
	f.mu.Unlock()
	if writes != 1 {
		t.Fatal("changed snapshot mutated server password")
	}
	if err := s.write(t.Context(), func(tx *sql.Tx) error {
		if _, err := tx.Exec("UPDATE provisioning_jobs SET review_token='interrupted-resume',review_operation='resume' WHERE id=?", job.ID); err != nil {
			return err
		}
		_, err := tx.Exec("UPDATE provisioning_steps SET resume_state='running' WHERE job_id=?", job.ID)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	if err := a.recoverProvisioning(t.Context()); err != nil {
		t.Fatal(err)
	}
	job = currentReview(t, a, job.ID)
	if !job.Reserved || job.Reviewing || job.Steps[0].ResumeState != "unknown" {
		t.Fatal(job)
	}
}

func TestResumeRequiresExplicitPasswordAcknowledgmentAndExactServerSet(t *testing.T) {
	a, _ := testApp(t)
	admin, _ := bootstrapOwner(t, a)
	f := newReviewFixture(t, true)
	job, _, _, ids := createFailedReviewJob(t, a, admin, f)
	path := "/api/provisioning-jobs/" + job.ID + "/resume"
	body := resumeBody(job, ids)
	body["acknowledge_password_changes"] = false
	if w := apiRequest(a, "POST", path, admin, body, nil); w.Code != 400 {
		t.Fatal(w.Code)
	}
	if w := apiRequest(a, "POST", path, "", resumeBody(job, ids), nil); w.Code != 401 {
		t.Fatal(w.Code)
	}
	body = resumeBody(job, []int64{9999})
	if w := apiRequest(a, "POST", path, admin, body, nil); w.Code != 409 {
		t.Fatal(w.Code, w.Body.String())
	}
}

func TestResumePasswordFailureNeedsAnotherExplicitAttempt(t *testing.T) {
	a, s := testApp(t)
	admin, _ := bootstrapOwner(t, a)
	f := newReviewFixture(t, true)
	job, _, _, ids := createFailedReviewJob(t, a, admin, f)
	f.mu.Lock()
	f.failPassword = true
	f.failEnable = false
	f.mu.Unlock()
	path := "/api/provisioning-jobs/" + job.ID + "/resume"
	w := apiRequest(a, "POST", path, admin, resumeBody(job, ids), nil)
	if w.Code != 502 {
		t.Fatal(w.Code, w.Body.String())
	}
	job = currentReview(t, a, job.ID)
	if !job.Reserved || job.Reviewing || job.Status != "failed" || job.Steps[0].ResumeState != "unknown" {
		t.Fatal(job)
	}
	var active bool
	if err := s.reader.QueryRow("SELECT is_active FROM user_accounts WHERE uuid=?", job.UserUUID).Scan(&active); err != nil || active {
		t.Fatal(active, err)
	}
	f.mu.Lock()
	creates, writes, disabled := f.creates, f.passwordWrites, f.policy["IsDisabled"]
	f.failPassword = false
	f.mu.Unlock()
	if creates != 1 || writes != 2 || disabled != true {
		t.Fatal("failure replayed mutation or enabled account", creates, writes, disabled)
	}
	if w := apiRequest(a, "POST", path, admin, resumeBody(job, ids), nil); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	f.mu.Lock()
	creates, writes = f.creates, f.passwordWrites
	f.mu.Unlock()
	if creates != 1 || writes != 3 {
		t.Fatal(creates, writes)
	}
}

func TestResumeDoesNotCreateUnstartedServerAccounts(t *testing.T) {
	a, _ := testApp(t)
	admin, _ := bootstrapOwner(t, a)
	first, second := newReviewFixture(t, true), newReviewFixture(t, false)
	job, _, _, ids := createFailedReviewJob(t, a, admin, first, second)
	w := apiRequest(a, "POST", "/api/provisioning-jobs/"+job.ID+"/resume", admin, resumeBody(job, ids), nil)
	if w.Code != 409 {
		t.Fatal(w.Code, w.Body.String())
	}
	first.mu.Lock()
	writes := first.passwordWrites
	first.mu.Unlock()
	second.mu.Lock()
	creates := second.creates
	second.mu.Unlock()
	if writes != 1 || creates != 0 {
		t.Fatal("known-only resumption created an unstarted account", writes, creates)
	}
}
