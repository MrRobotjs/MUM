package main

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func plexAdministratorLogin(t *testing.T, a *App) string {
	t.Helper()
	w := apiRequest(a, "POST", "/api/auth/login", "", map[string]any{"username": "owner", "password": "a-strong-new-password"}, nil)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	return responseData(t, w)["access_token"].(string)
}

func plexAdministratorBody(t *testing.T, a *App, s *Store, job string, server int64, activate bool) map[string]any {
	t.Helper()
	receipt, err := a.loadRedemption(t.Context(), job)
	if err != nil {
		t.Fatal(err)
	}
	return map[string]any{"job_revision": receipt.Revision, "checkpoint_revision": readPlexCheckpoint(t, s, job, server).Revision, "reason": "Reviewed narrow library verification and local activation", "verification_scope": plexLibraryVerificationScope, "acknowledge_in_flight_risk": true, "acknowledge_local_activation": activate}
}

func TestPlexAdministratorVerifyAndFinalizeRouted(t *testing.T) {
	a, s, job, server := plexVerificationFixture(t, nil)
	hash, err := hashPassword(invitationPassword)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.writer.Exec("UPDATE user_accounts SET password_hash=? WHERE uuid=(SELECT user_uuid FROM provisioning_jobs WHERE id=?)", hash, job); err != nil {
		t.Fatal(err)
	}
	token := plexAdministratorLogin(t, a)
	path := fmt.Sprintf("/api/provisioning-jobs/%s/plex/%d/", job, server)
	for _, action := range []string{"verify", "finalize"} {
		body := plexAdministratorBody(t, a, s, job, server, action == "finalize")
		w := apiRequest(a, "POST", path+action, token, body, nil)
		if w.Code != 200 || w.Header().Get("Cache-Control") != "no-store" {
			t.Fatal(action, w.Code, w.Body.String())
		}
		for _, secret := range []string{token, plexFixtureToken, "recipient-resource-secret", "machine_id", "share_id", "account_id"} {
			if strings.Contains(w.Body.String(), secret) {
				t.Fatal("receipt leaked", secret)
			}
		}
	}
	receipt, err := a.loadRedemption(t.Context(), job)
	if err != nil || receipt.Status != "completed" || receipt.Reserved || receipt.Plex.Phase != "completed" {
		t.Fatal("incomplete job", receipt, err)
	}
	var activated bool
	var uses, events int
	if err := s.reader.QueryRow("SELECT u.is_active,i.current_uses FROM provisioning_jobs j JOIN user_accounts u ON u.uuid=j.user_uuid JOIN invites i ON i.id=j.invite_id WHERE j.id=?", job).Scan(&activated, &uses); err != nil || !activated || uses != 1 {
		t.Fatal("incorrect activation/use", err)
	}
	if err := s.reader.QueryRow("SELECT count(*) FROM audit_events WHERE action LIKE 'plex.admin.%' AND actor_uuid=(SELECT uuid FROM user_accounts WHERE kind='owner') AND json_extract(details,'$.job_id')=? AND json_extract(details,'$.verification_scope')=?", job, plexLibraryVerificationScope).Scan(&events); err != nil || events != 4 {
		t.Fatal("actor audit missing", events, err)
	}
	var details string
	if err := s.reader.QueryRow("SELECT group_concat(details) FROM audit_events WHERE action LIKE 'plex.admin.%'").Scan(&details); err != nil || strings.Contains(details, token) || strings.Contains(details, plexFixtureToken) {
		t.Fatal("audit leaked", err)
	}
	w := apiRequest(a, "POST", path+"finalize", token, plexAdministratorBody(t, a, s, job, server, true), nil)
	if w.Code != 409 {
		t.Fatal("completed job replayed", w.Code, w.Body.String())
	}
	if err := s.reader.QueryRow("SELECT i.current_uses FROM invites i JOIN provisioning_jobs j ON j.invite_id=i.id WHERE j.id=?", job).Scan(&uses); err != nil || uses != 1 {
		t.Fatal("replay consumed capacity", err)
	}
}

func TestPlexAdministratorActionConfirmationGuards(t *testing.T) {
	a, s, job, server := plexVerificationFixture(t, nil)
	token := plexAdministratorLogin(t, a)
	path := fmt.Sprintf("/api/provisioning-jobs/%s/plex/%d/verify", job, server)
	if w := apiRequest(a, "POST", path, "", nil, nil); w.Code != 401 {
		t.Fatal("anonymous action", w.Code)
	}
	for _, mode := range []string{"reason", "scope", "risk", "activation", "unknown-field", "job-revision", "checkpoint-revision"} {
		t.Run(mode, func(t *testing.T) {
			body := plexAdministratorBody(t, a, s, job, server, false)
			want := 400
			switch mode {
			case "reason":
				body["reason"] = "short"
			case "scope":
				body["verification_scope"] = "playback"
			case "risk":
				body["acknowledge_in_flight_risk"] = false
			case "activation":
				body["acknowledge_local_activation"] = true
			case "unknown-field":
				body["remote_delete"] = true
			case "job-revision":
				body["job_revision"] = int64(999)
				want = 409
			case "checkpoint-revision":
				body["checkpoint_revision"] = int64(999)
				want = 409
			}
			if w := apiRequest(a, "POST", path, token, body, nil); w.Code != want {
				t.Fatal(w.Code, w.Body.String())
			}
		})
	}
	for _, action := range []string{"send", "cancel"} {
		if w := apiRequest(a, "POST", strings.TrimSuffix(path, "verify")+action, token, plexAdministratorBody(t, a, s, job, server, false), nil); w.Code != 404 {
			t.Fatal("unavailable remote mutation exposed", w.Code)
		}
	}
	r := httptest.NewRequest("POST", path, strings.NewReader("{}"))
	r.Header.Set("Authorization", "Bearer "+token)
	r.Header.Set("Origin", "https://foreign.invalid")
	w := httptest.NewRecorder()
	a.ServeHTTP(w, r)
	if w.Code != 403 {
		t.Fatal("cross origin action", w.Code)
	}
}

func plexDelegatedAdministrator(t *testing.T, a *App, s *Store, permitted bool) string {
	t.Helper()
	var owner string
	if err := s.reader.QueryRow("SELECT uuid FROM user_accounts WHERE kind='owner'").Scan(&owner); err != nil {
		t.Fatal(err)
	}
	hash, err := hashPassword(invitationPassword)
	if err != nil {
		t.Fatal(err)
	}
	user, err := s.CreateAccount(t.Context(), owner, "delegated-reviewer", hash, false)
	if err != nil {
		t.Fatal(err)
	}
	if permitted {
		for _, statement := range []string{
			"INSERT INTO admin_roles(id,name) VALUES('plex-reviewer','Plex reviewer')",
			"INSERT OR IGNORE INTO admin_permissions(id,name) VALUES('plex-admin','administrator')",
			"INSERT INTO admin_role_permissions SELECT 'plex-reviewer',id FROM admin_permissions WHERE name='administrator'",
		} {
			if _, err := s.writer.Exec(statement); err != nil {
				t.Fatal(err)
			}
		}
		if _, err := s.writer.Exec("INSERT INTO admin_privileges VALUES(?,'plex-reviewer')", user); err != nil {
			t.Fatal(err)
		}
	}
	w := apiRequest(a, "POST", "/api/auth/login", "", map[string]any{"username": "delegated-reviewer", "password": invitationPassword}, nil)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	return responseData(t, w)["access_token"].(string)
}

func TestPlexAdministratorRejectsOrdinaryUser(t *testing.T) {
	a, s, job, server := plexVerificationFixture(t, nil)
	token := plexDelegatedAdministrator(t, a, s, false)
	w := apiRequest(a, "POST", fmt.Sprintf("/api/provisioning-jobs/%s/plex/%d/verify", job, server), token, plexAdministratorBody(t, a, s, job, server, false), nil)
	if w.Code != 403 {
		t.Fatal(w.Code, w.Body.String())
	}
}

func TestPlexAdministratorVerificationRechecksActorAfterHTTP(t *testing.T) {
	for _, mode := range []string{"session", "permission"} {
		t.Run(mode, func(t *testing.T) {
			var token string
			changed := false
			a, s, job, server := plexVerificationFixture(t, func(s *Store, _ string, _ int64) {
				changed = true
				var err error
				if mode == "session" {
					_, err = s.writer.Exec("DELETE FROM session_access_tokens WHERE token_hash=?", tokenHash(token))
				} else {
					_, err = s.writer.Exec("DELETE FROM admin_role_permissions WHERE role_id='plex-reviewer'")
				}
				if err != nil {
					t.Error(err)
				}
			})
			if mode == "session" {
				token = plexAdministratorLogin(t, a)
			} else {
				token = plexDelegatedAdministrator(t, a, s, true)
			}
			w := apiRequest(a, "POST", fmt.Sprintf("/api/provisioning-jobs/%s/plex/%d/verify", job, server), token, plexAdministratorBody(t, a, s, job, server, false), nil)
			if !changed || w.Code != 403 {
				t.Fatal("revoked actor accepted", changed, w.Code, w.Body.String())
			}
			var count int
			if err := s.reader.QueryRow("SELECT count(*) FROM plex_library_verifications WHERE job_id=?", job).Scan(&count); err != nil || count != 0 {
				t.Fatal("unauthorized provenance", err)
			}
			assertPlexAdministratorJobRetained(t, s, job)
		})
	}
}

func assertPlexAdministratorJobRetained(t *testing.T, s *Store, job string) {
	t.Helper()
	var retained bool
	if err := s.reader.QueryRow("SELECT j.reservation_held=1 AND u.is_active=0 AND i.current_uses=0 FROM provisioning_jobs j JOIN user_accounts u ON u.uuid=j.user_uuid JOIN invites i ON i.id=j.invite_id WHERE j.id=?", job).Scan(&retained); err != nil || !retained {
		t.Fatal("unauthorized activation/capacity release", err)
	}
	var count int
	if err := s.reader.QueryRow("SELECT count(*) FROM audit_events WHERE action IN ('plex.admin.verify.completed','plex.admin.finalize.completed')").Scan(&count); err != nil || count != 0 {
		t.Fatal("unauthorized success audit", err)
	}
}

func TestPlexAdministratorFinalizationRechecksActorAfterHTTP(t *testing.T) {
	for _, mode := range []string{"session", "permission"} {
		t.Run(mode, func(t *testing.T) {
			a, s, job, server, _ := verifiedPlexFinalizationFixture(t)
			token := ""
			if mode == "session" {
				token = plexAdministratorLogin(t, a)
			} else {
				token = plexDelegatedAdministrator(t, a, s, true)
			}
			original := a.ProviderHTTP.Transport
			changed := false
			a.ProviderHTTP.Transport = providerTransport(func(r *http.Request) (*http.Response, error) {
				if r.URL.Path == "/api/v2/user" {
					changed = true
					var err error
					if mode == "session" {
						_, err = s.writer.Exec("DELETE FROM session_access_tokens WHERE token_hash=?", tokenHash(token))
					} else {
						_, err = s.writer.Exec("DELETE FROM admin_role_permissions WHERE role_id='plex-reviewer'")
					}
					if err != nil {
						t.Error(err)
					}
				}
				return original.RoundTrip(r)
			})
			w := apiRequest(a, "POST", fmt.Sprintf("/api/provisioning-jobs/%s/plex/%d/finalize", job, server), token, plexAdministratorBody(t, a, s, job, server, true), nil)
			if !changed || w.Code != 403 {
				t.Fatal("revoked finalizer accepted", changed, w.Code, w.Body.String())
			}
			assertPlexAdministratorJobRetained(t, s, job)
			var count int
			if err := s.reader.QueryRow("SELECT count(*) FROM plex_job_completions").Scan(&count); err != nil || count != 0 {
				t.Fatal("unauthorized completion", err)
			}
			if err := s.reader.QueryRow("SELECT count(*) FROM plex_connections").Scan(&count); err != nil || count != 0 {
				t.Fatal("unauthorized promotion", err)
			}
		})
	}
}

func TestPlexAdministratorFinalizationRequiresFreshEvidenceAndActivationConsent(t *testing.T) {
	for _, mode := range []string{"activation", "expired-evidence", "stale-checkpoint"} {
		t.Run(mode, func(t *testing.T) {
			a, s, job, server, _ := verifiedPlexFinalizationFixture(t)
			token := plexAdministratorLogin(t, a)
			body := plexAdministratorBody(t, a, s, job, server, true)
			want := 409
			switch mode {
			case "activation":
				body["acknowledge_local_activation"] = false
				want = 400
			case "expired-evidence":
				if _, err := s.writer.Exec("UPDATE plex_library_verifications SET valid_until='2000-01-01T00:00:00.000Z' WHERE job_id=?", job); err != nil {
					t.Fatal(err)
				}
			case "stale-checkpoint":
				body["checkpoint_revision"] = int64(999)
			}
			w := apiRequest(a, "POST", fmt.Sprintf("/api/provisioning-jobs/%s/plex/%d/finalize", job, server), token, body, nil)
			if w.Code != want {
				t.Fatal(w.Code, w.Body.String())
			}
			assertPlexAdministratorJobRetained(t, s, job)
		})
	}
}

func TestPlexAdministratorRefreshRechecksActorBeforeCredentialPersistence(t *testing.T) {
	for _, mode := range []string{"session", "permission", "job-revision"} {
		t.Run(mode, func(t *testing.T) {
			a, s, job, server := plexVerificationFixture(t, nil)
			token := ""
			if mode == "permission" {
				token = plexDelegatedAdministrator(t, a, s, true)
			} else {
				token = plexAdministratorLogin(t, a)
			}
			var before []byte
			if err := s.reader.QueryRow("SELECT secret FROM plex_invitation_credentials WHERE job_id=?", job).Scan(&before); err != nil {
				t.Fatal(err)
			}
			original := a.ProviderHTTP.Transport
			changed := false
			a.ProviderHTTP.Transport = providerTransport(func(r *http.Request) (*http.Response, error) {
				if r.URL.Path == "/api/v2/user" {
					changed = true
					var err error
					switch mode {
					case "session":
						_, err = s.writer.Exec("DELETE FROM session_access_tokens WHERE token_hash=?", tokenHash(token))
					case "permission":
						_, err = s.writer.Exec("DELETE FROM admin_role_permissions WHERE role_id='plex-reviewer'")
					case "job-revision":
						_, err = s.writer.Exec("UPDATE provisioning_jobs SET revision=revision+1 WHERE id=?", job)
					}
					if err != nil {
						t.Error(err)
					}
				}
				return original.RoundTrip(r)
			})
			w := apiRequest(a, "POST", fmt.Sprintf("/api/provisioning-jobs/%s/plex/%d/verify", job, server), token, plexAdministratorBody(t, a, s, job, server, false), nil)
			want := 403
			if mode == "job-revision" {
				want = 409
			}
			if !changed || w.Code != want {
				t.Fatal("revoked refresh accepted", changed, w.Code, w.Body.String())
			}
			var after []byte
			var lease string
			if err := s.reader.QueryRow("SELECT secret,coalesce(refresh_token,'') FROM plex_invitation_credentials WHERE job_id=?", job).Scan(&after, &lease); err != nil || string(before) != string(after) || lease != "" {
				t.Fatal("unauthorized credential persisted or lease retained", err)
			}
			assertPlexAdministratorJobRetained(t, s, job)
		})
	}
}
