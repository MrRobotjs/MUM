package main

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func invitationEditBody(serverID int64, revision int64) map[string]any {
	return map[string]any{"revision": revision, "expires_at": time.Now().Add(2 * time.Hour).UTC().Format(time.RFC3339Nano), "max_uses": 2, "is_active": true, "grants": []InvitationGrant{{ServerID: serverID, LibraryIDs: []string{"movies"}, AllowDownloads: true}}}
}

func TestInvitationShareLinkEncryptionAuthorizationAndMissingKey(t *testing.T) {
	a, s := testApp(t)
	admin, _ := bootstrapOwner(t, a)
	f := newProvisioningFixture(t, "")
	id, token, _ := prepareInvitation(t, a, admin, f)
	path := fmt.Sprintf("/api/invitations/%d/share-link", id)
	if w := apiRequest(a, "GET", path, admin, nil, nil); w.Code != 200 || responseData(t, w)["token"] != token {
		t.Fatal(w.Code, w.Body.String())
	}
	if w := apiRequest(a, "GET", path, "", nil, nil); w.Code != 401 {
		t.Fatal(w.Code)
	}
	var ciphertext []byte
	if err := s.reader.QueryRow("SELECT ciphertext FROM invitation_secrets WHERE invite_id=?", id).Scan(&ciphertext); err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(ciphertext, []byte(token)) || len(ciphertext) <= len(token) {
		t.Fatal("share token persisted without authenticated encryption")
	}
	if opened, err := s.openInvitationToken(t.Context(), tokenHash(token), ciphertext); err != nil || opened != token {
		t.Fatal("share token did not decrypt", err)
	}
	if _, err := s.openInvitationToken(t.Context(), tokenHash("different-invitation"), ciphertext); err == nil {
		t.Fatal("ciphertext was not bound to its token digest")
	}
	corrupted := append([]byte(nil), ciphertext...)
	corrupted[len(corrupted)-1] ^= 1
	if _, err := s.openInvitationToken(t.Context(), tokenHash(token), corrupted); err == nil {
		t.Fatal("accepted tampered token")
	}
	if _, err := s.writer.Exec("UPDATE invitation_secrets SET ciphertext=? WHERE invite_id=?", corrupted, id); err != nil {
		t.Fatal(err)
	}
	if w := apiRequest(a, "GET", path, admin, nil, nil); w.Code != 409 {
		t.Fatal("share endpoint accepted tampered ciphertext", w.Code)
	}
	if _, err := s.writer.Exec("UPDATE invitation_secrets SET ciphertext=? WHERE invite_id=?", ciphertext, id); err != nil {
		t.Fatal(err)
	}
	keyPath := filepath.Join(s.dataDir, "invitation.key")
	key, err := os.ReadFile(keyPath)
	if err != nil || len(key) != 32 {
		t.Fatal("missing key", err)
	}
	backup := keyPath + ".test-backup"
	if err := os.Rename(keyPath, backup); err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := os.Rename(backup, keyPath); err != nil {
			t.Error(err)
		}
	}()
	if w := apiRequest(a, "GET", path, admin, nil, nil); w.Code != 409 {
		t.Fatal("missing key silently recovered", w.Code, w.Body.String())
	}
	body := invitationEditBody(1, 1)
	delete(body, "revision")
	if w := apiRequest(a, "POST", "/api/invitations", admin, body, nil); w.Code != 503 {
		t.Fatal(w.Code, w.Body.String())
	}
	if _, err := os.Stat(keyPath); !os.IsNotExist(err) {
		t.Fatal("missing key was replaced while encrypted records existed", err)
	}
	// List/detail remain available without decrypting bearer secrets.
	if w := apiRequest(a, "GET", fmt.Sprintf("/api/invitations/%d", id), admin, nil, nil); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
}

func TestInvitationRevisionEditsAndAtomicBulkActions(t *testing.T) {
	a, s := testApp(t)
	admin, _ := bootstrapOwner(t, a)
	f := newProvisioningFixture(t, "")
	id, token, servers := prepareInvitation(t, a, admin, f)
	path := fmt.Sprintf("/api/invitations/%d", id)
	body := invitationEditBody(servers[0], 1)
	if w := apiRequest(a, "PATCH", path, admin, body, nil); w.Code != 200 || responseData(t, w)["revision"] != float64(2) {
		t.Fatal(w.Code, w.Body.String())
	}
	if w := apiRequest(a, "PATCH", path, admin, body, nil); w.Code != 409 {
		t.Fatal("stale invitation edit accepted", w.Code, w.Body.String())
	}
	if w := apiRequest(a, "GET", path, admin, nil, nil); w.Code != 200 || responseData(t, w)["max_uses"] != float64(2) {
		t.Fatal(w.Code, w.Body.String())
	}
	if w := apiRequest(a, "POST", "/api/invitations/bulk-action", admin, map[string]any{"ids": []int64{id, 999999}, "action": "disable"}, nil); w.Code != 404 {
		t.Fatal(w.Code, w.Body.String())
	}
	var active bool
	var revision int64
	if err := s.reader.QueryRow("SELECT is_active,revision FROM invites WHERE id=?", id).Scan(&active, &revision); err != nil || !active || revision != 2 {
		t.Fatal("failed bulk action partially committed", active, revision, err)
	}
	for _, action := range []string{"disable", "enable", "archive"} {
		w := apiRequest(a, "POST", "/api/invitations/bulk-action", admin, map[string]any{"ids": []int64{id}, "action": action}, nil)
		if w.Code != 200 {
			t.Fatal(w.Code, w.Body.String())
		}
	}
	if w := apiRequest(a, "GET", path, admin, nil, nil); w.Code != 404 {
		t.Fatal("archived record remained in detail endpoint", w.Code, w.Body.String())
	}
	// The Invites page's "Archived" filter asks for archived records explicitly.
	if w := apiRequest(a, "GET", path+"?include_archived=1", admin, nil, nil); w.Code != 200 || responseData(t, w)["archived_at"] == nil {
		t.Fatal("archived detail unavailable on request", w.Code, w.Body.String())
	}
	if w := apiRequest(a, "GET", "/api/invitations?include_archived=1", admin, nil, nil); w.Code != 200 || !bytes.Contains(w.Body.Bytes(), []byte(`"archived_at":"`)) {
		t.Fatal("archived invitation not listed on request", w.Code, w.Body.String())
	}
	if w := apiRequest(a, "GET", "/api/public/invitations/"+token, "", nil, nil); w.Code != 410 {
		t.Fatal(w.Code, w.Body.String())
	}
	if w := apiRequest(a, "GET", "/api/invitations", admin, nil, nil); w.Code != 200 || !bytes.Contains(w.Body.Bytes(), []byte(`"data":[]`)) {
		t.Fatal(w.Code, w.Body.String())
	}
}

func TestUnresolvedProvisioningBlocksEditsAndReenableButRetainsArchivedHistory(t *testing.T) {
	a, _ := testApp(t)
	admin, _ := bootstrapOwner(t, a)
	f := newProvisioningFixture(t, "password")
	id, token, servers := prepareInvitation(t, a, admin, f)
	w := apiRequest(a, "POST", "/api/public/invitations/"+token+"/redeem", "", redeemBody("Review Recipient", newUUID()), nil)
	if w.Code != 201 || responseData(t, w)["status"] != "failed" {
		t.Fatal(w.Code, w.Body.String())
	}
	if w := apiRequest(a, "PATCH", fmt.Sprintf("/api/invitations/%d", id), admin, invitationEditBody(servers[0], 1), nil); w.Code != 409 {
		t.Fatal("edited grant with unresolved reservation", w.Code, w.Body.String())
	}
	for _, action := range []string{"disable", "enable", "archive"} {
		w := apiRequest(a, "POST", "/api/invitations/bulk-action", admin, map[string]any{"ids": []int64{id}, "action": action}, nil)
		want := 200
		if action == "enable" {
			want = 409
		}
		if w.Code != want {
			t.Fatal(action, w.Code, w.Body.String())
		}
	}
	if w := apiRequest(a, "GET", fmt.Sprintf("/api/provisioning-jobs?invite_id=%d", id), admin, nil, nil); w.Code != 200 || !bytes.Contains(w.Body.Bytes(), []byte("REVIEW_REQUIRED")) {
		t.Fatal("archive lost review record", w.Code, w.Body.String())
	}
}

func TestInvitationCursorPaginationHasNoSecretFields(t *testing.T) {
	a, s := testApp(t)
	admin, _ := bootstrapOwner(t, a)
	f := newProvisioningFixture(t, "")
	_, _, servers := prepareInvitation(t, a, admin, f)
	err := s.write(t.Context(), func(tx *sql.Tx) error {
		for range 100 {
			result, err := tx.Exec("INSERT INTO invites(token,expires_at,max_uses,created_at,updated_at) VALUES(?,?,1,?,?)", tokenHash(randomToken()), utcTimestamp(time.Now().Add(time.Hour)), utcTimestamp(time.Now()), utcTimestamp(time.Now()))
			if err != nil {
				return err
			}
			id, err := result.LastInsertId()
			if err != nil {
				return err
			}
			if _, err := tx.Exec("INSERT INTO invitation_grants VALUES(?,?,0,'[\"movies\"]',0)", id, servers[0]); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	w := apiRequest(a, "GET", "/api/invitations", admin, nil, nil)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	var response struct {
		Data []invitationRecord `json:"data"`
		Meta struct {
			Next int64 `json:"next_before"`
		} `json:"meta"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	if len(response.Data) != 100 || response.Meta.Next == 0 {
		t.Fatal(len(response.Data), response.Meta)
	}
	w = apiRequest(a, "GET", fmt.Sprintf("/api/invitations?before=%d", response.Meta.Next), admin, nil, nil)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	if err := json.Unmarshal(w.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	if len(response.Data) != 1 {
		t.Fatal(len(response.Data))
	}
}

func TestPublicInvitationRevisionBindsPreparedCredentials(t *testing.T) {
	a, s := testApp(t)
	admin, _ := bootstrapOwner(t, a)
	f := newProvisioningFixture(t, "")
	id, token, servers := prepareInvitation(t, a, admin, f)
	publicPath := "/api/public/invitations/" + token
	if w := apiRequest(a, "GET", publicPath, "", nil, nil); w.Code != 200 || responseData(t, w)["revision"] != float64(1) {
		t.Fatal(w.Code, w.Body.String())
	}
	if w := apiRequest(a, "PATCH", fmt.Sprintf("/api/invitations/%d", id), admin, invitationEditBody(servers[0], 1), nil); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	body := redeemBody("Stale Draft", newUUID())
	body["invitation_revision"] = 1
	if w := apiRequest(a, "POST", publicPath+"/redeem", "", body, nil); w.Code != 409 {
		t.Fatal("stale draft provisioned edited grants", w.Code, w.Body.String())
	}
	var jobs int
	if err := s.reader.QueryRow("SELECT count(*) FROM provisioning_jobs").Scan(&jobs); err != nil || jobs != 0 || f.creates.Load() != 0 {
		t.Fatal(jobs, err)
	}
}

func TestInvitationUsernameConflictHasDefiniteNoReservationCode(t *testing.T) {
	a, s := testApp(t)
	admin, _ := bootstrapOwner(t, a)
	f := newProvisioningFixture(t, "")
	_, token, _ := prepareInvitation(t, a, admin, f)
	var owner string
	if err := s.reader.QueryRow("SELECT local_username FROM user_accounts WHERE kind='owner'").Scan(&owner); err != nil {
		t.Fatal(err)
	}
	w := apiRequest(a, "POST", "/api/public/invitations/"+token+"/redeem", "", redeemBody(owner, newUUID()), nil)
	if w.Code != 409 || !bytes.Contains(w.Body.Bytes(), []byte("USERNAME_UNAVAILABLE")) {
		t.Fatal(w.Code, w.Body.String())
	}
	var jobs int
	if err := s.reader.QueryRow("SELECT count(*) FROM provisioning_jobs").Scan(&jobs); err != nil || jobs != 0 || f.creates.Load() != 0 {
		t.Fatal(jobs, err)
	}
}
