package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"app/server/providers/provider"
	"app/server/providers/tofa"
)

func TestTofaInvitationGrantValidation(t *testing.T) {
	lib := "21234567-89ab-4cde-8fab-0123456789ab"
	s := &tofa.Server{}
	if !s.ValidGrant(provider.Grant{AllLibraries: true}) {
		t.Fatal("rejected valid all-libraries grant")
	}
	if !s.ValidGrant(provider.Grant{LibraryIDs: []string{lib}}) {
		t.Fatal("rejected valid selected-libraries grant")
	}
	if s.ValidGrant(provider.Grant{AllLibraries: true, AllowDownloads: true}) {
		t.Fatal("accepted download permission for Tofa")
	}
	if s.ValidGrant(provider.Grant{LibraryIDs: []string{lib}, AllowDownloads: true}) {
		t.Fatal("accepted download permission on selected libraries for Tofa")
	}
	if s.ValidGrant(provider.Grant{LibraryIDs: []string{"not-a-uuid"}}) {
		t.Fatal("accepted non-UUID library ID")
	}
	if s.ValidGrant(provider.Grant{LibraryIDs: []string{lib, strings.ToUpper(lib)}}) {
		t.Fatal("accepted duplicate library ID")
	}
}

func TestTofaInvitationEmailAndGrantEnforcement(t *testing.T) {
	a, store := testApp(t)
	token, _ := bootstrapOwner(t, a)
	serverID := createManagedServer(t, a, token, "tofa", "http://127.0.0.1:1")
	lib := "21234567-89ab-4cde-8fab-0123456789ab"
	activityExec(t, store, `INSERT INTO media_libraries(server_id,external_id,name,is_available) VALUES(?,?, 'Movies', 1)`, serverID, lib)

	badInvite := map[string]any{
		"grants": []map[string]any{{"server_id": serverID, "all_libraries": false, "library_ids": []string{lib}, "allow_downloads": true}},
	}
	if w := apiRequest(a, "POST", "/api/invitations", token, badInvite, nil); w.Code != 409 {
		t.Fatalf("expected 409 for Tofa allow_downloads=true, got %d: %s", w.Code, w.Body.String())
	}

	goodInvite := map[string]any{
		"grants": []map[string]any{{"server_id": serverID, "all_libraries": false, "library_ids": []string{lib}, "allow_downloads": false}},
	}
	w := apiRequest(a, "POST", "/api/invitations", token, goodInvite, nil)
	if w.Code != 201 {
		t.Fatalf("create Tofa invite failed: %d: %s", w.Code, w.Body.String())
	}
	inviteToken := responseData(t, w)["token"].(string)

	missingEmail := map[string]any{
		"request_id": strings.Repeat("a", 32),
		"username":   "tofaplayer",
		"password":   "very-strong-password-123",
	}
	if w := apiRequest(a, "POST", "/api/public/invitations/"+inviteToken+"/redeem", "", missingEmail, nil); w.Code != 400 {
		t.Fatalf("expected 400 for missing email, got %d: %s", w.Code, w.Body.String())
	}

	withPerServerCreds := map[string]any{
		"request_id":         strings.Repeat("b", 32),
		"username":           "tofaplayer",
		"email":              "viewer@example.test",
		"password":           "very-strong-password-123",
		"server_credentials": []map[string]any{{"server_id": serverID, "username": "other", "password": "very-strong-password-123"}},
	}
	if w := apiRequest(a, "POST", "/api/public/invitations/"+inviteToken+"/redeem", "", withPerServerCreds, nil); w.Code != 409 {
		t.Fatalf("expected 409 for Tofa server_credentials, got %d: %s", w.Code, w.Body.String())
	}
}

func TestTofaInvitationRestartRecoveryAndReceiptRedaction(t *testing.T) {
	a, store := testApp(t)
	token, _ := bootstrapOwner(t, a)
	owner, err := store.Authenticate(t.Context(), token)
	if err != nil {
		t.Fatal(err)
	}
	serverID := createManagedServer(t, a, token, "tofa", "http://127.0.0.1:1")
	server, err := a.loadServer(t.Context(), serverID)
	if err != nil {
		t.Fatal(err)
	}
	now := utcTimestamp(time.Now())
	activityExec(t, store, `INSERT INTO invites(token,created_at,updated_at,is_active,created_by_owner_id) VALUES('fixture-token',?,?,1,?)`, now, now, owner.ID)
	var inviteID int64
	if err = store.reader.QueryRow("SELECT id FROM invites WHERE token='fixture-token'").Scan(&inviteID); err != nil {
		t.Fatal(err)
	}
	job := newUUID()
	activityExec(t, store, `INSERT INTO provisioning_jobs(id,invite_id,user_uuid,status,created_at,updated_at,request_hash,reservation_held) VALUES(?,?,?,'running',?,?,?,1)`, job, inviteID, owner.UUID, now, now, tokenHash(strings.Repeat("c", 32)))
	activityExec(t, store, `INSERT INTO provisioning_steps(job_id,server_id,status,grant_snapshot,server_revision,provider_fingerprint) VALUES(?,?,'pending','{}',?,?)`, job, serverID, server.Revision, providerFingerprint(server))

	if _, err := a.beginTofaInvitation(t.Context(), job, inviteID, server, "viewer@example.test"); err != nil {
		t.Fatal(err)
	}
	if err := a.recoverProvisioning(t.Context()); err != nil {
		t.Fatal(err)
	}
	var state string
	if err := store.reader.QueryRow(`SELECT state FROM tofa_invitation_receipts WHERE job_id=? AND server_id=?`, job, serverID).Scan(&state); err != nil || state != "unknown" {
		t.Fatalf("expected unknown state after restart recovery, got %q (%v)", state, err)
	}
	loaded, err := a.loadRedemption(t.Context(), job)
	if err != nil {
		t.Fatal(err)
	}
	if len(loaded.Steps) != 1 || loaded.Steps[0].Tofa == nil || loaded.Steps[0].Tofa.State != "unknown" || !loaded.Steps[0].Tofa.RequiresReview {
		t.Fatalf("unexpected loaded Tofa step: %+v", loaded.Steps)
	}
	targets, err := a.reviewTargets(t.Context(), loaded)
	if err != nil || len(targets) != 1 || !targets[0].Manual {
		t.Fatalf("expected Tofa step without remote_invite_id to require manual resolution: %+v (%v)", targets, err)
	}
	pub := publicRedemption(loaded)
	raw, _ := json.Marshal(pub)
	if strings.Contains(string(raw), "remote_invite_id") {
		t.Fatalf("public receipt leaked remote_invite_id: %s", raw)
	}
}

func TestTofaInvitationRedemptionAndRevocationReview(t *testing.T) {
	inviteUUID := "11234567-89ab-4cde-8fab-0123456789ab"
	libUUID := "21234567-89ab-4cde-8fab-0123456789ab"
	state := "queued"
	var creates, revokes int
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/api/v1/onboarding/invites":
			creates++
			fmt.Fprintf(w, `{"id":%q,"email":"viewer@example.test","state":%q}`, inviteUUID, state)
		case r.Method == http.MethodGet && r.URL.Path == "/api/v1/onboarding/invites/"+inviteUUID:
			fmt.Fprintf(w, `{"id":%q,"email":"viewer@example.test","state":%q}`, inviteUUID, state)
		case r.Method == http.MethodPost && r.URL.Path == "/api/v1/onboarding/invites/"+inviteUUID+"/revoke":
			revokes++
			state = "revoked"
			fmt.Fprintf(w, `{"id":%q,"email":"viewer@example.test","state":%q}`, inviteUUID, state)
		default:
			http.NotFound(w, r)
		}
	}))
	defer up.Close()

	a, store := testApp(t)
	token, _ := bootstrapOwner(t, a)
	serverID := createManagedServer(t, a, token, "tofa", up.URL)
	activityExec(t, store, `INSERT INTO media_libraries(server_id,external_id,name,is_available) VALUES(?,?, 'Movies', 1)`, serverID, libUUID)

	w := apiRequest(a, "POST", "/api/invitations", token, map[string]any{
		"grants": []map[string]any{{"server_id": serverID, "all_libraries": false, "library_ids": []string{libUUID}, "allow_downloads": false}},
	}, nil)
	if w.Code != 201 {
		t.Fatal(w.Code, w.Body.String())
	}
	inviteToken := responseData(t, w)["token"].(string)

	w = apiRequest(a, "POST", "/api/public/invitations/"+inviteToken+"/redeem", "", map[string]any{
		"request_id": strings.Repeat("d", 32),
		"username":   "tofauser",
		"email":      "viewer@example.test",
		"password":   "very-strong-password-123",
	}, nil)
	if w.Code != 201 {
		t.Fatalf("redeem failed: %d: %s", w.Code, w.Body.String())
	}
	data := responseData(t, w)
	if data["status"] != "completed" || creates != 1 {
		t.Fatalf("unexpected redemption result: %v (creates=%d)", data, creates)
	}
	var linked int
	if err := store.reader.QueryRow(`SELECT count(*) FROM service_links`).Scan(&linked); err != nil || linked != 0 {
		t.Fatalf("Tofa invite must not infer service_links by email, got %d (%v)", linked, err)
	}

	// Verify failed job with recorded remote_invite_id can be revoked and cancelled.
	jobID := data["id"].(string)
	activityExec(t, store, `UPDATE provisioning_jobs SET status='failed',reservation_held=1 WHERE id=?`, jobID)
	activityExec(t, store, `UPDATE user_accounts SET is_active=0 WHERE local_username='tofauser'`)
	job, err := a.loadRedemption(context.Background(), jobID)
	if err != nil {
		t.Fatal(err)
	}
	w = apiRequest(a, "POST", "/api/provisioning-jobs/"+jobID+"/review/disable", token, map[string]any{
		"revision": job.Revision, "reason": "Revoke pending Tofa invite", "acknowledge_in_flight_risk": true,
	}, nil)
	if w.Code != 200 || revokes != 1 {
		t.Fatalf("expected Tofa invite revoke during review, got %d (revokes=%d): %s", w.Code, revokes, w.Body.String())
	}
	job, err = a.loadRedemption(context.Background(), jobID)
	if err != nil {
		t.Fatal(err)
	}
	w = apiRequest(a, "POST", "/api/provisioning-jobs/"+jobID+"/review/cancel", token, map[string]any{
		"revision": job.Revision, "reason": "Cancel after Tofa revoke", "acknowledge_in_flight_risk": true,
	}, nil)
	if w.Code != 200 || responseData(t, w)["status"] != "cancelled" {
		t.Fatalf("expected job cancel after Tofa revoke, got %d: %s", w.Code, w.Body.String())
	}
}
