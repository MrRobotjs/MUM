package main

import (
	"context"
	"database/sql"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

func reviewAuthorityJob(t *testing.T, a *App, s *Store, actor, access string) (string, string) {
	t.Helper()
	target, err := s.CreateAccount(t.Context(), actor, "review-authority-target", "fixture-hash", false)
	if err != nil {
		t.Fatal(err)
	}
	job := newUUID()
	if _, err = s.writer.Exec("UPDATE user_accounts SET is_active=0 WHERE uuid=?", target); err != nil {
		t.Fatal(err)
	}
	if _, err = s.writer.Exec(`INSERT INTO provisioning_jobs(id,user_uuid,status,reservation_held,created_at,updated_at) VALUES(?,?,'failed',1,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')`, job, target); err != nil {
		t.Fatal(err)
	}
	token, err := a.claimReview(t.Context(), actor, access, job, 1)
	if err != nil {
		t.Fatal(err)
	}
	return job, token
}

func TestReviewAuthorityPersistsExactActorSessionAndClearsOnFinish(t *testing.T) {
	a, s, ownerToken, otherToken, other := roleReadFixture(t)
	owner, _ := s.Authenticate(t.Context(), ownerToken)
	job, token := reviewAuthorityJob(t, a, s, owner.UUID, ownerToken)
	var actor, hash string
	var revision int64
	if err := s.reader.QueryRow("SELECT review_actor_uuid,review_access_hash,review_role_revision FROM provisioning_jobs WHERE id=?", job).Scan(&actor, &hash, &revision); err != nil || actor != owner.UUID || hash != tokenHash(ownerToken) || hash == ownerToken || revision < 1 {
		t.Fatal(actor, hash, revision, err)
	}
	guard := reviewRequestAuthority{s, owner.UUID, job, token}
	if err := guard.check(t.Context()); err != nil {
		t.Fatal(err)
	}
	wrong := reviewRequestAuthority{s, other, job, token}
	if err := wrong.check(t.Context()); !errors.Is(err, ErrForbidden) {
		t.Fatal("other administrator adopted claim", err)
	}
	if _, err := s.Authenticate(t.Context(), otherToken); err != nil {
		t.Fatal(err)
	}
	if err := a.finishReview(job, token, "REVIEW_REQUIRED"); err != nil {
		t.Fatal(err)
	}
	var cleared bool
	if err := s.reader.QueryRow("SELECT review_token IS NULL AND review_actor_uuid IS NULL AND review_access_hash IS NULL AND review_role_revision IS NULL AND reservation_held=1 FROM provisioning_jobs WHERE id=?", job).Scan(&cleared); err != nil || !cleared {
		t.Fatal("claim not cleared/held capacity changed", err)
	}
	if err := guard.check(t.Context()); !errors.Is(err, ErrForbidden) {
		t.Fatal("finished claim survived", err)
	}
	var nextRevision int64
	s.reader.QueryRow("SELECT revision FROM provisioning_jobs WHERE id=?", job).Scan(&nextRevision)
	next, err := a.claimReview(t.Context(), owner.UUID, ownerToken, job, nextRevision)
	if err != nil {
		t.Fatal(err)
	}
	if err = a.finishReview(job, token, "STALE_CLEANUP"); err != nil {
		t.Fatal(err)
	}
	nextGuard := reviewRequestAuthority{s, owner.UUID, job, next}
	if err = nextGuard.check(t.Context()); err != nil {
		t.Fatal("stale cleanup erased a newer claim", err)
	}
}

func TestReviewAuthorityLostSessionEpochAndUnattributedClaims(t *testing.T) {
	for _, mode := range []string{"deleted-access", "expired-access", "expired-family", "new-session", "epoch", "unattributed"} {
		t.Run(mode, func(t *testing.T) {
			a, s := testApp(t)
			access, _ := bootstrapOwner(t, a)
			actor, _ := s.Authenticate(t.Context(), access)
			job, token := reviewAuthorityJob(t, a, s, actor.UUID, access)
			var err error
			switch mode {
			case "deleted-access", "new-session":
				_, err = s.writer.Exec("DELETE FROM app_sessions WHERE user_uuid=?", actor.UUID)
			case "expired-access":
				_, err = s.writer.Exec("UPDATE session_access_tokens SET expires_at='2000-01-01T00:00:00Z' WHERE token_hash=?", tokenHash(access))
			case "expired-family":
				_, err = s.writer.Exec("UPDATE app_sessions SET refresh_expires_at='2000-01-01T00:00:00Z' WHERE user_uuid=?", actor.UUID)
			case "epoch":
				_, err = s.writer.Exec("UPDATE admin_role_state SET revision=revision+1 WHERE singleton=1")
			case "unattributed":
				_, err = s.writer.Exec("UPDATE provisioning_jobs SET review_actor_uuid=NULL,review_access_hash=NULL,review_role_revision=NULL WHERE id=?", job)
			}
			if err != nil {
				t.Fatal(err)
			}
			if mode == "new-session" {
				if _, err := s.issueSession(t.Context(), actor.UUID, false); err != nil {
					t.Fatal(err)
				}
			}
			guard := reviewRequestAuthority{s, actor.UUID, job, token}
			if err := guard.check(t.Context()); !errors.Is(err, ErrForbidden) {
				t.Fatal("stale authority accepted", err)
			}
			if err := a.finishReview(job, token, "REVIEW_REQUIRED"); err != nil {
				t.Fatal("cleanup required revoked credentials", err)
			}
		})
	}
}

func TestReviewAuthorityRefreshKeepsStillValidOriginatingAccess(t *testing.T) {
	a, s := testApp(t)
	access, cookie := bootstrapOwner(t, a)
	actor, _ := s.Authenticate(t.Context(), access)
	job, token := reviewAuthorityJob(t, a, s, actor.UUID, access)
	if _, _, err := s.refreshSession(t.Context(), cookie.Value); err != nil {
		t.Fatal(err)
	}
	// Parallel-refresh semantics keep the old access entry valid until its own
	// expiry. The claim does not silently rebind to the newly issued token.
	guard := reviewRequestAuthority{s, actor.UUID, job, token}
	if err := guard.check(t.Context()); err != nil {
		t.Fatal(err)
	}
	var stored string
	s.reader.QueryRow("SELECT review_access_hash FROM provisioning_jobs WHERE id=?", job).Scan(&stored)
	if stored != tokenHash(access) {
		t.Fatal("claim rebound on refresh")
	}
}

func TestReviewAuthorityPreventsDispatchAndRejectsLostAuthorityAfterMutation(t *testing.T) {
	for _, phase := range []string{"before", "after"} {
		t.Run(phase, func(t *testing.T) {
			a, s := testApp(t)
			access, _ := bootstrapOwner(t, a)
			actor, _ := s.Authenticate(t.Context(), access)
			job, token := reviewAuthorityJob(t, a, s, actor.UUID, access)
			var requests atomic.Int64
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				requests.Add(1)
				if _, err := s.writer.Exec("DELETE FROM app_sessions WHERE user_uuid=?", actor.UUID); err != nil {
					t.Error(err)
				}
				w.WriteHeader(204)
			}))
			defer server.Close()
			provider, err := newServerConnection(ProviderConfig{"jellyfin", server.URL, "fixture-key"}, nil)
			if err != nil {
				t.Fatal(err)
			}
			client := provider
			client.reviewAuthority = &reviewRequestAuthority{s, actor.UUID, job, token}
			if phase == "before" {
				if _, err = s.writer.Exec("DELETE FROM app_sessions WHERE user_uuid=?", actor.UUID); err != nil {
					t.Fatal(err)
				}
			}
			if _, err = guardedRequest(t, client, http.MethodPost, server.URL, nil); !errors.Is(err, ErrForbidden) {
				t.Fatal("lost authority accepted", err)
			}
			if _, err = guardedRequest(t, client, http.MethodPost, server.URL, nil); !errors.Is(err, ErrForbidden) {
				t.Fatal("revoked request replayed", err)
			}
			want := int64(0)
			if phase == "after" {
				want = 1
			}
			if requests.Load() != want {
				t.Fatal("unexpected provider dispatches", requests.Load())
			}
			var held bool
			s.reader.QueryRow("SELECT review_token IS NOT NULL AND reservation_held=1 AND status='failed' FROM provisioning_jobs WHERE id=?", job).Scan(&held)
			if !held {
				t.Fatal("uncertain work released capacity")
			}
		})
	}
}

func TestReviewRuntimeSessionLossDuringInspectionStopsFurtherRemoteWork(t *testing.T) {
	for _, resume := range []bool{false, true} {
		t.Run(map[bool]string{false: "disable", true: "resume"}[resume], func(t *testing.T) {
			a, s := testApp(t)
			access, _ := bootstrapOwner(t, a)
			actor, _ := s.Authenticate(t.Context(), access)
			f := newReviewFixture(t, true)
			job, _, _, ids := createFailedReviewJob(t, a, access, f)
			f.mu.Lock()
			f.failEnable = false
			beforeWrites, beforePasswords := f.disables, f.passwordWrites
			f.beforeInspect = func() {
				if _, err := s.writer.Exec("DELETE FROM app_sessions WHERE user_uuid=?", actor.UUID); err != nil {
					t.Error(err)
				}
			}
			f.mu.Unlock()
			path := "/api/provisioning-jobs/" + job.ID + "/disable-accounts"
			body := reviewBody(job)
			if resume {
				path = "/api/provisioning-jobs/" + job.ID + "/resume"
				body = resumeBody(job, ids)
			}
			w := apiRequest(a, "POST", path, access, body, nil)
			if w.Code < 400 {
				t.Fatal("revoked review succeeded", w.Code, w.Body.String())
			}
			f.mu.Lock()
			writes, passwords := f.disables, f.passwordWrites
			f.mu.Unlock()
			if writes != beforeWrites || passwords != beforePasswords {
				t.Fatal("post-revocation mutation", writes, passwords)
			}
			after := currentReview(t, a, job.ID)
			if !after.Reserved || after.Reviewing || after.Status != "failed" {
				t.Fatal(after)
			}
			var clean bool
			s.reader.QueryRow("SELECT review_actor_uuid IS NULL AND review_access_hash IS NULL AND review_role_revision IS NULL FROM provisioning_jobs WHERE id=?", job.ID).Scan(&clean)
			if !clean {
				t.Fatal("private attribution left behind")
			}
		})
	}
}

func TestReviewAuthorityRestartClearsProofWithoutReplayAndRedactsDTO(t *testing.T) {
	a, s := testApp(t)
	access, _ := bootstrapOwner(t, a)
	actor, _ := s.Authenticate(t.Context(), access)
	f := newReviewFixture(t, true)
	failed, _, _, _ := createFailedReviewJob(t, a, access, f)
	job := failed.ID
	token, err := a.claimReview(t.Context(), actor.UUID, access, job, failed.Revision)
	if err != nil {
		t.Fatal(err)
	}
	// Public job projection never loads any of the private authority columns.
	w := apiRequest(a, "GET", "/api/provisioning-jobs/"+job, access, nil, nil)
	if w.Code != 200 {
		t.Fatal("public projection failed", w.Code, w.Body.String())
	}
	for _, private := range []string{"review_actor_uuid", "review_access_hash", "review_role_revision", token, tokenHash(access)} {
		if strings.Contains(w.Body.String(), private) {
			t.Fatal("private claim leaked", private)
		}
	}
	if err := a.recoverProvisioning(context.Background()); err != nil {
		t.Fatal(err)
	}
	var clean bool
	s.reader.QueryRow("SELECT review_token IS NULL AND review_actor_uuid IS NULL AND review_access_hash IS NULL AND review_role_revision IS NULL AND reservation_held=1 AND status='failed' FROM provisioning_jobs WHERE id=?", job).Scan(&clean)
	if !clean {
		t.Fatal("restart changed held work/left proof")
	}
	guard := reviewRequestAuthority{s, actor.UUID, job, token}
	if err := guard.check(t.Context()); !errors.Is(err, ErrForbidden) {
		t.Fatal("restart proof reused", err)
	}
}

func TestReviewClaimRequiresLiveOriginatingSession(t *testing.T) {
	a, s := testApp(t)
	access, _ := bootstrapOwner(t, a)
	actor, _ := s.Authenticate(t.Context(), access)
	job, token := reviewAuthorityJob(t, a, s, actor.UUID, access)
	if err := a.finishReview(job, token, "REVIEW_REQUIRED"); err != nil {
		t.Fatal(err)
	}
	var revision int64
	s.reader.QueryRow("SELECT revision FROM provisioning_jobs WHERE id=?", job).Scan(&revision)
	if _, err := a.claimReview(t.Context(), actor.UUID, strings.Repeat("x", 43), job, revision); !errors.Is(err, ErrForbidden) {
		t.Fatal("unbound claim admitted", err)
	}
	err := s.write(t.Context(), func(tx *sql.Tx) error {
		var held bool
		if err := tx.QueryRow("SELECT review_token IS NOT NULL FROM provisioning_jobs WHERE id=?", job).Scan(&held); err != nil {
			return err
		}
		if held {
			t.Fatal("rejected claim persisted")
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}

type reviewBodyRevocation struct {
	store *Store
	actor string
	text  *strings.Reader
	fired bool
}

func (b *reviewBodyRevocation) Read(out []byte) (int, error) {
	if !b.fired {
		b.fired = true
		if _, err := b.store.writer.Exec("DELETE FROM app_sessions WHERE user_uuid=?", b.actor); err != nil {
			return 0, err
		}
	}
	return b.text.Read(out)
}
func (b *reviewBodyRevocation) Close() error { return nil }

type reviewBodyTransport struct {
	store *Store
	actor string
}

func (p *reviewBodyTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	return &http.Response{StatusCode: 200, Header: make(http.Header), Request: r, Body: &reviewBodyRevocation{p.store, p.actor, strings.NewReader(`{"ok":true}`), false}}, nil
}

func TestReviewAuthorityRejectsRevocationWhileReadingResponseBody(t *testing.T) {
	a, s := testApp(t)
	access, _ := bootstrapOwner(t, a)
	actor, _ := s.Authenticate(t.Context(), access)
	job, token := reviewAuthorityJob(t, a, s, actor.UUID, access)
	provider, err := newServerConnection(ProviderConfig{"jellyfin", "http://fixture.invalid", "fixture-key"}, &http.Client{Transport: &reviewBodyTransport{s, actor.UUID}})
	if err != nil {
		t.Fatal(err)
	}
	client := provider
	client.reviewAuthority = &reviewRequestAuthority{s, actor.UUID, job, token}
	if _, err = guardedRequest(t, client, http.MethodGet, "http://fixture.invalid/response", nil); !errors.Is(err, ErrForbidden) {
		t.Fatal("body accepted after revocation", err)
	}
}

func TestReviewAuthorityGrantRemovalAndRestorationCannotReviveClaim(t *testing.T) {
	a, s, _, access, actor := roleReadFixture(t)
	job, token := reviewAuthorityJob(t, a, s, actor, access)
	if _, err := s.writer.Exec("DELETE FROM admin_role_permissions WHERE role_id='high' AND permission_id='admin'"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.writer.Exec("INSERT INTO admin_role_permissions VALUES('high','admin')"); err != nil {
		t.Fatal(err)
	}
	tx, err := s.reader.BeginTx(t.Context(), &sql.TxOptions{ReadOnly: true})
	if err != nil {
		t.Fatal(err)
	}
	if err = requirePermission(t.Context(), tx, actor, "administrator"); err != nil {
		t.Fatal("grant not restored", err)
	}
	tx.Rollback()
	guard := reviewRequestAuthority{s, actor, job, token}
	if err = guard.check(t.Context()); !errors.Is(err, ErrForbidden) {
		t.Fatal("grant cycle revived old claim", err)
	}
}
