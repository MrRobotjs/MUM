package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func publicPlexReceiptFixture(t *testing.T) (*App, *Store, string, string, map[string]any) {
	t.Helper()
	a, s, job, _, _ := plexCheckpointFixture(t)
	token, request := randomToken(), newUUID()
	hash, err := hashPassword(invitationPassword)
	if err != nil {
		t.Fatal(err)
	}
	for _, statement := range []struct {
		query string
		args  []any
	}{
		{"UPDATE invites SET token=? WHERE id=(SELECT invite_id FROM provisioning_jobs WHERE id=?)", []any{tokenHash(token), job}},
		{"UPDATE provisioning_jobs SET request_hash=?,requested_username='public-reader' WHERE id=?", []any{tokenHash(request), job}},
		{"UPDATE user_accounts SET local_username='public-reader',password_hash=? WHERE uuid=(SELECT user_uuid FROM provisioning_jobs WHERE id=?)", []any{hash, job}},
	} {
		if _, err := s.writer.Exec(statement.query, statement.args...); err != nil {
			t.Fatal(err)
		}
	}
	a.ProviderHTTP = &http.Client{Transport: providerTransport(func(*http.Request) (*http.Response, error) {
		t.Error("receipt performed provider work")
		return nil, ErrConflict
	})}
	return a, s, token, job, map[string]any{"job_id": job, "request_id": request, "username": "public-reader", "password": invitationPassword}
}

func TestPublicReceiptIsCredentialBoundAndNeverReserves(t *testing.T) {
	a, s, token, job, body := publicPlexReceiptFixture(t)
	path := "/api/public/invitations/" + token + "/receipt"
	w := apiRequest(a, "POST", path, "", body, nil)
	if w.Code != 200 || w.Header().Get("Cache-Control") != "no-store" || responseData(t, w)["id"] != job {
		t.Fatal(w.Code, w.Body.String())
	}
	for _, secret := range []string{token, body["request_id"].(string), invitationPassword, "user_uuid", "remote_id", "account_id", "machine_id", "share_id"} {
		if strings.Contains(w.Body.String(), secret) {
			t.Fatal("public receipt leaked", secret)
		}
	}
	for _, field := range []string{"job_id", "request_id", "username", "password"} {
		t.Run(field, func(t *testing.T) {
			bad := map[string]any{}
			for k, v := range body {
				bad[k] = v
			}
			switch field {
			case "job_id":
				bad[field] = newUUID()
			case "request_id":
				bad[field] = newUUID()
			default:
				bad[field] = "wrong-but-long-value"
			}
			w := apiRequest(a, "POST", path, "", bad, nil)
			if w.Code != 403 || strings.Contains(w.Body.String(), job) {
				t.Fatal("bad reference read receipt", w.Code, w.Body.String())
			}
		})
	}
	var jobs, uses int
	var held bool
	if err := s.reader.QueryRow("SELECT count(*) FROM provisioning_jobs").Scan(&jobs); err != nil {
		t.Fatal(err)
	}
	if err := s.reader.QueryRow("SELECT i.current_uses,j.reservation_held FROM invites i JOIN provisioning_jobs j ON j.invite_id=i.id WHERE j.id=?", job).Scan(&uses, &held); err != nil {
		t.Fatal(err)
	}
	if jobs != 1 || uses != 0 || !held {
		t.Fatal("receipt changed reservation", jobs, uses, held)
	}
}

func TestPublicReceiptReadsHistoryAfterRevocationAndRecovery(t *testing.T) {
	a, s, token, job, body := publicPlexReceiptFixture(t)
	if _, err := s.writer.Exec("UPDATE invites SET is_active=0,expires_at='2000-01-01T00:00:00.000Z' WHERE id=(SELECT invite_id FROM provisioning_jobs WHERE id=?)", job); err != nil {
		t.Fatal(err)
	}
	if err := a.recoverProvisioning(t.Context()); err != nil {
		t.Fatal(err)
	}
	w := apiRequest(a, "POST", "/api/public/invitations/"+token+"/receipt", "", body, nil)
	if w.Code != 200 || responseData(t, w)["status"] != "failed" {
		t.Fatal(w.Code, w.Body.String())
	}
	newHash, err := hashPassword("changed-local-password")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.writer.Exec("UPDATE user_accounts SET password_hash=? WHERE uuid=(SELECT user_uuid FROM provisioning_jobs WHERE id=?)", newHash, job); err != nil {
		t.Fatal(err)
	}
	if w := apiRequest(a, "POST", "/api/public/invitations/"+token+"/receipt", "", body, nil); w.Code != 403 {
		t.Fatal("old credentials read after reset", w.Code)
	}
}

func TestPublicReceiptStrictBodyOriginAndUnknownReferences(t *testing.T) {
	a, s, token, _, body := publicPlexReceiptFixture(t)
	path := "/api/public/invitations/" + token + "/receipt"
	for _, mode := range []string{"unknown-field", "invalid-job", "missing-password"} {
		t.Run(mode, func(t *testing.T) {
			bad := map[string]any{}
			for k, v := range body {
				bad[k] = v
			}
			switch mode {
			case "unknown-field":
				bad["plex_authorization_id"] = newUUID()
			case "invalid-job":
				bad["job_id"] = "not/a/job"
			case "missing-password":
				delete(bad, "password")
			}
			if w := apiRequest(a, "POST", path, "", bad, nil); w.Code != 400 {
				t.Fatal(w.Code, w.Body.String())
			}
		})
	}
	r := httptest.NewRequest("POST", path, strings.NewReader("{}"))
	r.Header.Set("Origin", "https://foreign.invalid")
	r.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	a.ServeHTTP(w, r)
	if w.Code != 403 {
		t.Fatal("cross-origin receipt", w.Code)
	}
	if w := apiRequest(a, "POST", "/api/public/invitations/"+randomToken()+"/receipt", "", body, nil); w.Code != 403 {
		t.Fatal("foreign invitation read receipt", w.Code)
	}
	var jobs int
	if err := s.reader.QueryRow("SELECT count(*) FROM provisioning_jobs").Scan(&jobs); err != nil || jobs != 1 {
		t.Fatal("missing receipt reserved work", err)
	}
}
