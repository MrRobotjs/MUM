package main

import (
	"errors"
	"net/http/httptest"
	"testing"
	"time"
)

func TestAdminActivationClaimFirstBlocksUntilDispatchedReviewFinishes(t *testing.T) {
	for _, resume := range []bool{false, true} {
		t.Run(map[bool]string{false: "disable", true: "resume"}[resume], func(t *testing.T) {
			a, s, ownerAccess, access, actor := roleReadFixture(t)
			f := newReviewFixture(t, true)
			job, _, _, ids := createFailedReviewJob(t, a, ownerAccess, f)
			path := "/api/users/" + actor + "/activation"
			before := responseData(t, apiRequest(a, "GET", path, ownerAccess, nil, nil))
			if before["can_deactivate"] != true {
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
			current := responseData(t, apiRequest(a, "GET", path, ownerAccess, nil, nil))
			if current["availability"] != "pending_work" || current["can_deactivate"] != false {
				t.Fatal(current)
			}
			if w := apiRequest(a, "PUT", path, ownerAccess, activationBody(before, false), nil); w.Code != 409 {
				t.Fatal("deactivation crossed dispatched review", w.Code, w.Body.String())
			}
			if _, err := s.Authenticate(t.Context(), access); err != nil {
				t.Fatal("blocked activation revoked session", err)
			}
			// Release every subsequent inspection too, without holding the writer.
			f.mu.Lock()
			f.beforeInspect = nil
			f.mu.Unlock()
			release <- struct{}{}
			select {
			case w := <-done:
				if w.Code != 200 {
					t.Fatal("review failed", w.Code, w.Body.String())
				}
			case <-time.After(10 * time.Second):
				t.Fatal("review did not finish")
			}
			current = responseData(t, apiRequest(a, "GET", path, ownerAccess, nil, nil))
			responseData(t, apiRequest(a, "PUT", path, ownerAccess, activationBody(current, false), nil))
			if _, err := s.Authenticate(t.Context(), access); err == nil {
				t.Fatal("administrator session survived deactivation")
			}
		})
	}
}

func TestAdminActivationDeactivationFirstPreventsClaimsAndOldSessionRevival(t *testing.T) {
	a, s, ownerAccess, access, actor := roleReadFixture(t)
	job, old := reviewAuthorityJob(t, a, s, actor, access)
	if err := a.finishReview(job, old, "REVIEW_REQUIRED"); err != nil {
		t.Fatal(err)
	}
	path := "/api/users/" + actor + "/activation"
	for _, active := range []bool{false, true} {
		before := responseData(t, apiRequest(a, "GET", path, ownerAccess, nil, nil))
		responseData(t, apiRequest(a, "PUT", path, ownerAccess, activationBody(before, active), nil))
		var revision int64
		if err := s.reader.QueryRow("SELECT revision FROM provisioning_jobs WHERE id=?", job).Scan(&revision); err != nil {
			t.Fatal(err)
		}
		// Simulates a request authenticated before the activation writer committed.
		if _, err := a.claimReview(t.Context(), actor, access, job, revision); !errors.Is(err, ErrForbidden) {
			t.Fatal("revoked originating session claimed work", err)
		}
	}
	var grants int
	if err := s.reader.QueryRow("SELECT count(*) FROM admin_privileges WHERE user_uuid=? AND role_id='high'", actor).Scan(&grants); err != nil || grants != 1 {
		t.Fatal("activation altered grants", grants, err)
	}
	fresh, err := s.issueSession(t.Context(), actor, false)
	if err != nil {
		t.Fatal(err)
	}
	var revision int64
	if err := s.reader.QueryRow("SELECT revision FROM provisioning_jobs WHERE id=?", job).Scan(&revision); err != nil {
		t.Fatal(err)
	}
	claim, err := a.claimReview(t.Context(), actor, fresh.Access, job, revision)
	if err != nil {
		t.Fatal("fresh reactivated administrator cannot claim", err)
	}
	if err = a.finishReview(job, old, "STALE_CLEANUP"); err != nil {
		t.Fatal(err)
	}
	current := responseData(t, apiRequest(a, "GET", path, ownerAccess, nil, nil))
	if current["availability"] != "pending_work" {
		t.Fatal("stale cleanup removed newer barrier", current)
	}
	guard := reviewRequestAuthority{s, actor, job, claim}
	if err = guard.check(t.Context()); err != nil {
		t.Fatal("new claim lost authority", err)
	}
}
