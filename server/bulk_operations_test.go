package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestBulkPreparationHonorsProviderAdmission(t *testing.T) {
	a, s := testApp(t)
	token, _ := bootstrapOwner(t, a)
	owner, _ := s.Authenticate(t.Context(), token)
	target, _ := s.CreateAccount(t.Context(), owner.UUID, "admission-fixture", "fixture-hash", false)
	a.provisionSlots <- struct{}{}
	a.provisionSlots <- struct{}{}
	defer func() { <-a.provisionSlots; <-a.provisionSlots }()
	w := apiRequest(a, "POST", "/api/users/bulk/prepare", token, map[string]any{"request_id": newUUID(), "user_uuids": []string{target}, "operation": map[string]any{"action": "extend_access", "days": 1}}, nil)
	if w.Code != 503 {
		t.Fatalf("unbounded preparation %d %s", w.Code, w.Body.String())
	}
}

func TestBulkDispatchedUncertaintySurvivesAuthorityLoss(t *testing.T) {
	a, s := testApp(t)
	token, _ := bootstrapOwner(t, a)
	owner, _ := s.Authenticate(t.Context(), token)
	server := seedServer(t, s)
	id := seedService(t, s, server)
	var b bulkStored
	err := s.write(t.Context(), func(tx *sql.Tx) error {
		target, err := bulkServiceTarget(t.Context(), tx, id)
		if err != nil {
			return err
		}
		target.Stage = "deleting"
		b = bulkStored{bulkReceipt: bulkReceipt{ID: newUUID(), Revision: "1", Action: "delete_users", State: "prepared", Results: []bulkUserResult{{UUID: id, Outcome: "unknown"}}, Warnings: []string{}, Effects: []string{}}, Actor: owner.UUID, AccessHash: tokenHash(token), Operation: bulkOperationInput{Action: "delete_users"}, Targets: []bulkTarget{target}}
		if err := tx.QueryRow("SELECT revision FROM admin_role_state WHERE singleton=1").Scan(&b.Role); err != nil {
			return err
		}
		if err := insertBulk(t.Context(), tx, &b, newUUID(), "fixture-hash"); err != nil {
			return err
		}
		b.Token = newUUID()
		if _, err := tx.Exec("UPDATE bulk_operations SET state='running',operation_token=? WHERE id=?", b.Token, b.ID); err != nil {
			return err
		}
		if _, err := tx.Exec("INSERT INTO bulk_source_locks(server_id,operation_id,operation_token) VALUES(?,?,?)", server, b.ID, b.Token); err != nil {
			return err
		}
		b.State = "running"
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	a.runBulk(b, "expired-access-fixture", true)
	tx, _ := s.reader.BeginTx(context.Background(), &sql.TxOptions{ReadOnly: true})
	defer tx.Rollback()
	saved, err := loadBulk(t.Context(), tx, b.ID)
	if err != nil {
		t.Fatal(err)
	}
	var locks int
	_ = tx.QueryRow("SELECT count(*) FROM bulk_source_locks WHERE operation_id=?", b.ID).Scan(&locks)
	if saved.Summary["unknown"] != 1 || locks != 1 {
		t.Fatalf("lost uncertain evidence %+v locks%d", saved.bulkReceipt, locks)
	}
}

func TestBulkPlexImpactMembershipChangeRequiresNewPreparation(t *testing.T) {
	_, s := testApp(t)
	server := seedServer(t, s)
	activityExec(t, s, "UPDATE media_servers SET service_type='plex' WHERE id=?", server)
	first := seedService(t, s, server)
	activityExec(t, s, "UPDATE service_accounts SET external_user_id='42' WHERE uuid=?", first)
	tx, _ := s.reader.BeginTx(t.Context(), &sql.TxOptions{ReadOnly: true})
	frozen, err := bulkPlexCatalogue(t.Context(), tx, "42")
	tx.Rollback()
	if err != nil {
		t.Fatal(err)
	}
	activityExec(t, s, "UPDATE media_servers SET server_nickname='plex-first' WHERE id=?", server)
	secondServer := seedServer(t, s)
	activityExec(t, s, "UPDATE media_servers SET service_type='plex' WHERE id=?", secondServer)
	second := seedService(t, s, secondServer)
	activityExec(t, s, "UPDATE service_accounts SET external_user_id='42' WHERE uuid=?", second)
	tx, _ = s.reader.BeginTx(t.Context(), &sql.TxOptions{ReadOnly: true})
	defer tx.Rollback()
	target := bulkTarget{RemoteID: "42", ImpactCatalogue: frozen}
	if err := checkBulkImpacts(t.Context(), tx, bulkStored{}, target); err == nil {
		t.Fatal("new impact escaped frozen preview")
	}
}

func waitBulk(t *testing.T, a *App, token, id string) bulkReceipt {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for {
		w := apiRequest(a, "GET", "/api/bulk-operations/"+id, token, nil, nil)
		var out struct{ Data bulkReceipt }
		_ = json.Unmarshal(w.Body.Bytes(), &out)
		if w.Code != 200 {
			t.Fatalf("read %d %s", w.Code, w.Body.String())
		}
		if out.Data.State != "running" {
			return out.Data
		}
		if time.Now().After(deadline) {
			t.Fatal("bulk timed out")
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestBulkRemoteDeletionUnknownReconcilesWithoutReplay(t *testing.T) {
	var mu sync.Mutex
	absent := map[string]bool{}
	disabled := map[string]bool{}
	failReads := false
	deletes := 0
	fixture := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		if r.URL.Path == "/System/Info" {
			w.Write([]byte(`{"ServerName":"fixture"}`))
			return
		}
		parts := strings.Split(strings.Trim(r.URL.Path, "/"), "/")
		if len(parts) < 2 || parts[0] != "Users" {
			t.Errorf("unexpected provider %s %s", r.Method, r.URL.Path)
			w.WriteHeader(500)
			return
		}
		id := parts[1]
		if r.Method == "DELETE" {
			deletes++
			absent[id] = true
			failReads = true
			c, _, _ := w.(http.Hijacker).Hijack()
			c.Close()
			return
		}
		if r.Method == "POST" && len(parts) == 3 && parts[2] == "Policy" {
			var p map[string]any
			_ = json.NewDecoder(r.Body).Decode(&p)
			disabled[id], _ = p["IsDisabled"].(bool)
			w.WriteHeader(204)
			return
		}
		if failReads {
			w.WriteHeader(503)
			return
		}
		if absent[id] {
			w.WriteHeader(404)
			return
		}
		json.NewEncoder(w).Encode(map[string]any{"Id": id, "Name": "Reader", "Policy": map[string]any{"IsAdministrator": false, "IsDisabled": disabled[id], "EnableAllFolders": true, "EnabledFolders": []string{}, "EnableContentDownloading": false, "AuthenticationProviderId": "auth", "PasswordResetProviderId": "reset"}})
	}))
	defer fixture.Close()
	a, s := testApp(t)
	token, _ := bootstrapOwner(t, a)
	server := seedServer(t, s)
	first := seedService(t, s, server)
	second := seedService(t, s, server)
	activityExec(t, s, "UPDATE media_servers SET url=?,api_key='fixture' WHERE id=?", fixture.URL, server)
	activityExec(t, s, "UPDATE service_accounts SET external_username='Reader' WHERE server_id=?", server)
	body := map[string]any{"request_id": newUUID(), "user_uuids": []string{first, second}, "operation": map[string]any{"action": "delete_users"}}
	w := apiRequest(a, "POST", "/api/users/bulk/prepare", token, body, nil)
	var prepared struct{ Data bulkReceipt }
	_ = json.Unmarshal(w.Body.Bytes(), &prepared)
	if w.Code != 201 || prepared.Data.Summary["pending"] != 2 {
		t.Fatalf("prepare %d %s", w.Code, w.Body.String())
	}
	w = apiRequest(a, "POST", "/api/bulk-operations/"+prepared.Data.ID+"/execute", token, map[string]any{"revision": prepared.Data.Revision, "acknowledge_effects": true}, nil)
	if w.Code != 202 {
		t.Fatalf("execute %d %s", w.Code, w.Body.String())
	}
	result := waitBulk(t, a, token, prepared.Data.ID)
	if result.State != "needs_review" || result.Summary["unknown"] < 1 {
		t.Fatalf("not uncertain %+v", result)
	}
	var count int
	_ = s.reader.QueryRow("SELECT count(*) FROM service_accounts WHERE server_id=?", server).Scan(&count)
	if count != 2 {
		t.Fatal("uncertain remote deleted local records", count)
	}
	mu.Lock()
	failReads = false
	before := deletes
	mu.Unlock()
	w = apiRequest(a, "POST", "/api/bulk-operations/"+result.ID+"/reconcile", token, map[string]any{"revision": result.Revision}, nil)
	if w.Code != 200 {
		t.Fatalf("reconcile %d %s", w.Code, w.Body.String())
	}
	mu.Lock()
	after := deletes
	mu.Unlock()
	if after != before {
		t.Fatal("reconciliation replayed delete")
	}
	var out struct{ Data bulkReceipt }
	_ = json.Unmarshal(w.Body.Bytes(), &out)
	if out.Data.Summary["deleted"] < 1 {
		t.Fatal("absence did not reconcile", fmt.Sprint(out.Data))
	}
}

func TestBulkPlexFriendshipGroupsSelectedServersAndPreservesUnselectedRecords(t *testing.T) {
	var responses map[string]string
	provider, _ := plexShareFixture(t, func(m map[string]string) {
		responses = m
		m["https://plex.tv/api/users/"] = `<MediaContainer size="1"><User id="42" username="Reader" allowSync="0"/></MediaContainer>`
	})
	original := provider.client.Transport
	writes := 0
	provider.client.Transport = providerTransport(func(r *http.Request) (*http.Response, error) {
		if r.Method == http.MethodDelete {
			writes++
			if r.URL.String() != "https://plex.tv/api/v2/sharings/42" {
				t.Errorf("wrong remote effect %s", r.URL)
			}
			responses["https://plex.tv/api/users/"] = `<MediaContainer size="0"/>`
			responses["https://plex.tv/api/servers/machine-A/shared_servers"] = `<MediaContainer size="0"/>`
			responses["https://plex.tv/api/invites/requested"] = `<MediaContainer size="0"/>`
			return nil, fmt.Errorf("fixture response lost")
		}
		return original.RoundTrip(r)
	})
	a, s := testApp(t)
	token, _ := bootstrapOwner(t, a)
	owner, _ := s.Authenticate(t.Context(), token)
	a.ProviderHTTP = provider.client
	local, _ := s.CreateAccount(t.Context(), owner.UUID, "plex-mixed-local", "fixture-hash", false)
	var services []string
	for i := 0; i < 3; i++ {
		result, err := s.writer.Exec(`INSERT INTO media_servers(server_nickname,service_type,url,api_key) VALUES(?,'plex','http://fixture.invalid','fixture-secret')`, fmt.Sprintf("plex-group-%d", i))
		if err != nil {
			t.Fatal(err)
		}
		server, _ := result.LastInsertId()
		service := seedService(t, s, server)
		activityExec(t, s, "UPDATE service_accounts SET external_user_id='42',external_username='Reader' WHERE uuid=?", service)
		services = append(services, service)
	}
	activityExec(t, s, "UPDATE provider_settings SET enabled=1 WHERE provider_id='plex'")
	if err := s.LinkServiceAccounts(t.Context(), owner.UUID, local, services); err != nil {
		t.Fatal(err)
	}
	w := apiRequest(a, "POST", "/api/users/bulk/prepare", token, map[string]any{"request_id": newUUID(), "user_uuids": []string{local, services[0], services[1]}, "operation": map[string]any{"action": "delete_users"}}, nil)
	var prepared struct{ Data bulkReceipt }
	_ = json.Unmarshal(w.Body.Bytes(), &prepared)
	if w.Code != 201 || prepared.Data.Summary["pending"] != 3 {
		t.Fatalf("prepare %d %s", w.Code, w.Body.String())
	}
	w = apiRequest(a, "POST", "/api/bulk-operations/"+prepared.Data.ID+"/execute", token, map[string]any{"revision": prepared.Data.Revision, "acknowledge_effects": true}, nil)
	if w.Code != 202 {
		t.Fatalf("execute %d %s", w.Code, w.Body.String())
	}
	receipt := waitBulk(t, a, token, prepared.Data.ID)
	if receipt.State != "completed" || receipt.Summary["deleted"] != 3 || writes != 1 {
		t.Fatalf("grouped outcome %+v writes%d", receipt, writes)
	}
	var remaining, inactive, links, retired int
	_ = s.reader.QueryRow("SELECT count(*) FROM service_accounts WHERE uuid=?", services[2]).Scan(&remaining)
	_ = s.reader.QueryRow("SELECT count(*) FROM service_accounts WHERE uuid=? AND is_active=0 AND removed_at IS NOT NULL", services[2]).Scan(&inactive)
	_ = s.reader.QueryRow("SELECT count(*) FROM service_links WHERE user_uuid=?", local).Scan(&links)
	_ = s.reader.QueryRow("SELECT count(*) FROM user_accounts WHERE uuid=? AND deleted_at IS NOT NULL", local).Scan(&retired)
	if remaining != 1 || inactive != 1 || links != 0 || retired != 1 {
		t.Fatal("mixed cleanup", remaining, inactive, links, retired)
	}
}

func TestBulkPreparedExpiryReceiptAndRequestIdentity(t *testing.T) {
	a, s := testApp(t)
	token, _ := bootstrapOwner(t, a)
	owner, _ := s.Authenticate(t.Context(), token)
	target, err := s.CreateAccount(t.Context(), owner.UUID, "bulk-expiry-fixture", "fixture-hash", false)
	if err != nil {
		t.Fatal(err)
	}
	body := map[string]any{"request_id": newUUID(), "user_uuids": []string{target}, "operation": map[string]any{"action": "extend_access", "days": 2}}
	w := apiRequest(a, "POST", "/api/users/bulk/prepare", token, body, nil)
	if w.Code != 201 {
		t.Fatalf("prepare: %d %s", w.Code, w.Body.String())
	}
	var prepared struct{ Data bulkReceipt }
	if err := json.Unmarshal(w.Body.Bytes(), &prepared); err != nil {
		t.Fatal(err)
	}
	duplicate := apiRequest(a, "POST", "/api/users/bulk/prepare", token, body, nil)
	if duplicate.Code != 200 {
		t.Fatalf("idempotent prepare %d %s", duplicate.Code, duplicate.Body.String())
	}
	changed := map[string]any{"request_id": body["request_id"], "user_uuids": []string{target}, "operation": map[string]any{"action": "extend_access", "days": 3}}
	if w := apiRequest(a, "POST", "/api/users/bulk/prepare", token, changed, nil); w.Code != 409 {
		t.Fatalf("changed request reuse: %d", w.Code)
	}
	execute := map[string]any{"revision": prepared.Data.Revision, "acknowledge_effects": true}
	w = apiRequest(a, "POST", "/api/bulk-operations/"+prepared.Data.ID+"/execute", token, execute, nil)
	if w.Code != 202 {
		t.Fatalf("execute: %d %s", w.Code, w.Body.String())
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		w = apiRequest(a, "GET", "/api/bulk-operations/"+prepared.Data.ID, token, nil, nil)
		var receipt struct{ Data bulkReceipt }
		_ = json.Unmarshal(w.Body.Bytes(), &receipt)
		if receipt.Data.State == "completed" {
			if receipt.Data.Summary["updated"] != 1 {
				t.Fatalf("receipt %s", w.Body.String())
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("unfinished %s", w.Body.String())
		}
		time.Sleep(10 * time.Millisecond)
	}
	var expires string
	if err := s.reader.QueryRow("SELECT access_expires_at FROM user_accounts WHERE uuid=?", target).Scan(&expires); err != nil {
		t.Fatal(err)
	}
	value, err := time.Parse(time.RFC3339, expires)
	if err != nil || value.Before(time.Now().Add(47*time.Hour)) || value.After(time.Now().Add(49*time.Hour)) {
		t.Fatal("expiry", expires, err)
	}
	// Re-execution returns the existing receipt and cannot extend twice.
	w = apiRequest(a, "POST", "/api/bulk-operations/"+prepared.Data.ID+"/execute", token, execute, nil)
	if w.Code != 200 {
		t.Fatalf("receipt replay %d %s", w.Code, w.Body.String())
	}
	var after string
	_ = s.reader.QueryRow("SELECT access_expires_at FROM user_accounts WHERE uuid=?", target).Scan(&after)
	if after != expires {
		t.Fatal("replayed extension")
	}
}
