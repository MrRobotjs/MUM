package main

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func TestPlexJobReceiptPhasesDoNotClaimCompletionOrExposeSecrets(t *testing.T) {
	a, s, job, _, _ := plexCheckpointFixture(t)
	cases := []struct {
		state, phase, lease string
		review, active      bool
	}{
		{"prepared", "not_started", "", false, false},
		{"awaiting_acceptance", "awaiting_acceptance", "", false, false},
		{"send_uncertain", "outcome_uncertain", "", true, false},
		{"send_uncertain", "outcome_uncertain", "live", false, true},
		{"send_uncertain", "outcome_uncertain", "expired", true, false},
		{"access_observed", "verification_required", "", true, false},
		{"cancel_uncertain", "cleanup_uncertain", "", true, false},
		{"cancelled", "cleanup_recorded", "", true, false},
	}
	for _, tc := range cases {
		t.Run(tc.state+tc.lease, func(t *testing.T) {
			var token, operation, expires any
			if tc.lease != "" {
				token = "must-never-expose-lease"
				operation = "inspect"
				deadline := time.Now().Add(time.Minute)
				if tc.lease == "expired" {
					deadline = time.Now().Add(-time.Minute)
				}
				expires = utcTimestamp(deadline)
			}
			if _, err := s.writer.Exec("UPDATE plex_share_checkpoints SET state=?,revision=revision+1,operation_token=?,operation_name=?,operation_expires_at=? WHERE job_id=?", tc.state, token, operation, expires, job); err != nil {
				t.Fatal(err)
			}
			receipt, err := a.loadRedemption(t.Context(), job)
			if err != nil {
				t.Fatal(err)
			}
			if receipt.Plex == nil || receipt.Plex.Phase != tc.phase || receipt.Plex.RequiresReview != tc.review || receipt.Plex.OperationInProgress != tc.active || receipt.Plex.CompletionAvailable {
				t.Fatal(receipt.Plex)
			}
			if len(receipt.Steps) != 1 || receipt.Steps[0].Plex == nil || receipt.Steps[0].Plex.AccessVerified {
				t.Fatal("observed state became verified access")
			}
			if (receipt.Steps[0].Plex.CleanupScope == "owner_cloud_grant") != (tc.state == "cancelled") {
				t.Fatal("wrong cleanup scope")
			}
			data, err := json.Marshal(publicRedemption(receipt))
			if err != nil {
				t.Fatal(err)
			}
			for _, bad := range []string{"must-never-expose-lease", plexFixtureToken, "user_uuid", "remote_id", "account_id", "share_id", "machine_id", "secret", "fingerprint", "client_id", "private_key", "operation_token"} {
				if strings.Contains(string(data), bad) {
					t.Fatal("public receipt leaked", bad)
				}
			}
			if strings.Contains(string(data), `"status":"completed"`) {
				t.Fatal("Plex receipt completed job")
			}
		})
	}
}
func TestPlexJobReceiptsAdminListDetailAndOrdinaryUserGuards(t *testing.T) {
	a, s, job, _, _ := plexCheckpointFixture(t)
	hash, err := hashPassword(invitationPassword)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.writer.Exec("UPDATE user_accounts SET password_hash=?,is_active=1,local_username='receipt-recipient' WHERE uuid=(SELECT user_uuid FROM provisioning_jobs WHERE id=?)", hash, job); err != nil {
		t.Fatal(err)
	}
	login := apiRequest(a, "POST", "/api/auth/login", "", map[string]any{"username": "receipt-recipient", "password": invitationPassword}, nil)
	if login.Code != 200 {
		t.Fatal(login.Code, login.Body.String())
	}
	ordinary := responseData(t, login)["access_token"].(string)
	for _, path := range []string{"/api/provisioning-jobs/" + job, "/api/provisioning-jobs"} {
		if w := apiRequest(a, "GET", path, "", nil, nil); w.Code != 401 {
			t.Fatal("anonymous admin receipt", w.Code)
		}
		if w := apiRequest(a, "GET", path, ordinary, nil, nil); w.Code != 403 {
			t.Fatal("ordinary user read administrator receipt", w.Code)
		}
	}
	if _, err := s.writer.Exec("UPDATE user_accounts SET is_active=0 WHERE uuid=(SELECT user_uuid FROM provisioning_jobs WHERE id=?)", job); err != nil {
		t.Fatal(err)
	}
	if _, err := s.writer.Exec("UPDATE provisioning_jobs SET status='failed',request_hash=? WHERE id=?", tokenHash(randomToken()), job); err != nil {
		t.Fatal(err)
	}
	if _, err := s.writer.Exec("UPDATE plex_share_checkpoints SET state='awaiting_acceptance' WHERE job_id=?", job); err != nil {
		t.Fatal(err)
	}
	owner := apiRequest(a, "POST", "/api/auth/login", "", map[string]any{"username": "owner", "password": "a-strong-new-password"}, nil)
	if owner.Code != 200 {
		t.Fatal(owner.Code)
	}
	admin := responseData(t, owner)["access_token"].(string)
	detail := apiRequest(a, "GET", "/api/provisioning-jobs/"+job, admin, nil, nil)
	if detail.Code != 200 {
		t.Fatal(detail.Code, detail.Body.String())
	}
	data := responseData(t, detail)
	if data["resume_available"] != false || data["plex_progress"].(map[string]any)["phase"] != "awaiting_acceptance" {
		t.Fatal(data)
	}
	step := data["steps"].([]any)[0].(map[string]any)
	if step["manual_resolution_allowed"] != false || step["manual_resolution_required"] != false || step["cleanup_scope"] != "media" {
		t.Fatal("generic review bypass offered", step)
	}
	for _, action := range []string{"disable-accounts", "cancel"} {
		body := map[string]any{"revision": data["revision"], "reason": "Unresolved Plex outcomes require the specific checkpoint workflow", "acknowledge_in_flight_risk": true}
		w := apiRequest(a, "POST", "/api/provisioning-jobs/"+job+"/"+action, admin, body, nil)
		if w.Code != 409 {
			t.Fatal("generic review bypassed unresolved Plex checkpoint", action, w.Code, w.Body.String())
		}
	}
	list := apiRequest(a, "GET", "/api/provisioning-jobs", admin, nil, nil)
	if list.Code != 200 || !strings.Contains(list.Body.String(), `"phase":"awaiting_acceptance"`) {
		t.Fatal(list.Code, list.Body.String())
	}
	if detail.Header().Get("Cache-Control") != "no-store" || list.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("receipts cached")
	}
}
func TestPlexPublicRetryReceiptRemainsCredentialBound(t *testing.T) {
	a, s, job, _, f := plexCheckpointFixture(t)
	token, request := randomToken(), newUUID()
	hash, err := hashPassword(invitationPassword)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.writer.Exec("UPDATE invites SET token=? WHERE id=(SELECT invite_id FROM provisioning_jobs WHERE id=?)", tokenHash(token), job); err != nil {
		t.Fatal(err)
	}
	if _, err := s.writer.Exec("UPDATE provisioning_jobs SET requested_username='receipt-recipient',request_hash=? WHERE id=?", tokenHash(request), job); err != nil {
		t.Fatal(err)
	}
	if _, err := s.writer.Exec("UPDATE user_accounts SET local_username='receipt-recipient',password_hash=? WHERE uuid=(SELECT user_uuid FROM provisioning_jobs WHERE id=?)", hash, job); err != nil {
		t.Fatal(err)
	}
	if _, err := s.writer.Exec("UPDATE plex_share_checkpoints SET state='awaiting_acceptance' WHERE job_id=?", job); err != nil {
		t.Fatal(err)
	}
	body := redeemBody("receipt-recipient", request)
	w := apiRequest(a, "POST", "/api/public/invitations/"+token+"/redeem", "", body, nil)
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"phase":"awaiting_acceptance"`) || strings.Contains(w.Body.String(), "user_uuid") {
		t.Fatal(w.Code, w.Body.String())
	}
	body["password"] = "incorrect-but-long-password"
	if w := apiRequest(a, "POST", "/api/public/invitations/"+token+"/redeem", "", body, nil); w.Code != 409 || strings.Contains(w.Body.String(), job) {
		t.Fatal("wrong password obtained receipt", w.Code)
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.creates != 1 {
		t.Fatal("receipt replay triggered provisioning")
	}
}
func TestPlexJobSummaryPrioritizesUncertaintyAndNeverClaimsTerminalSuccess(t *testing.T) {
	rows := []plexShareReceiptRow{{job: "job", receipt: plexShareReceipt{State: "awaiting_acceptance"}}, {job: "job", receipt: plexShareReceipt{State: "cancel_uncertain"}}}
	result := summarizePlexReceipts("job", "running", rows)
	if result.Phase != "cleanup_uncertain" || !result.RequiresReview || result.CompletionAvailable {
		t.Fatal(result)
	}
	for _, status := range []string{"completed", "cancelled"} {
		if result := summarizePlexReceipts("job", status, rows); result.Phase != "review_required" || !result.RequiresReview {
			t.Fatal(result)
		}
	}
	if summarizePlexReceipts("other", "running", rows) != nil {
		t.Fatal("unrelated job progress leaked")
	}
}
