package main

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"testing/fstest"
	"time"
)

func startPlexForTest(t *testing.T, a *App, token string) (string, *http.Cookie) {
	t.Helper()
	w := apiRequest(a, "POST", "/api/plex/authorizations", token, map[string]any{}, nil)
	if w.Code != 201 {
		t.Fatal(w.Code, w.Body.String())
	}
	id := responseData(t, w)["id"].(string)
	cookies := w.Result().Cookies()
	if len(cookies) != 1 || !cookies[0].HttpOnly || cookies[0].SameSite != http.SameSiteStrictMode || cookies[0].Path != "/api/plex/authorizations/"+id || !strings.HasPrefix(responseData(t, w)["authorization_url"].(string), "https://app.plex.tv/auth#?") {
		t.Fatal("unsafe browser-bound authorization")
	}
	return id, cookies[0]
}
func verifyPlexForTest(t *testing.T, a *App, token, id string, cookie *http.Cookie) {
	t.Helper()
	w := apiRequest(a, "POST", "/api/plex/authorizations/"+id+"/poll", token, map[string]any{}, cookie)
	if w.Code != 200 || responseData(t, w)["status"] != "verified" {
		t.Fatal(w.Code, w.Body.String())
	}
	if strings.Contains(w.Body.String(), plexFixtureToken) || strings.Contains(w.Body.String(), plexFixtureCode) {
		t.Fatal("protocol secrets leaked")
	}
}
func TestPlexAuthorizationPersistsAndConfirmsOnce(t *testing.T) {
	a, s := testApp(t)
	token, _ := bootstrapOwner(t, a)
	f := newPlexAuthFixture(t, "")
	a.ProviderHTTP = f.client
	if w := apiRequest(a, "POST", "/api/providers/plex/enable", token, map[string]any{}, nil); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	id, cookie := startPlexForTest(t, a, token)
	var encoded []byte
	var owner, browser string
	if err := s.reader.QueryRow("SELECT owner_uuid,browser_hash,secret FROM plex_authorizations WHERE id=?", id).Scan(&owner, &browser, &encoded); err != nil {
		t.Fatal(err)
	}
	plain, err := s.openPlexCredential(t.Context(), plexAuthorizationPurpose(plexAuthorization{ID: id, Owner: owner, Browser: browser}), encoded)
	if err != nil || len(plain.PrivateKey) != ed25519.PrivateKeySize || bytes.Contains(encoded, plain.PrivateKey) || bytes.Contains(encoded, []byte(plexFixtureCode)) {
		t.Fatal("device secret not protected", err)
	}
	// A fresh App reloads the persisted device identity; construction must not
	// create another remote PIN or replay the authorization operation.
	restored, err := NewApp(s, a.queue, fstest.MapFS{"index.html": {Data: []byte("dashboard")}})
	if err != nil {
		t.Fatal(err)
	}
	restored.ProviderHTTP = f.client
	t.Cleanup(func() { restored.CloseProvisioning(); restored.CloseRealtime() })
	verifyPlexForTest(t, restored, token, id, cookie)
	path := "/api/plex/authorizations/" + id + "/confirm"
	w := apiRequest(restored, "POST", path, token, map[string]any{"expected_account_id": "3"}, cookie)
	if w.Code != 409 {
		t.Fatal("wrong account confirmed", w.Code)
	}
	w = apiRequest(restored, "POST", path, token, map[string]any{"expected_account_id": "2"}, cookie)
	if w.Code != 201 {
		t.Fatal(w.Code, w.Body.String())
	}
	connection := responseData(t, w)["id"].(string)
	if strings.Contains(w.Body.String(), plexFixtureToken) || w.Result().Cookies()[0].MaxAge != -1 {
		t.Fatal("confirmation leaked token or kept cookie")
	}
	if w := apiRequest(restored, "POST", path, token, map[string]any{"expected_account_id": "2"}, cookie); w.Code != 409 {
		t.Fatal("proof consumed twice", w.Code)
	}
	var status string
	var remaining []byte
	s.reader.QueryRow("SELECT status,secret FROM plex_authorizations WHERE id=?", id).Scan(&status, &remaining)
	if status != "consumed" || remaining != nil {
		t.Fatal("consumed proof retained secret")
	}
	var ciphertext []byte
	s.reader.QueryRow("SELECT secret FROM plex_connections WHERE id=?", connection).Scan(&ciphertext)
	secret, err := s.openPlexCredential(t.Context(), plexConnectionPurpose(connection, owner, "2"), ciphertext)
	if err != nil || secret.Token != plexFixtureToken || !bytes.Equal(secret.PrivateKey, plain.PrivateKey) {
		t.Fatal("connection lost device/token", err)
	}
	w = apiRequest(restored, "GET", "/api/plex/connection", token, nil, nil)
	if w.Code != 200 || responseData(t, w)["account_id"] != "2" || strings.Contains(w.Body.String(), plexFixtureToken) {
		t.Fatal(w.Code, w.Body.String())
	}
	var profiles, links, jobs int
	s.reader.QueryRow("SELECT count(*) FROM user_accounts").Scan(&profiles)
	s.reader.QueryRow("SELECT count(*) FROM service_links").Scan(&links)
	s.reader.QueryRow("SELECT count(*) FROM provisioning_jobs").Scan(&jobs)
	if profiles != 1 || links != 0 || jobs != 0 {
		t.Fatal("authorization granted application/server access")
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.creates != 1 || f.polls != 1 {
		t.Fatal("restart or confirmation replayed cloud operations")
	}
}
func TestPlexPendingAndPollAdmission(t *testing.T) {
	a, s := testApp(t)
	token, _ := bootstrapOwner(t, a)
	f := newPlexAuthFixture(t, "pending")
	a.ProviderHTTP = f.client
	if w := apiRequest(a, "POST", "/api/providers/plex/enable", token, map[string]any{}, nil); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	id, cookie := startPlexForTest(t, a, token)
	path := "/api/plex/authorizations/" + id
	w := apiRequest(a, "POST", path+"/poll", token, map[string]any{}, cookie)
	if w.Code != 200 || responseData(t, w)["status"] != "pending" {
		t.Fatal(w.Code, w.Body.String())
	}
	if w := apiRequest(a, "POST", path+"/confirm", token, map[string]any{"expected_account_id": "2"}, cookie); w.Code != 409 {
		t.Fatal("pending proof confirmed")
	}
	if w := apiRequest(a, "POST", path+"/poll", token, map[string]any{}, cookie); w.Code != 429 {
		t.Fatal("unbounded polling", w.Code)
	}
	if _, err := s.writer.Exec("UPDATE plex_authorizations SET expires_at=? WHERE id=?", utcTimestamp(time.Now().Add(-time.Minute)), id); err != nil {
		t.Fatal(err)
	}
	if w := apiRequest(a, "POST", path+"/poll", token, map[string]any{}, cookie); w.Code != 403 {
		t.Fatal("expired proof polled", w.Code)
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.accounts != 0 || f.polls != 1 {
		t.Fatal("pending or expired proof granted identity")
	}
}
func TestPlexBrowserAndOwnerBindings(t *testing.T) {
	a, s := testApp(t)
	token, _ := bootstrapOwner(t, a)
	f := newPlexAuthFixture(t, "")
	a.ProviderHTTP = f.client
	if w := apiRequest(a, "POST", "/api/providers/plex/enable", token, map[string]any{}, nil); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	id, cookie := startPlexForTest(t, a, token)
	owner, _ := s.Authenticate(t.Context(), token)
	uuid, err := s.CreateAccount(t.Context(), owner.UUID, "other", "encoded-test-hash", false)
	if err != nil {
		t.Fatal(err)
	}
	session, err := s.issueSession(t.Context(), uuid, false)
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		token  string
		cookie *http.Cookie
	}{{token, nil}, {token, &http.Cookie{Name: cookie.Name, Value: randomToken()}}, {session.Access, cookie}} {
		w := apiRequest(a, "POST", "/api/plex/authorizations/"+id+"/poll", tc.token, map[string]any{}, tc.cookie)
		if w.Code != 403 {
			t.Fatal("cross-browser/owner accepted", w.Code, w.Body.String())
		}
	}
	if w := apiRequest(a, "POST", "/api/plex/authorizations", "", map[string]any{}, nil); w.Code != 401 {
		t.Fatal(w.Code)
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.polls != 0 {
		t.Fatal("invalid binding contacted Plex")
	}
}
func TestPlexAuthorizationRechecksAuthorityAfterHTTP(t *testing.T) {
	for _, change := range []string{"logout", "inactive", "provider-disabled", "revision"} {
		t.Run(change, func(t *testing.T) {
			a, s := testApp(t)
			token, _ := bootstrapOwner(t, a)
			f := newPlexAuthFixture(t, "")
			a.ProviderHTTP = f.client
			if w := apiRequest(a, "POST", "/api/providers/plex/enable", token, map[string]any{}, nil); w.Code != 200 {
				t.Fatal(w.Code, w.Body.String())
			}
			admin, _ := s.Authenticate(t.Context(), token)
			uuid, err := s.CreateAccount(t.Context(), admin.UUID, "plex-person", "encoded-test-hash", false)
			if err != nil {
				t.Fatal(err)
			}
			session, err := s.issueSession(t.Context(), uuid, false)
			if err != nil {
				t.Fatal(err)
			}
			token = session.Access
			id, cookie := startPlexForTest(t, a, token)
			f.mu.Lock()
			f.beforeAccount = func() {
				var err error
				switch change {
				case "logout":
					_, err = s.writer.Exec("DELETE FROM app_sessions")
				case "inactive":
					_, err = s.writer.Exec("UPDATE user_accounts SET is_active=0 WHERE kind='local'")
				case "provider-disabled":
					_, err = s.writer.Exec("UPDATE provider_settings SET enabled=0 WHERE provider_id='plex'")
				case "revision":
					_, err = s.writer.Exec("UPDATE plex_authorizations SET revision=revision+1 WHERE id=?", id)
				}
				if err != nil {
					t.Error(err)
				}
			}
			f.mu.Unlock()
			w := apiRequest(a, "POST", "/api/plex/authorizations/"+id+"/poll", token, map[string]any{}, cookie)
			if w.Code == 200 {
				t.Fatal("stale authorization committed")
			}
			var status string
			s.reader.QueryRow("SELECT status FROM plex_authorizations WHERE id=?", id).Scan(&status)
			if status != "pending" {
				t.Fatal("stale result became proof", status)
			}
		})
	}
}
func TestPlexKeyLossTamperingAndPurposeBinding(t *testing.T) {
	for _, mode := range []string{"missing", "replaced", "truncated", "ciphertext", "purpose"} {
		t.Run(mode, func(t *testing.T) {
			a, s := testApp(t)
			token, _ := bootstrapOwner(t, a)
			f := newPlexAuthFixture(t, "")
			a.ProviderHTTP = f.client
			if w := apiRequest(a, "POST", "/api/providers/plex/enable", token, map[string]any{}, nil); w.Code != 200 {
				t.Fatal(w.Code, w.Body.String())
			}
			id, cookie := startPlexForTest(t, a, token)
			path := filepath.Join(s.dataDir, "plex.key")
			switch mode {
			case "missing":
				if err := os.Remove(path); err != nil {
					t.Fatal(err)
				}
			case "replaced":
				if err := os.WriteFile(path, bytes.Repeat([]byte{7}, 32), 0600); err != nil {
					t.Fatal(err)
				}
			case "truncated":
				if err := os.WriteFile(path, []byte("short"), 0600); err != nil {
					t.Fatal(err)
				}
			case "ciphertext":
				_, err := s.writer.Exec("UPDATE plex_authorizations SET secret=zeroblob(40) WHERE id=?", id)
				if err != nil {
					t.Fatal(err)
				}
			case "purpose":
				newBrowser := randomToken()
				cookie.Value = newBrowser
				_, err := s.writer.Exec("UPDATE plex_authorizations SET browser_hash=? WHERE id=?", tokenHash(newBrowser), id)
				if err != nil {
					t.Fatal(err)
				}
			}
			w := apiRequest(a, "POST", "/api/plex/authorizations/"+id+"/poll", token, map[string]any{}, cookie)
			if w.Code == 200 {
				t.Fatal("missing/tampered protection accepted")
			}
			if mode == "missing" {
				if _, err := os.Stat(path); !os.IsNotExist(err) {
					t.Fatal("lost key silently replaced")
				}
			}
			f.mu.Lock()
			defer f.mu.Unlock()
			if f.polls != 0 {
				t.Fatal("invalid protection emitted an assertion")
			}
		})
	}
}
func TestPlexConcurrentProofConsumptionAndLocalRevoke(t *testing.T) {
	a, s := testApp(t)
	token, _ := bootstrapOwner(t, a)
	f := newPlexAuthFixture(t, "")
	a.ProviderHTTP = f.client
	if w := apiRequest(a, "POST", "/api/providers/plex/enable", token, map[string]any{}, nil); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	id, cookie := startPlexForTest(t, a, token)
	verifyPlexForTest(t, a, token, id, cookie)
	var wg sync.WaitGroup
	codes := make(chan int, 2)
	for range 2 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			codes <- apiRequest(a, "POST", "/api/plex/authorizations/"+id+"/confirm", token, map[string]any{"expected_account_id": "2"}, cookie).Code
		}()
	}
	wg.Wait()
	close(codes)
	success := 0
	for code := range codes {
		if code == 201 {
			success++
		} else if code != 409 {
			t.Fatal(code)
		}
	}
	if success != 1 {
		t.Fatal("proof not single-use")
	}
	var connection string
	s.reader.QueryRow("SELECT id FROM plex_connections WHERE status='active'").Scan(&connection)
	next, nextCookie := startPlexForTest(t, a, token)
	verifyPlexForTest(t, a, token, next, nextCookie)
	if _, err := s.writer.Exec("UPDATE provider_settings SET enabled=0 WHERE provider_id='plex'"); err != nil {
		t.Fatal(err)
	}
	w := apiRequest(a, "POST", "/api/plex/connections/"+connection+"/revoke", token, map[string]any{}, nil)
	if w.Code != 200 || responseData(t, w)["scope"] != "local_connection" {
		t.Fatal(w.Code, w.Body.String())
	}
	var secret []byte
	var state string
	s.reader.QueryRow("SELECT status,secret FROM plex_connections WHERE id=?", connection).Scan(&state, &secret)
	if state != "revoked" || secret != nil {
		t.Fatal("local credential retained")
	}
	s.reader.QueryRow("SELECT status FROM plex_authorizations WHERE id=?", next).Scan(&state)
	if state != "failed" {
		t.Fatal("outstanding proof can resurrect disconnected credentials")
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.refreshes != 0 {
		t.Fatal("local revoke changed cloud state")
	}
}
func TestPlexStartAdmissionAndDisabledProvider(t *testing.T) {
	a, s := testApp(t)
	token, _ := bootstrapOwner(t, a)
	f := newPlexAuthFixture(t, "")
	a.ProviderHTTP = f.client
	if w := apiRequest(a, "POST", "/api/providers/plex/enable", token, map[string]any{}, nil); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	for range 3 {
		startPlexForTest(t, a, token)
	}
	if w := apiRequest(a, "POST", "/api/plex/authorizations", token, map[string]any{}, nil); w.Code != 429 {
		t.Fatal("unbounded challenge creation", w.Code)
	}
	if _, err := s.writer.Exec("UPDATE provider_settings SET enabled=0 WHERE provider_id='plex'"); err != nil {
		t.Fatal(err)
	}
	if w := apiRequest(a, "POST", "/api/plex/authorizations", token, map[string]any{}, nil); w.Code != 409 {
		t.Fatal("disabled provider used", w.Code)
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.creates != 3 {
		t.Fatal("admission failure contacted cloud")
	}
}
func TestPlexFailedStartIsNotReplayed(t *testing.T) {
	a, s := testApp(t)
	token, _ := bootstrapOwner(t, a)
	f := newPlexAuthFixture(t, "create-error")
	a.ProviderHTTP = f.client
	if w := apiRequest(a, "POST", "/api/providers/plex/enable", token, map[string]any{}, nil); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	w := apiRequest(a, "POST", "/api/plex/authorizations", token, map[string]any{}, nil)
	if w.Code != 502 || strings.Contains(w.Body.String(), "private-cloud-error") {
		t.Fatal(w.Code, w.Body.String())
	}
	var status string
	s.reader.QueryRow("SELECT status FROM plex_authorizations").Scan(&status)
	if status != "failed" {
		t.Fatal("failed create checkpoint not recorded")
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.creates != 1 {
		t.Fatal("remote creation retried")
	}
}
func TestPlexSecretFingerprintSurvivesRowPruning(t *testing.T) {
	s := testStore(t)
	if _, err := s.plexAEAD(t.Context(), true); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(filepath.Join(s.dataDir, "plex.key")); err != nil {
		t.Fatal(err)
	}
	if _, err := s.plexAEAD(context.Background(), true); err == nil {
		t.Fatal("fingerprint did not protect an empty database")
	}
}
func TestPlexSecretJSONNeverReturnsDevicePayload(t *testing.T) {
	// HTTP DTOs are deliberately separate from the encrypted storage DTO.
	data, err := json.Marshal(plexAuthorizationView(plexAuthorization{ID: "id", Status: "verified", AccountID: "2", Username: "reader", Secret: []byte(plexFixtureToken)}))
	if err != nil || strings.Contains(string(data), plexFixtureToken) || strings.Contains(string(data), "secret") {
		t.Fatal("HTTP view exposed encrypted payload")
	}
}

func TestPlexCredentialRejectsPlaintextSerialization(t *testing.T) {
	if data, err := json.Marshal(plexStoredCredential{Token: plexFixtureToken}); err == nil || bytes.Contains(data, []byte(plexFixtureToken)) {
		t.Fatal("credential permitted plaintext JSON")
	}
}

func TestPlexAccountCannotBelongToTwoLocalProfiles(t *testing.T) {
	a, s := testApp(t)
	token, _ := bootstrapOwner(t, a)
	f := newPlexAuthFixture(t, "")
	a.ProviderHTTP = f.client
	if w := apiRequest(a, "POST", "/api/providers/plex/enable", token, map[string]any{}, nil); w.Code != 200 {
		t.Fatal(w.Code)
	}
	id, cookie := startPlexForTest(t, a, token)
	verifyPlexForTest(t, a, token, id, cookie)
	if w := apiRequest(a, "POST", "/api/plex/authorizations/"+id+"/confirm", token, map[string]any{"expected_account_id": "2"}, cookie); w.Code != 201 {
		t.Fatal(w.Code, w.Body.String())
	}
	owner, _ := s.Authenticate(t.Context(), token)
	uuid, err := s.CreateAccount(t.Context(), owner.UUID, "another-person", "encoded-test-hash", false)
	if err != nil {
		t.Fatal(err)
	}
	session, err := s.issueSession(t.Context(), uuid, false)
	if err != nil {
		t.Fatal(err)
	}
	next, browser := startPlexForTest(t, a, session.Access)
	verifyPlexForTest(t, a, session.Access, next, browser)
	if w := apiRequest(a, "POST", "/api/plex/authorizations/"+next+"/confirm", session.Access, map[string]any{"expected_account_id": "2"}, browser); w.Code != 409 {
		t.Fatal("another profile took an owned Plex account", w.Code, w.Body.String())
	}
	var connections int
	s.reader.QueryRow("SELECT count(*) FROM plex_connections WHERE status='active'").Scan(&connections)
	if connections != 1 {
		t.Fatal("duplicate owner")
	}
}
