package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"testing/fstest"
	"time"
)

// Deliberately seeds future Plex grants only in a disposable test database.
// Production invitation creation/redemption remains capability-gated.
func seedPlexProofInvitation(t *testing.T, a *App, admin string) (string, int64, int64) {
	t.Helper()
	var server int64
	err := a.store.reader.QueryRow("SELECT id FROM media_servers WHERE service_type='plex' ORDER BY id LIMIT 1").Scan(&server)
	if err == sql.ErrNoRows {
		server = createManagedServer(t, a, admin, "plex", "http://fixture.invalid")
	} else if err != nil {
		t.Fatal(err)
	}
	token := randomToken()
	var id int64
	err = a.store.write(t.Context(), func(tx *sql.Tx) error {
		result, err := tx.Exec("INSERT INTO invites(token,expires_at,max_uses,is_active,created_at,updated_at) VALUES(?,?,1,1,?,?)", tokenHash(token), utcTimestamp(time.Now().Add(time.Hour)), utcTimestamp(time.Now()), utcTimestamp(time.Now()))
		if err != nil {
			return err
		}
		id, _ = result.LastInsertId()
		_, err = tx.Exec("INSERT INTO invitation_grants(invite_id,server_id,all_libraries,library_ids,allow_downloads) VALUES(?,?,1,'[]',0)", id, server)
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	return token, id, server
}
func startInvitationProof(t *testing.T, a *App, token string) (string, *http.Cookie) {
	t.Helper()
	w := apiRequest(a, "POST", "/api/public/invitations/"+token+"/plex-authorizations", "", map[string]any{"invitation_revision": 1}, nil)
	if w.Code != 201 {
		t.Fatal(w.Code, w.Body.String())
	}
	id := responseData(t, w)["id"].(string)
	cookies := w.Result().Cookies()
	if len(cookies) != 1 || !cookies[0].HttpOnly || cookies[0].SameSite != http.SameSiteStrictMode || cookies[0].Path != "/api/public/invitations/"+token || !strings.HasPrefix(cookies[0].Name, "mum_plex_invite_") {
		t.Fatal("invalid invitation cookie")
	}
	return id, cookies[0]
}
func confirmInvitationProof(t *testing.T, a *App, token, id string, cookie *http.Cookie) {
	t.Helper()
	path := "/api/public/invitations/" + token + "/plex-authorizations/" + id
	w := apiRequest(a, "POST", path+"/poll", "", map[string]any{}, cookie)
	if w.Code != 200 || responseData(t, w)["status"] != "verified" {
		t.Fatal(w.Code, w.Body.String())
	}
	w = apiRequest(a, "POST", path+"/confirm", "", map[string]any{"invitation_revision": 1, "expected_account_id": "2"}, cookie)
	if w.Code != 200 || responseData(t, w)["status"] != "confirmed" {
		t.Fatal(w.Code, w.Body.String())
	}
	if strings.Contains(w.Body.String(), plexFixtureToken) || strings.Contains(w.Body.String(), plexFixtureCode) {
		t.Fatal("proof response leaked protocol secrets")
	}
}
func seedPlexProofReservation(ctx context.Context, tx *sql.Tx, scope plexInvitationScope, job, user string) error {
	now := utcTimestamp(time.Now())
	if _, err := tx.ExecContext(ctx, "INSERT INTO identities(uuid,kind) VALUES(?,'local')", user); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, "INSERT INTO user_accounts(uuid,kind,local_username,password_hash,is_active,used_invite_id,created_at,updated_at) VALUES(?,'local',?,'fixture-hash',0,?,?,?)", user, "recipient-"+user, scope.ID, now, now); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, "INSERT INTO provisioning_jobs(id,invite_id,user_uuid,status,reservation_held,created_at,updated_at) VALUES(?,?,?,'running',1,?,?)", job, scope.ID, user, now, now); err != nil {
		return err
	}
	for _, snapshot := range scope.Grants {
		encoded, _ := json.Marshal(snapshot.Grant)
		if _, err := tx.ExecContext(ctx, "INSERT INTO provisioning_steps(job_id,server_id,status,grant_snapshot,server_revision,provider_fingerprint) VALUES(?,?,'pending',?,?,?)", job, snapshot.Grant.ServerID, string(encoded), snapshot.ServerRevision, snapshot.Fingerprint); err != nil {
			return err
		}
	}
	return nil
}
func TestPlexInvitationProofWithoutLocalProfileAndAtomicConsumption(t *testing.T) {
	a, s := testApp(t)
	admin, _ := bootstrapOwner(t, a)
	f := newPlexAuthFixture(t, "")
	a.ProviderHTTP = f.client
	token, invite, _ := seedPlexProofInvitation(t, a, admin)
	id, cookie := startInvitationProof(t, a, token)
	restored, err := NewApp(s, a.queue, fstest.MapFS{"index.html": {Data: []byte("dashboard")}})
	if err != nil {
		t.Fatal(err)
	}
	restored.ProviderHTTP = f.client
	t.Cleanup(func() { restored.CloseProvisioning(); restored.CloseRealtime() })
	confirmInvitationProof(t, restored, token, id, cookie)
	// A Plex invitation needs the invitee's sign-in bound to this browser.
	if w := apiRequest(restored, "POST", "/api/public/invitations/"+token+"/redeem", "", redeemBody("NoSharingYet", newUUID()), nil); w.Code != 400 || !strings.Contains(w.Body.String(), "PLEX_AUTH_REQUIRED") {
		t.Fatal("redemption without the Plex sign-in accepted", w.Code, w.Body.String())
	}
	var profiles, connections, jobs int
	s.reader.QueryRow("SELECT count(*) FROM user_accounts").Scan(&profiles)
	s.reader.QueryRow("SELECT count(*) FROM plex_connections").Scan(&connections)
	s.reader.QueryRow("SELECT count(*) FROM provisioning_jobs").Scan(&jobs)
	if profiles != 1 || connections != 0 || jobs != 0 {
		t.Fatal("authentication alone created access or reservation")
	}
	job, user := newUUID(), newUUID()
	prepared, err := restored.preparePlexInvitationProof(t.Context(), token, id, cookie.Value, job, user)
	if err != nil {
		t.Fatal(err)
	}
	rollback := errors.New("reservation failed after consuming proof")
	reserve := func(tx *sql.Tx) error {
		scope, err := loadPlexInvitationScope(t.Context(), tx, tokenHash(token), 1, "")
		if err != nil {
			return err
		}
		if err := seedPlexProofReservation(t.Context(), tx, scope, job, user); err != nil {
			return err
		}
		return consumePlexInvitationProof(t.Context(), tx, prepared)
	}
	if err := s.write(t.Context(), func(tx *sql.Tx) error {
		if err := reserve(tx); err != nil {
			return err
		}
		return rollback
	}); !errors.Is(err, rollback) {
		t.Fatal(err)
	}
	var status string
	s.reader.QueryRow("SELECT status FROM plex_invitation_authorizations WHERE id=?", id).Scan(&status)
	s.reader.QueryRow("SELECT count(*) FROM provisioning_jobs").Scan(&jobs)
	if status != "confirmed" || jobs != 0 {
		t.Fatal("rollback burned proof or kept capacity")
	}
	if err := s.write(t.Context(), reserve); err != nil {
		t.Fatal(err)
	}
	if err := s.write(t.Context(), func(tx *sql.Tx) error { return consumePlexInvitationProof(t.Context(), tx, prepared) }); err == nil {
		t.Fatal("proof reused")
	}
	var cipher []byte
	s.reader.QueryRow("SELECT secret FROM plex_invitation_credentials WHERE job_id=?", job).Scan(&cipher)
	secret, err := s.openPlexCredential(t.Context(), plexInvitationJobPurpose(job, user, "2", prepared.row), cipher)
	if err != nil || secret.Token != plexFixtureToken || secret.AccountID != "2" {
		t.Fatal("job credential not encrypted/bound", err)
	}
	var uses int
	s.reader.QueryRow("SELECT current_uses FROM invites WHERE id=?", invite).Scan(&uses)
	if uses != 0 {
		t.Fatal("proof marked invitation completed")
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.creates != 1 || f.polls != 1 {
		t.Fatal("restart or proof consumption replayed cloud operation")
	}
}
func TestPlexInvitationProofBindingsAndConsent(t *testing.T) {
	a, _ := testApp(t)
	admin, _ := bootstrapOwner(t, a)
	f := newPlexAuthFixture(t, "")
	a.ProviderHTTP = f.client
	token, _, _ := seedPlexProofInvitation(t, a, admin)
	other, _, _ := seedPlexProofInvitation(t, a, admin)
	id, cookie := startInvitationProof(t, a, token)
	path := "/api/public/invitations/" + token + "/plex-authorizations/" + id
	for _, tc := range []struct {
		token  string
		cookie *http.Cookie
	}{{token, nil}, {other, cookie}, {token, &http.Cookie{Name: cookie.Name, Value: randomToken()}}, {token, &http.Cookie{Name: plexCookieName(id), Value: cookie.Value}}} {
		w := apiRequest(a, "POST", "/api/public/invitations/"+tc.token+"/plex-authorizations/"+id+"/poll", "", map[string]any{}, tc.cookie)
		if w.Code != 403 {
			t.Fatal("wrong browser/invitation/scope accepted", w.Code)
		}
	}
	if w := apiRequest(a, "POST", "/api/plex/authorizations/"+id+"/poll", admin, map[string]any{}, cookie); w.Code != 403 {
		t.Fatal("public proof accepted as personal")
	}
	w := apiRequest(a, "POST", path+"/poll", "", map[string]any{}, cookie)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	for _, body := range []map[string]any{{"invitation_revision": 2, "expected_account_id": "2"}, {"invitation_revision": 1, "expected_account_id": "3"}} {
		if w := apiRequest(a, "POST", path+"/confirm", "", body, cookie); w.Code == 200 {
			t.Fatal("unbound account/revision consent")
		}
	}
	if _, err := a.preparePlexInvitationProof(t.Context(), token, id, cookie.Value, newUUID(), newUUID()); err == nil {
		t.Fatal("unconfirmed proof consumed")
	}
}
func TestPlexInvitationChangesDuringCloudReadPreventProof(t *testing.T) {
	for _, change := range []string{"revoke", "archive", "revision", "grant", "server-revision", "server-credentials", "provider-disabled", "capacity"} {
		t.Run(change, func(t *testing.T) {
			a, s := testApp(t)
			admin, _ := bootstrapOwner(t, a)
			f := newPlexAuthFixture(t, "")
			a.ProviderHTTP = f.client
			token, invite, server := seedPlexProofInvitation(t, a, admin)
			id, cookie := startInvitationProof(t, a, token)
			f.mu.Lock()
			f.beforeAccount = func() {
				var err error
				switch change {
				case "revoke":
					_, err = s.writer.Exec("UPDATE invites SET is_active=0 WHERE id=?", invite)
				case "archive":
					_, err = s.writer.Exec("UPDATE invites SET archived_at=? WHERE id=?", utcTimestamp(time.Now()), invite)
				case "revision":
					_, err = s.writer.Exec("UPDATE invites SET revision=revision+1 WHERE id=?", invite)
				case "grant":
					_, err = s.writer.Exec("UPDATE invitation_grants SET allow_downloads=1 WHERE invite_id=?", invite)
				case "server-revision":
					_, err = s.writer.Exec("UPDATE media_servers SET revision=revision+1 WHERE id=?", server)
				case "server-credentials":
					_, err = s.writer.Exec("UPDATE media_servers SET api_key='changed' WHERE id=?", server)
				case "provider-disabled":
					_, err = s.writer.Exec("UPDATE provider_settings SET enabled=0 WHERE provider_id='plex'")
				case "capacity":
					_, err = s.writer.Exec("UPDATE invites SET current_uses=1 WHERE id=?", invite)
				}
				if err != nil {
					t.Error(err)
				}
			}
			f.mu.Unlock()
			w := apiRequest(a, "POST", "/api/public/invitations/"+token+"/plex-authorizations/"+id+"/poll", "", map[string]any{}, cookie)
			if w.Code == 200 {
				t.Fatal("stale scope became proof")
			}
			var state string
			s.reader.QueryRow("SELECT status FROM plex_invitation_authorizations WHERE id=?", id).Scan(&state)
			if state != "pending" {
				t.Fatal(state)
			}
		})
	}
}
func TestPlexInvitationConsumptionRevalidatesCapacityGrantAndJob(t *testing.T) {
	for _, change := range []string{"capacity", "grant", "wrong-job", "wrong-steps", "expired-proof"} {
		t.Run(change, func(t *testing.T) {
			a, s := testApp(t)
			admin, _ := bootstrapOwner(t, a)
			f := newPlexAuthFixture(t, "")
			a.ProviderHTTP = f.client
			token, invite, _ := seedPlexProofInvitation(t, a, admin)
			id, cookie := startInvitationProof(t, a, token)
			confirmInvitationProof(t, a, token, id, cookie)
			job, user := newUUID(), newUUID()
			prepared, err := a.preparePlexInvitationProof(t.Context(), token, id, cookie.Value, job, user)
			if err != nil {
				t.Fatal(err)
			}
			err = s.write(t.Context(), func(tx *sql.Tx) error {
				scope, err := loadPlexInvitationScope(t.Context(), tx, tokenHash(token), 1, "")
				if err != nil {
					return err
				}
				if err := seedPlexProofReservation(t.Context(), tx, scope, job, user); err != nil {
					return err
				}
				switch change {
				case "capacity":
					_, err = tx.Exec("UPDATE invites SET current_uses=1 WHERE id=?", invite)
				case "grant":
					_, err = tx.Exec("UPDATE invitation_grants SET allow_downloads=1 WHERE invite_id=?", invite)
				case "wrong-job":
					_, err = tx.Exec("UPDATE provisioning_jobs SET reservation_held=0 WHERE id=?", job)
				case "wrong-steps":
					_, err = tx.Exec("UPDATE provisioning_steps SET grant_snapshot='{}' WHERE job_id=?", job)
				case "expired-proof":
					_, err = tx.Exec("UPDATE plex_invitation_authorizations SET expires_at=? WHERE id=?", utcTimestamp(time.Now().Add(-time.Minute)), id)
				}
				if err != nil {
					return err
				}
				return consumePlexInvitationProof(t.Context(), tx, prepared)
			})
			if err == nil {
				t.Fatal("invalid reservation consumed proof")
			}
			var jobs int
			s.reader.QueryRow("SELECT count(*) FROM provisioning_jobs").Scan(&jobs)
			if jobs != 0 {
				t.Fatal("failed consumption retained reservation")
			}
		})
	}
}
func TestPlexInvitationPendingExpiryAndRateLimits(t *testing.T) {
	a, s := testApp(t)
	admin, _ := bootstrapOwner(t, a)
	f := newPlexAuthFixture(t, "pending")
	a.ProviderHTTP = f.client
	token, _, _ := seedPlexProofInvitation(t, a, admin)
	id, cookie := startInvitationProof(t, a, token)
	path := "/api/public/invitations/" + token + "/plex-authorizations/" + id
	if w := apiRequest(a, "POST", path+"/poll", "", map[string]any{}, cookie); w.Code != 200 || responseData(t, w)["status"] != "pending" {
		t.Fatal(w.Code, w.Body.String())
	}
	if w := apiRequest(a, "POST", path+"/poll", "", map[string]any{}, cookie); w.Code != 429 {
		t.Fatal("unbounded polling", w.Code)
	}
	if _, err := s.writer.Exec("UPDATE plex_invitation_authorizations SET expires_at=? WHERE id=?", utcTimestamp(time.Now().Add(-time.Minute)), id); err != nil {
		t.Fatal(err)
	}
	if w := apiRequest(a, "POST", path+"/poll", "", map[string]any{}, cookie); w.Code != 403 {
		t.Fatal(w.Code)
	}
	for range 9 {
		startInvitationProof(t, a, token)
	}
	if w := apiRequest(a, "POST", "/api/public/invitations/"+token+"/plex-authorizations", "", map[string]any{"invitation_revision": 1}, nil); w.Code != 429 {
		t.Fatal("unbounded public starts", w.Code)
	}
}

// Plex invitation creation is covered by TestPlexAdvertisesInvitationsAndAllowsPlexInvites.
func TestPublicPlexProofRejectsUnknownInvitation(t *testing.T) {
	a, _ := testApp(t)
	if w := apiRequest(a, "POST", "/api/public/invitations/"+randomToken()+"/plex-authorizations", "", map[string]any{"invitation_revision": 1}, nil); w.Code == 201 {
		t.Fatal("unknown invitation accepted")
	}
}
func TestPublicProofKeyLossFailsAndNeverRegenerates(t *testing.T) {
	a, s := testApp(t)
	admin, _ := bootstrapOwner(t, a)
	f := newPlexAuthFixture(t, "")
	a.ProviderHTTP = f.client
	token, _, _ := seedPlexProofInvitation(t, a, admin)
	id, cookie := startInvitationProof(t, a, token)
	if err := os.Remove(filepath.Join(s.dataDir, "plex.key")); err != nil {
		t.Fatal(err)
	}
	if w := apiRequest(a, "POST", "/api/public/invitations/"+token+"/plex-authorizations/"+id+"/poll", "", map[string]any{}, cookie); w.Code != 502 {
		t.Fatal(w.Code, w.Body.String())
	}
	if _, err := os.Stat(filepath.Join(s.dataDir, "plex.key")); !os.IsNotExist(err) {
		t.Fatal("key was regenerated")
	}
}
func TestConcurrentInvitationConfirmationIsConsentOnly(t *testing.T) {
	a, s := testApp(t)
	admin, _ := bootstrapOwner(t, a)
	f := newPlexAuthFixture(t, "")
	a.ProviderHTTP = f.client
	token, _, _ := seedPlexProofInvitation(t, a, admin)
	id, cookie := startInvitationProof(t, a, token)
	path := "/api/public/invitations/" + token + "/plex-authorizations/" + id
	if w := apiRequest(a, "POST", path+"/poll", "", map[string]any{}, cookie); w.Code != 200 {
		t.Fatal(w.Code)
	}
	var wg sync.WaitGroup
	results := make(chan int, 2)
	for range 2 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			results <- apiRequest(a, "POST", path+"/confirm", "", map[string]any{"invitation_revision": 1, "expected_account_id": "2"}, cookie).Code
		}()
	}
	wg.Wait()
	close(results)
	for code := range results {
		if code != 200 && code != 409 {
			t.Fatal(code)
		}
	}
	var jobs int
	s.reader.QueryRow("SELECT count(*) FROM provisioning_jobs").Scan(&jobs)
	if jobs != 0 {
		t.Fatal("consent reserved capacity")
	}
}

func TestPlexPublicProofRejectsInvitesWithoutPlexBeforeCloud(t *testing.T) {
	a, s := testApp(t)
	admin, _ := bootstrapOwner(t, a)
	server := createManagedServer(t, a, admin, "jellyfin", "http://fixture.invalid")
	w := apiRequest(a, "POST", "/api/invitations", admin, map[string]any{"expires_at": time.Now().Add(time.Hour).UTC().Format(time.RFC3339), "max_uses": 1, "grants": []InvitationGrant{{ServerID: server, AllLibraries: true}}}, nil)
	if w.Code != 201 {
		t.Fatal(w.Code, w.Body.String())
	}
	token := responseData(t, w)["token"].(string)
	f := newPlexAuthFixture(t, "")
	a.ProviderHTTP = f.client
	w = apiRequest(a, "POST", "/api/public/invitations/"+token+"/plex-authorizations", "", map[string]any{"invitation_revision": 1}, nil)
	if w.Code != 409 {
		t.Fatal(w.Code, w.Body.String())
	}
	var count int
	s.reader.QueryRow("SELECT count(*) FROM plex_invitation_authorizations").Scan(&count)
	f.mu.Lock()
	defer f.mu.Unlock()
	if count != 0 || f.creates != 0 {
		t.Fatal("unrelated invite generated Plex authorization")
	}
}
func TestPlexPublicScopeIncludesOtherProvidersAndSelectedLibraries(t *testing.T) {
	for _, change := range []string{"other-provider", "selected-library"} {
		t.Run(change, func(t *testing.T) {
			a, s := testApp(t)
			admin, _ := bootstrapOwner(t, a)
			f := newPlexAuthFixture(t, "")
			a.ProviderHTTP = f.client
			token, invite, server := seedPlexProofInvitation(t, a, admin)
			other := createManagedServer(t, a, admin, "jellyfin", "http://fixture.invalid")
			if _, err := s.writer.Exec("INSERT INTO invitation_grants(invite_id,server_id,all_libraries,library_ids,allow_downloads) VALUES(?,?,1,'[]',0)", invite, other); err != nil {
				t.Fatal(err)
			}
			if _, err := s.writer.Exec("INSERT INTO media_libraries(server_id,external_id,name) VALUES(?,'7','Library')", server); err != nil {
				t.Fatal(err)
			}
			if _, err := s.writer.Exec("UPDATE invitation_grants SET all_libraries=0,library_ids='[\"7\"]' WHERE invite_id=? AND server_id=?", invite, server); err != nil {
				t.Fatal(err)
			}
			id, cookie := startInvitationProof(t, a, token)
			f.mu.Lock()
			f.beforeAccount = func() {
				var err error
				if change == "other-provider" {
					_, err = s.writer.Exec("UPDATE media_servers SET revision=revision+1 WHERE id=?", other)
				} else {
					_, err = s.writer.Exec("UPDATE media_libraries SET is_available=0 WHERE server_id=?", server)
				}
				if err != nil {
					t.Error(err)
				}
			}
			f.mu.Unlock()
			w := apiRequest(a, "POST", "/api/public/invitations/"+token+"/plex-authorizations/"+id+"/poll", "", map[string]any{}, cookie)
			if w.Code == 200 {
				t.Fatal("stale mixed/library scope accepted")
			}
		})
	}
}

func TestPublicProofRowsBlockKeyBootstrapWithoutFingerprint(t *testing.T) {
	a, s := testApp(t)
	admin, _ := bootstrapOwner(t, a)
	f := newPlexAuthFixture(t, "")
	a.ProviderHTTP = f.client
	token, _, _ := seedPlexProofInvitation(t, a, admin)
	startInvitationProof(t, a, token)
	if _, err := s.writer.Exec("DELETE FROM plex_key_metadata"); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(filepath.Join(s.dataDir, "plex.key")); err != nil {
		t.Fatal(err)
	}
	w := apiRequest(a, "POST", "/api/public/invitations/"+token+"/plex-authorizations", "", map[string]any{"invitation_revision": 1}, nil)
	if w.Code != 502 {
		t.Fatal("existing public secrets permitted key replacement", w.Code, w.Body.String())
	}
	if _, err := os.Stat(filepath.Join(s.dataDir, "plex.key")); !os.IsNotExist(err) {
		t.Fatal("key recreated")
	}
}
func TestConcurrentPublicProofReservationsCommitOnlyOne(t *testing.T) {
	a, s := testApp(t)
	admin, _ := bootstrapOwner(t, a)
	f := newPlexAuthFixture(t, "")
	a.ProviderHTTP = f.client
	token, invite, _ := seedPlexProofInvitation(t, a, admin)
	if _, err := s.writer.Exec("UPDATE invites SET max_uses=2 WHERE id=?", invite); err != nil {
		t.Fatal(err)
	}
	id, cookie := startInvitationProof(t, a, token)
	confirmInvitationProof(t, a, token, id, cookie)
	prepared := []preparedPlexInvitationProof{}
	for range 2 {
		proof, err := a.preparePlexInvitationProof(t.Context(), token, id, cookie.Value, newUUID(), newUUID())
		if err != nil {
			t.Fatal(err)
		}
		prepared = append(prepared, proof)
	}
	var wg sync.WaitGroup
	results := make(chan error, 2)
	for _, proof := range prepared {
		wg.Add(1)
		go func(p preparedPlexInvitationProof) {
			defer wg.Done()
			results <- s.write(t.Context(), func(tx *sql.Tx) error {
				scope, err := loadPlexInvitationScope(t.Context(), tx, tokenHash(token), 1, "")
				if err != nil {
					return err
				}
				if err := seedPlexProofReservation(t.Context(), tx, scope, p.job, p.user); err != nil {
					return err
				}
				return consumePlexInvitationProof(t.Context(), tx, p)
			})
		}(proof)
	}
	wg.Wait()
	close(results)
	success := 0
	for err := range results {
		if err == nil {
			success++
		}
	}
	if success != 1 {
		t.Fatal("proof reserved more than once", success)
	}
	var jobs, profiles int
	s.reader.QueryRow("SELECT count(*) FROM provisioning_jobs").Scan(&jobs)
	s.reader.QueryRow("SELECT count(*) FROM user_accounts").Scan(&profiles)
	if jobs != 1 || profiles != 2 {
		t.Fatal("losing transaction retained a profile/reservation")
	}
}
