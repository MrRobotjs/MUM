package main

import (
	"database/sql"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestAdminCredentialsClaimFirstBlocksUntilDispatchedReviewFinishes(t *testing.T) {
	for _, resume := range []bool{false, true} {
		t.Run(map[bool]string{false: "disable", true: "resume"}[resume], func(t *testing.T) {
			a, s, ownerAccess, access, actor := roleReadFixture(t)
			f := newReviewFixture(t, true)
			job, _, _, ids := createFailedReviewJob(t, a, ownerAccess, f)
			path := "/api/users/" + actor + "/local-credentials"
			before := credentialRead(t, a, ownerAccess, actor)
			if !before.CanReset {
				t.Fatal(before)
			}
			entered, release := make(chan struct{}, 1), make(chan struct{})
			defer close(release)
			f.mu.Lock()
			f.failEnable = false
			f.beforeInspect = func() {
				select {
				case entered <- struct{}{}:
				default:
				}
				<-release
			}
			f.mu.Unlock()
			reviewPath := "/api/provisioning-jobs/" + job.ID + "/disable-accounts"
			body := reviewBody(job)
			if resume {
				reviewPath = "/api/provisioning-jobs/" + job.ID + "/resume"
				body = resumeBody(job, ids)
			}
			done := make(chan *httptest.ResponseRecorder, 1)
			go func() { done <- apiRequest(a, "POST", reviewPath, access, body, nil) }()
			select {
			case <-entered:
			case <-time.After(10 * time.Second):
				t.Fatal("review did not dispatch")
			}
			current := credentialRead(t, a, ownerAccess, actor)
			if current.Reason != "pending_work" || current.CanReset {
				t.Fatal(current)
			}
			state := credentialState(t, s, actor)
			if w := apiRequest(a, "PUT", path, ownerAccess, credentialInput(before), nil); w.Code != 409 {
				t.Fatal("reset crossed dispatched review", w.Code, w.Body.String())
			}
			if credentialState(t, s, actor) != state {
				t.Fatal("blocked reset mutated credential state")
			}
			if _, err := s.Authenticate(t.Context(), access); err != nil {
				t.Fatal("blocked reset revoked session", err)
			}
			f.mu.Lock()
			f.beforeInspect = nil
			f.mu.Unlock()
			release <- struct{}{}
			select {
			case w := <-done:
				if w.Code != 200 {
					t.Fatal(w.Code, w.Body.String())
				}
			case <-time.After(10 * time.Second):
				t.Fatal("review did not finish")
			}
			current = credentialRead(t, a, ownerAccess, actor)
			if w := apiRequest(a, "PUT", path, ownerAccess, credentialInput(current), nil); w.Code != 200 {
				t.Fatal(w.Code, w.Body.String())
			}
			if _, err := s.Authenticate(t.Context(), access); err == nil {
				t.Fatal("administrator session survived reset")
			}
		})
	}
}
func TestAdminCredentialsResetFirstPreventsOldClaimsAndPreservesGrants(t *testing.T) {
	a, s, ownerAccess, access, actor := roleReadFixture(t)
	job, old := reviewAuthorityJob(t, a, s, actor, access)
	if err := a.finishReview(job, old, "REVIEW_REQUIRED"); err != nil {
		t.Fatal(err)
	}
	p := credentialRead(t, a, ownerAccess, actor)
	if w := apiRequest(a, "PUT", "/api/users/"+actor+"/local-credentials", ownerAccess, credentialInput(p), nil); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	var revision int64
	if err := s.reader.QueryRow("SELECT revision FROM provisioning_jobs WHERE id=?", job).Scan(&revision); err != nil {
		t.Fatal(err)
	}
	if _, err := a.claimReview(t.Context(), actor, access, job, revision); !errors.Is(err, ErrForbidden) {
		t.Fatal("revoked session claimed work", err)
	}
	login := apiRequest(a, "POST", "/api/auth/login", "", map[string]any{"username": "role-reader", "password": credentialNewPassword}, nil)
	data := responseData(t, login)
	fresh := data["access_token"].(string)
	principal, err := s.Authenticate(t.Context(), fresh)
	if err != nil || !principal.Admin || principal.UUID != actor {
		t.Fatal(principal, err)
	}
	claim, err := a.claimReview(t.Context(), actor, fresh, job, revision)
	if err != nil {
		t.Fatal("fresh administrator cannot claim", err)
	}
	if err = a.finishReview(job, old, "STALE_CLEANUP"); err != nil {
		t.Fatal(err)
	}
	current := credentialRead(t, a, ownerAccess, actor)
	if current.Reason != "pending_work" || current.CanReset {
		t.Fatal("stale cleanup removed new claim", current)
	}
	guard := reviewRequestAuthority{s, actor, job, claim}
	if err = guard.check(t.Context()); err != nil {
		t.Fatal(err)
	}
	var grants int
	if err = s.reader.QueryRow("SELECT count(*) FROM admin_privileges WHERE user_uuid=? AND role_id='high'", actor).Scan(&grants); err != nil || grants != 1 {
		t.Fatal(grants, err)
	}
}
func TestAdminCredentialsPlexOperationBarriersPreservePreparedReset(t *testing.T) {
	for _, mode := range []string{"share operation", "credential refresh", "personal authorization"} {
		t.Run(mode, func(t *testing.T) {
			a, s, job, server, _ := plexCheckpointFixture(t)
			var owner string
			if err := s.reader.QueryRow("SELECT uuid FROM user_accounts WHERE kind='owner'").Scan(&owner); err != nil {
				t.Fatal(err)
			}
			session, err := s.issueSession(t.Context(), owner, false)
			if err != nil {
				t.Fatal(err)
			}
			actor, err := s.CreateAccount(t.Context(), owner, "barrier-admin", "fixture-hash", false)
			if err != nil {
				t.Fatal(err)
			}
			if _, err = s.writer.Exec("INSERT INTO admin_roles(id,name,position) VALUES('credential-admin','Credential administrator',10); INSERT INTO admin_role_permissions VALUES('credential-admin','admin'); INSERT INTO admin_privileges VALUES(?,'credential-admin')", actor); err != nil {
				t.Fatal(err)
			}
			input := credentialInput(credentialRead(t, a, session.Access, actor))
			prepared, err := a.prepareHumanCredentials(t.Context(), owner, session.Access, actor, input)
			if err != nil {
				t.Fatal(err)
			}
			switch mode {
			case "share operation":
				claimCheckpoint(t, s, readPlexCheckpoint(t, s, job, server), "send")
			case "credential refresh":
				if _, err = s.writer.Exec("UPDATE plex_invitation_credentials SET refresh_token='fixture-refresh',refresh_expires_at='2099-01-01T00:00:00Z' WHERE job_id=?", job); err != nil {
					t.Fatal(err)
				}
			case "personal authorization":
				if _, err = s.writer.Exec(`INSERT INTO plex_authorizations(id,owner_uuid,browser_hash,status,expires_at,poll_after,created_at,updated_at) VALUES('admin-credential-proof',?,'fixture','creating','2099-01-01T00:00:00Z','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')`, actor); err != nil {
					t.Fatal(err)
				}
			}
			current := credentialRead(t, a, session.Access, actor)
			if current.Reason != "pending_work" || current.CanReset {
				t.Fatal(current)
			}
			before := credentialState(t, s, actor)
			err = s.write(t.Context(), func(tx *sql.Tx) error { _, err := commitHumanCredentials(t.Context(), tx, prepared); return err })
			if err == nil || credentialState(t, s, actor) != before {
				t.Fatal("prepared reset crossed Plex work", err)
			}
		})
	}
}

func TestAdminCredentialsResetDuringManualSyncPreventsSnapshotCommit(t *testing.T) {
	a, s, ownerAccess, access, actor := roleReadFixture(t)
	upstream, _ := providerFixture(t, "jellyfin")
	a.ProviderHTTP = upstream.Client()
	id := createManagedServer(t, a, ownerAccess, "jellyfin", upstream.URL)
	entered, release := make(chan struct{}, 1), make(chan struct{})
	defer close(release)
	a.ProviderHTTP = &http.Client{Transport: providerTransport(func(r *http.Request) (*http.Response, error) {
		response, err := http.DefaultTransport.RoundTrip(r)
		if strings.HasSuffix(r.URL.Path, "/Users") {
			entered <- struct{}{}
			<-release
		}
		return response, err
	})}
	done := make(chan *httptest.ResponseRecorder, 1)
	go func() { done <- apiRequest(a, "POST", fmt.Sprintf("/api/servers/%d/sync", id), access, nil, nil) }()
	select {
	case <-entered:
	case <-time.After(10 * time.Second):
		t.Fatal("sync did not dispatch")
	}
	current := credentialRead(t, a, ownerAccess, actor)
	if w := apiRequest(a, "PUT", "/api/users/"+actor+"/local-credentials", ownerAccess, credentialInput(current), nil); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	release <- struct{}{}
	select {
	case w := <-done:
		if w.Code != 403 {
			t.Fatal("revoked sync committed", w.Code, w.Body.String())
		}
	case <-time.After(10 * time.Second):
		t.Fatal("sync did not finish")
	}
	var count int
	if err := s.reader.QueryRow("SELECT (SELECT count(*) FROM service_accounts WHERE server_id=?)+(SELECT count(*) FROM media_libraries WHERE server_id=?)", id, id).Scan(&count); err != nil || count != 0 {
		t.Fatal("revoked snapshot persisted", count, err)
	}
}
