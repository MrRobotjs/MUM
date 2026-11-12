package main

import (
	"app/server/providers/emby"
	"encoding/json"
	"fmt"
	"slices"
	"testing"
	"time"
)

func embyInvitation(t *testing.T, a *App, admin string, f *reviewFixture, prefix string) (string, int64) {
	t.Helper()
	id := createManagedServer(t, a, admin, "emby", f.server.URL+prefix)
	if w := apiRequest(a, "POST", fmt.Sprintf("/api/servers/%d/sync", id), admin, nil, nil); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	w := apiRequest(a, "POST", "/api/invitations", admin, map[string]any{"expires_at": time.Now().Add(time.Hour).UTC().Format(time.RFC3339Nano), "max_uses": 1, "grants": []InvitationGrant{{ServerID: id, LibraryIDs: []string{"movies"}}}}, nil)
	if w.Code != 201 {
		t.Fatal(w.Code, w.Body.String())
	}
	return "/api/public/invitations/" + responseData(t, w)["token"].(string) + "/redeem", id
}

func TestEmbyProvisioningPreservesPolicyAndSupportsBothBaseURLs(t *testing.T) {
	for _, prefix := range []string{"", "/emby"} {
		t.Run("base"+prefix, func(t *testing.T) {
			a, s := testApp(t)
			admin, _ := bootstrapOwner(t, a)
			f := newReviewFixtureFor(t, "emby", false)
			path, id := embyInvitation(t, a, admin, f, prefix)
			body := redeemBody("Emby Recipient", newUUID())
			w := apiRequest(a, "POST", path, "", body, nil)
			if w.Code != 201 || responseData(t, w)["status"] != "completed" {
				t.Fatal(w.Code, w.Body.String())
			}
			f.mu.Lock()
			if f.creates != 1 || f.passwordWrites != 1 || f.lastPassword != invitationPassword || f.policy["CustomPolicyField"] != "preserve-me" || !emby.RestrictionsMatch(f.policy) {
				t.Fatal("incorrect Emby outcome", f.creates, f.passwordWrites, f.policy)
			}
			f.mu.Unlock()
			var links int
			if err := s.reader.QueryRow("SELECT count(*) FROM service_links l JOIN service_accounts a ON a.uuid=l.service_uuid WHERE a.server_id=? AND a.external_user_id='remote-user'", id).Scan(&links); err != nil || links != 1 {
				t.Fatal(links, err)
			}
			if w := apiRequest(a, "POST", path, "", body, nil); w.Code != 200 {
				t.Fatal(w.Code)
			}
			catalog := apiRequest(a, "GET", "/api/providers", admin, nil, nil)
			var providers struct {
				Data []struct {
					ID           string
					Capabilities []string
				}
			}
			if err := json.Unmarshal(catalog.Body.Bytes(), &providers); err != nil {
				t.Fatal(err)
			}
			for _, provider := range providers.Data {
				if slices.Contains(provider.Capabilities, "users.provision") != supportsProvisioning(provider.ID) {
					t.Fatal("incorrect provisioning capability", provider)
				}
			}
		})
	}
}

func TestEmbyExplicitAllLibraryAndDownloadPolicy(t *testing.T) {
	f := newReviewFixtureFor(t, "emby", false)
	provider, err := newServerConnection(ProviderConfig{"emby", f.server.URL, "fixture-secret"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	stages := []string{}
	err = provider.provisionUser(t.Context(), "All Libraries", invitationPassword, InvitationGrant{AllLibraries: true, LibraryIDs: []string{}, AllowDownloads: true}, func(stage, id string) error { stages = append(stages, stage); return nil })
	if err != nil {
		t.Fatal(err)
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.policy["EnableAllFolders"] != true || f.policy["EnableContentDownloading"] != true || f.policy["EnableSyncTranscoding"] != true || stages[len(stages)-1] != "remote_completed" {
		t.Fatal(f.policy, stages)
	}
}

func TestEmbyCancellationVerifiesDisabledOrAbsentIdentity(t *testing.T) {
	for _, absent := range []bool{false, true} {
		t.Run(fmt.Sprint("absent=", absent), func(t *testing.T) {
			a, s := testApp(t)
			admin, _ := bootstrapOwner(t, a)
			f := newReviewFixtureFor(t, "emby", true)
			job, _, _, _ := createFailedReviewJob(t, a, admin, f)
			f.mu.Lock()
			f.absent = absent
			f.mu.Unlock()
			if !absent {
				w := apiRequest(a, "POST", "/api/provisioning-jobs/"+job.ID+"/disable-accounts", admin, reviewBody(job), nil)
				if w.Code != 200 {
					t.Fatal(w.Code, w.Body.String())
				}
				job = currentReview(t, a, job.ID)
			}
			w := apiRequest(a, "POST", "/api/provisioning-jobs/"+job.ID+"/cancel", admin, reviewBody(job), nil)
			if w.Code != 200 || responseData(t, w)["status"] != "cancelled" {
				t.Fatal(w.Code, w.Body.String())
			}
			job = currentReview(t, a, job.ID)
			want := "disabled"
			if absent {
				want = "absent"
			}
			if job.Reserved || job.Steps[0].Cleanup != want {
				t.Fatal(job)
			}
			var uses int
			if err := s.reader.QueryRow("SELECT current_uses FROM invites WHERE id=?", job.InviteID).Scan(&uses); err != nil || uses != 0 {
				t.Fatal(uses, err)
			}
		})
	}
}

func TestEmbyUncertainWritesRetainReservationAndNeverReplayCreate(t *testing.T) {
	for _, mode := range []string{"create", "password", "enable", "readback"} {
		t.Run(mode, func(t *testing.T) {
			a, s := testApp(t)
			admin, _ := bootstrapOwner(t, a)
			f := newReviewFixtureFor(t, "emby", mode == "enable")
			f.failCreate, f.failPassword, f.ignorePolicy = mode == "create", mode == "password", mode == "readback"
			path, _ := embyInvitation(t, a, admin, f, "")
			body := redeemBody("Failed Emby", newUUID())
			w := apiRequest(a, "POST", path, "", body, nil)
			if w.Code != 201 || responseData(t, w)["status"] != "failed" {
				t.Fatal(w.Code, w.Body.String())
			}
			job := currentReview(t, a, responseData(t, w)["id"].(string))
			if !job.Reserved || (mode != "create" && job.Steps[0].RemoteID != "remote-user") {
				t.Fatal(job)
			}
			if w := apiRequest(a, "POST", path, "", body, nil); w.Code != 200 || responseData(t, w)["status"] != "failed" {
				t.Fatal(w.Code, w.Body.String())
			}
			f.mu.Lock()
			creates := f.creates
			f.mu.Unlock()
			if creates != 1 {
				t.Fatal("uncertain create replayed", creates)
			}
			var active, uses int
			if err := s.reader.QueryRow("SELECT is_active FROM user_accounts WHERE uuid=?", job.UserUUID).Scan(&active); err != nil || active != 0 {
				t.Fatal(active, err)
			}
			if err := s.reader.QueryRow("SELECT current_uses FROM invites WHERE id=?", job.InviteID).Scan(&uses); err != nil || uses != 0 {
				t.Fatal(uses, err)
			}
		})
	}
}

func TestMixedJellyfinEmbyReviewAndResumptionPreservesOriginalIdentity(t *testing.T) {
	a, s := testApp(t)
	admin, _ := bootstrapOwner(t, a)
	first, second := newReviewFixture(t, false), newReviewFixtureFor(t, "emby", true)
	job, token, original, ids := createFailedReviewJob(t, a, admin, first, second)
	var originalUUID string
	if err := s.reader.QueryRow("SELECT uuid FROM service_accounts WHERE server_id=?", ids[0]).Scan(&originalUUID); err != nil {
		t.Fatal(err)
	}
	path := "/api/provisioning-jobs/" + job.ID
	w := apiRequest(a, "POST", path+"/disable-accounts", admin, reviewBody(job), nil)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	job = currentReview(t, a, job.ID)
	for _, step := range job.Steps {
		if step.Cleanup != "disabled" {
			t.Fatal(job)
		}
	}
	second.mu.Lock()
	second.failEnable = false
	second.mu.Unlock()
	w = apiRequest(a, "POST", path+"/resume", admin, resumeBody(job, ids), nil)
	if w.Code != 200 || responseData(t, w)["status"] != "completed" {
		t.Fatal(w.Code, w.Body.String())
	}
	var actualUUID string
	if err := s.reader.QueryRow("SELECT uuid FROM service_accounts WHERE server_id=?", ids[0]).Scan(&actualUUID); err != nil || actualUUID != originalUUID {
		t.Fatal("identity changed", actualUUID, err)
	}
	if w := apiRequest(a, "POST", "/api/public/invitations/"+token+"/redeem", "", original, nil); w.Code != 200 || responseData(t, w)["status"] != "completed" {
		t.Fatal(w.Code, w.Body.String())
	}
	for _, f := range []*reviewFixture{first, second} {
		f.mu.Lock()
		creates, passwords := f.creates, f.passwordWrites
		f.mu.Unlock()
		if creates != 1 || passwords != 2 {
			t.Fatal("incorrect recovery writes", creates, passwords)
		}
	}
}

func TestEmbyRecordedIdentityGuardsAndUnknownCreate(t *testing.T) {
	for _, mode := range []string{"identity", "administrator", "missing_policy", "broken_prefix", "unknown_create"} {
		t.Run(mode, func(t *testing.T) {
			a, _ := testApp(t)
			admin, _ := bootstrapOwner(t, a)
			f := newReviewFixtureFor(t, "emby", true)
			f.failCreate = mode == "unknown_create"
			job, _, _, ids := createFailedReviewJob(t, a, admin, f)
			f.mu.Lock()
			f.badIdentity, f.adminPolicy, f.missingPolicy, f.badPrefix = mode == "identity", mode == "administrator", mode == "missing_policy", mode == "broken_prefix"
			before := f.passwordWrites
			f.mu.Unlock()
			w := apiRequest(a, "POST", "/api/provisioning-jobs/"+job.ID+"/resume", admin, resumeBody(job, ids), nil)
			if w.Code == 200 {
				t.Fatal("unsafe Emby target resumed")
			}
			f.mu.Lock()
			creates, writes := f.creates, f.passwordWrites
			f.mu.Unlock()
			if creates != 1 || writes != before || !currentReview(t, a, job.ID).Reserved {
				t.Fatal("unsafe mutation or released capacity", creates, writes)
			}
		})
	}
}
