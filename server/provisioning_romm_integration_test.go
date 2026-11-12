package main

import (
	"app/server/providers/romm"
	"fmt"
	"strings"
	"testing"
	"time"
)

func rommInvitation(t *testing.T, a *App, admin string, f *rommProvisionFixture) (string, int64) {
	t.Helper()
	a.ProviderHTTP = f.server.Client()
	id := createManagedServer(t, a, admin, "romm", f.server.URL+"/proxy")
	w := apiRequest(a, "POST", "/api/invitations", admin, map[string]any{"expires_at": time.Now().Add(time.Hour).UTC().Format(time.RFC3339), "max_uses": 1, "grants": []InvitationGrant{{ServerID: id, AllLibraries: true, LibraryIDs: []string{}, AllowDownloads: true}}}, nil)
	if w.Code != 201 {
		t.Fatal(w.Code, w.Body.String())
	}
	return "/api/public/invitations/" + responseData(t, w)["token"].(string) + "/redeem", id
}
func rommRedemption(id int64) map[string]any {
	body := redeemBody("RomMLocal", newUUID())
	body["server_credentials"] = []redemptionCredentials{{id, "reader", "recipient-password"}}
	return body
}
func TestRomMIntegratedProvisioningAndReceipt(t *testing.T) {
	a, s := testApp(t)
	admin, _ := bootstrapOwner(t, a)
	f := newRomMProvisionFixture(t, "")
	path, id := rommInvitation(t, a, admin, f)
	body := rommRedemption(id)
	w := apiRequest(a, "POST", path, "", body, nil)
	if w.Code != 201 || responseData(t, w)["status"] != "completed" {
		t.Fatal(w.Code, w.Body.String())
	}
	if w := apiRequest(a, "POST", path, "", body, nil); w.Code != 200 || responseData(t, w)["status"] != "completed" {
		t.Fatal(w.Code, w.Body.String())
	}
	var uses, links int
	if err := s.reader.QueryRow("SELECT current_uses FROM invites").Scan(&uses); err != nil {
		t.Fatal(err)
	}
	if err := s.reader.QueryRow("SELECT count(*) FROM service_links").Scan(&links); err != nil {
		t.Fatal(err)
	}
	if uses != 1 || links != 1 {
		t.Fatal(uses, links)
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.creates != 1 || f.passwords != 1 || !f.enabled {
		t.Fatal("wrong remote outcome or duplicate create")
	}
}
func TestRomMIntegratedRecoveryPreservesIdentityAndContent(t *testing.T) {
	a, s := testApp(t)
	admin, _ := bootstrapOwner(t, a)
	f := newRomMProvisionFixture(t, "enable")
	path, id := rommInvitation(t, a, admin, f)
	body := rommRedemption(id)
	w := apiRequest(a, "POST", path, "", body, nil)
	if w.Code != 201 || responseData(t, w)["status"] != "failed" {
		t.Fatal(w.Code, w.Body.String())
	}
	job := rommCurrentReview(t, a, responseData(t, w)["id"].(string))
	if !job.Reserved || !job.ResumeAvailable || job.Steps[0].PasswordMaxBytes != 72 || !job.Steps[0].PasswordASCIIOnly {
		t.Fatal(job)
	}
	if w := apiRequest(a, "POST", fmt.Sprintf("/api/servers/%d/sync", id), admin, nil, nil); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	var identity, hash string
	if err := s.reader.QueryRow("SELECT uuid FROM service_accounts WHERE server_id=?", id).Scan(&identity); err != nil {
		t.Fatal(err)
	}
	if err := s.reader.QueryRow("SELECT password_hash FROM user_accounts WHERE uuid=?", job.UserUUID).Scan(&hash); err != nil {
		t.Fatal(err)
	}
	f.mu.Lock()
	f.mode = ""
	age := 12
	f.age = &age
	rom := int64(19)
	f.hidden = []romm.Hidden{{Entity: "roms", ID: &rom}}
	f.mu.Unlock()
	reviewPath := "/api/provisioning-jobs/" + job.ID
	if w := apiRequest(a, "POST", reviewPath+"/disable-accounts", admin, reviewBody(job), nil); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	job = rommCurrentReview(t, a, job.ID)
	if job.Steps[0].Cleanup != "disabled" || job.Steps[0].CleanupScope != "account" {
		t.Fatal(job)
	}
	if w := apiRequest(a, "POST", fmt.Sprintf("/api/servers/%d/sync", id), admin, nil, nil); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	var active bool
	s.reader.QueryRow("SELECT is_active FROM service_accounts WHERE server_id=?", id).Scan(&active)
	if active {
		t.Fatal("sync restored disabled account")
	}
	w = apiRequest(a, "POST", reviewPath+"/resume", admin, resumeBody(job, []int64{id}), nil)
	if w.Code != 200 || responseData(t, w)["status"] != "completed" {
		t.Fatal(w.Code, w.Body.String())
	}
	var current, localHash string
	s.reader.QueryRow("SELECT uuid FROM service_accounts WHERE server_id=?", id).Scan(&current)
	s.reader.QueryRow("SELECT password_hash FROM user_accounts WHERE uuid=?", job.UserUUID).Scan(&localHash)
	if current != identity || localHash != hash {
		t.Fatal("identity or local credentials changed")
	}
	f.mu.Lock()
	correct := f.creates == 1 && f.passwords == 2 && f.enabled && f.age != nil && *f.age == 12 && len(f.hidden) == 1 && romm.OverridesMatch(f.overrides, true)
	f.mu.Unlock()
	if !correct {
		t.Fatal("remote content/identity changed")
	}
	if w := apiRequest(a, "POST", path, "", body, nil); w.Code != 200 || responseData(t, w)["status"] != "completed" {
		t.Fatal(w.Code, w.Body.String())
	}
	if w := apiRequest(a, "POST", reviewPath+"/resume", admin, resumeBody(job, []int64{id}), nil); w.Code != 409 {
		t.Fatal("duplicate resume accepted", w.Code)
	}
}
func TestRomMGrantAndCredentialPreflightBeforeReservation(t *testing.T) {
	a, s := testApp(t)
	admin, _ := bootstrapOwner(t, a)
	f := newRomMProvisionFixture(t, "")
	path, id := rommInvitation(t, a, admin, f)
	for _, g := range []InvitationGrant{{ServerID: id, LibraryIDs: []string{"7"}, AllowDownloads: true}, {ServerID: id, AllLibraries: true}, {ServerID: id, AllLibraries: true, LibraryIDs: []string{"7"}, AllowDownloads: true}} {
		w := apiRequest(a, "POST", "/api/invitations", admin, map[string]any{"expires_at": time.Now().Add(time.Hour).UTC().Format(time.RFC3339), "max_uses": 1, "grants": []InvitationGrant{g}}, nil)
		if w.Code != 409 {
			t.Fatal("unsupported grant accepted", w.Code, w.Body.String())
		}
	}
	for _, c := range []redemptionCredentials{{id, "Reader", "recipient-password"}, {id, "reader", strings.Repeat("a", 73)}, {id, "reader", "non-ascii-password-é"}, {id, "reader", "linebreak-password\n"}} {
		body := rommRedemption(id)
		body["server_credentials"] = []redemptionCredentials{c}
		w := apiRequest(a, "POST", path, "", body, nil)
		if w.Code != 400 {
			t.Fatal(w.Code, w.Body.String())
		}
	}
	var jobs int
	s.reader.QueryRow("SELECT count(*) FROM provisioning_jobs").Scan(&jobs)
	f.mu.Lock()
	defer f.mu.Unlock()
	if jobs != 0 || f.creates != 0 || f.forms != 0 {
		t.Fatal("invalid input reserved work or mutated upstream")
	}
}
func TestRomMUnknownCreateRetainsCapacity(t *testing.T) {
	a, _ := testApp(t)
	admin, _ := bootstrapOwner(t, a)
	f := newRomMProvisionFixture(t, "create")
	path, id := rommInvitation(t, a, admin, f)
	body := rommRedemption(id)
	w := apiRequest(a, "POST", path, "", body, nil)
	if w.Code != 201 || responseData(t, w)["status"] != "failed" {
		t.Fatal(w.Code, w.Body.String())
	}
	job := rommCurrentReview(t, a, responseData(t, w)["id"].(string))
	if !job.Reserved || job.ResumeAvailable || !job.Steps[0].ManualRequired || job.Steps[0].RemoteID != "" {
		t.Fatal(job)
	}
	if w := apiRequest(a, "POST", path, "", body, nil); w.Code != 200 {
		t.Fatal(w.Code)
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.creates != 1 || f.forms != 0 {
		t.Fatal("unknown create replayed or adopted")
	}
}
func TestRomMRecoveryValidationBeforeWrites(t *testing.T) {
	for _, mode := range []string{"admin", "renamed", "oidc", "missing-auth", "catalog", "long-password", "ascii-password", "configuration"} {
		t.Run(mode, func(t *testing.T) {
			a, s := testApp(t)
			admin, _ := bootstrapOwner(t, a)
			f := newRomMProvisionFixture(t, "enable")
			path, id := rommInvitation(t, a, admin, f)
			w := apiRequest(a, "POST", path, "", rommRedemption(id), nil)
			if w.Code != 201 || responseData(t, w)["status"] != "failed" {
				t.Fatal(w.Code, w.Body.String())
			}
			job := rommCurrentReview(t, a, responseData(t, w)["id"].(string))
			f.mu.Lock()
			f.mode = mode
			forms, perms := f.forms, f.permissionWrites
			f.mu.Unlock()
			decision := resumeBody(job, []int64{id})
			if mode == "long-password" {
				decision["server_passwords"] = []resumePassword{{id, strings.Repeat("a", 73)}}
			}
			if mode == "ascii-password" {
				decision["server_passwords"] = []resumePassword{{id, "non-ascii-password-é"}}
			}
			if mode == "configuration" {
				if _, err := s.writer.Exec("UPDATE media_servers SET api_key='changed',revision=revision+1 WHERE id=?", id); err != nil {
					t.Fatal(err)
				}
			}
			w = apiRequest(a, "POST", "/api/provisioning-jobs/"+job.ID+"/resume", admin, decision, nil)
			if w.Code == 200 {
				t.Fatal("unsafe resume accepted")
			}
			f.mu.Lock()
			changed := f.forms != forms || f.permissionWrites != perms
			f.mu.Unlock()
			if changed || !rommCurrentReview(t, a, job.ID).Reserved {
				t.Fatal("invalid resume mutated remote state or released capacity")
			}
		})
	}
}

func rommCurrentReview(t *testing.T, a *App, id string) redemptionJob {
	t.Helper()
	job := currentReview(t, a, id)
	if err := a.populateReviewFlags(t.Context(), &job); err != nil {
		t.Fatal(err)
	}
	return job
}

func TestRomMProvisionRevisionChangeStopsPasswordWrite(t *testing.T) {
	a, s := testApp(t)
	admin, _ := bootstrapOwner(t, a)
	f := newRomMProvisionFixture(t, "")
	path, id := rommInvitation(t, a, admin, f)
	changed := false
	f.mu.Lock()
	f.beforePolicy = func() {
		if !changed && f.permissionWrites == 1 {
			changed = true
			if _, err := s.writer.Exec("UPDATE media_servers SET revision=revision+1 WHERE id=?", id); err != nil {
				t.Error(err)
			}
		}
	}
	f.mu.Unlock()
	w := apiRequest(a, "POST", path, "", rommRedemption(id), nil)
	if w.Code != 201 || responseData(t, w)["status"] != "failed" {
		t.Fatal(w.Code, w.Body.String())
	}
	job := rommCurrentReview(t, a, responseData(t, w)["id"].(string))
	f.mu.Lock()
	defer f.mu.Unlock()
	if !changed || f.creates != 1 || f.passwords != 0 || f.enabled || !job.Reserved {
		t.Fatal("stale revision allowed further writes")
	}
}
func TestRomMMixedCredentialPreflightStopsEveryProvider(t *testing.T) {
	a, s := testApp(t)
	admin, _ := bootstrapOwner(t, a)
	komga := newKomgaProvisionFixture(t, "")
	romm := newRomMProvisionFixture(t, "")
	a.ProviderHTTP = romm.server.Client()
	first := createManagedServer(t, a, admin, "komga", komga.server.URL+"/proxy")
	second := createManagedServer(t, a, admin, "romm", romm.server.URL+"/proxy")
	w := apiRequest(a, "POST", "/api/invitations", admin, map[string]any{"expires_at": time.Now().Add(time.Hour).UTC().Format(time.RFC3339), "max_uses": 1, "grants": []InvitationGrant{{ServerID: first, AllLibraries: true, AllowDownloads: true}, {ServerID: second, AllLibraries: true, AllowDownloads: true}}}, nil)
	if w.Code != 201 {
		t.Fatal(w.Code, w.Body.String())
	}
	body := redeemBody("MixedRomM", newUUID())
	body["server_credentials"] = []redemptionCredentials{{first, "reader@example.invalid", "recipient-password"}, {second, "Reader", "recipient-password"}}
	w = apiRequest(a, "POST", "/api/public/invitations/"+responseData(t, w)["token"].(string)+"/redeem", "", body, nil)
	if w.Code != 400 {
		t.Fatal(w.Code, w.Body.String())
	}
	var jobs int
	s.reader.QueryRow("SELECT count(*) FROM provisioning_jobs").Scan(&jobs)
	komga.mu.Lock()
	firstCreates := komga.creates
	komga.mu.Unlock()
	romm.mu.Lock()
	secondCreates := romm.creates
	romm.mu.Unlock()
	if jobs != 0 || firstCreates != 0 || secondCreates != 0 {
		t.Fatal("mixed preflight reserved or mutated an earlier provider")
	}
}
func TestRomMKnownAbsenceAllowsAuditedCancellation(t *testing.T) {
	a, s := testApp(t)
	admin, _ := bootstrapOwner(t, a)
	f := newRomMProvisionFixture(t, "enable")
	path, id := rommInvitation(t, a, admin, f)
	w := apiRequest(a, "POST", path, "", rommRedemption(id), nil)
	if w.Code != 201 || responseData(t, w)["status"] != "failed" {
		t.Fatal(w.Code, w.Body.String())
	}
	job := rommCurrentReview(t, a, responseData(t, w)["id"].(string))
	f.mu.Lock()
	f.mode = "absent"
	f.mu.Unlock()
	w = apiRequest(a, "POST", "/api/provisioning-jobs/"+job.ID+"/cancel", admin, reviewBody(job), nil)
	if w.Code != 200 || responseData(t, w)["status"] != "cancelled" {
		t.Fatal(w.Code, w.Body.String())
	}
	job = rommCurrentReview(t, a, job.ID)
	if job.Reserved || job.Steps[0].Cleanup != "absent" {
		t.Fatal(job)
	}
	var active bool
	s.reader.QueryRow("SELECT is_active FROM user_accounts WHERE uuid=?", job.UserUUID).Scan(&active)
	if active {
		t.Fatal("cancelled profile activated")
	}
}
