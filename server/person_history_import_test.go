package main

import (
	"encoding/json"
	"fmt"
	"slices"
	"strings"
	"testing"
	"time"
)

type personImportStatus struct {
	Support string  `json:"support"`
	State   string  `json:"state"`
	Added   int     `json:"added"`
	Person  int     `json:"person_added"`
	Scope   *string `json:"scope"`
}

func readPersonImport(t *testing.T, a *App, token, person string, server int64) personImportStatus {
	t.Helper()
	w := apiRequest(a, "GET", fmt.Sprintf("/api/activity/identities/%s/history-import?server=%d", person, server), token, nil, nil)
	if w.Code != 200 {
		t.Fatal("status", w.Code, w.Body.String())
	}
	var out struct{ Data personImportStatus }
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	return out.Data
}

func startPersonImport(a *App, token, person string, server int64) (int, string) {
	w := apiRequest(a, "POST", "/api/activity/identities/"+person+"/history-import", token, map[string]any{"server_id": server}, nil)
	return w.Code, w.Body.String()
}

// A person's import reads only their accounts' history from the one server,
// in that server's import slot; Jellyfin and Emby offer a full import instead
// and Kavita, Komga and RomM have nothing to import.
func TestPersonHistoryImport(t *testing.T) {
	viewed := time.Date(2026, 11, 10, 20, 0, 0, 0, time.UTC)
	fake := &fakePlexHistory{failAt: -1, entries: []string{
		plexHistoryEntry("1", "42", "100", viewed),
		plexHistoryEntry("2", "77", "101", viewed.Add(time.Hour)),
		plexHistoryEntry("3", "42", "102", viewed.Add(2*time.Hour)),
	}}
	a, s, token, server := plexHistoryFixture(t, fake)
	owner, _ := s.Authenticate(t.Context(), token)
	seedExternalService(t, s, server, "77")
	hash, _ := hashPassword("a-strong-member-password")
	person, err := s.CreateAccount(t.Context(), owner.UUID, "viewer", hash, false)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.LinkServiceAccounts(t.Context(), owner.UUID, person, []string{seedExternalService(t, s, server, "42")}); err != nil {
		t.Fatal(err)
	}
	if status := readPersonImport(t, a, token, person, server); status.Support != "account" || status.State != "never" || status.Scope != nil {
		t.Fatalf("before %+v", status)
	}
	if code, body := startPersonImport(a, token, person, server); code != 202 {
		t.Fatal(code, body)
	}
	waitPlexHistory(t, a, token, server)
	var accounts []string
	rows, _ := s.reader.Query("SELECT account_id FROM history_imports ORDER BY entry_key")
	for rows.Next() {
		var account string
		_ = rows.Scan(&account)
		accounts = append(accounts, account)
	}
	rows.Close()
	if !slices.Equal(accounts, []string{"42", "42"}) {
		t.Fatal("stored", accounts)
	}
	fake.mu.Lock()
	queries := append([]string{}, fake.queries...)
	fake.mu.Unlock()
	if len(queries) == 0 || queries[0] != "accountID=42&sort=viewedAt%3Aasc" {
		t.Fatal("queries", queries)
	}
	status := readPersonImport(t, a, token, person, server)
	if status.State != "completed" || status.Added != 2 || status.Person != 2 || status.Scope == nil || *status.Scope != "account" {
		t.Fatalf("after %+v", status)
	}
	w := apiRequest(a, "GET", fmt.Sprintf("/api/servers/%d/play-history", server), token, nil, nil)
	var serverStatus struct{ Data struct{ Scope string } }
	if json.Unmarshal(w.Body.Bytes(), &serverStatus) != nil || serverStatus.Data.Scope != "account" {
		t.Fatal("server status scope", w.Body.String())
	}
	// Again: nothing new.
	if code, _ := startPersonImport(a, token, person, server); code != 202 {
		t.Fatal(code)
	}
	if status := waitPlexHistory(t, a, token, server); status.Added != 0 || status.AlreadyStored != 2 {
		t.Fatalf("second run %+v", status)
	}
	// A full import running on the server: the person's import waits its turn.
	fake.mu.Lock()
	fake.block = make(chan struct{})
	fake.mu.Unlock()
	if code := startPlexHistory(a, token, server); code != 202 {
		t.Fatal("full import", code)
	}
	if code, body := startPersonImport(a, token, person, server); code != 409 || !strings.Contains(body, "HISTORY_RUNNING") {
		t.Fatal("busy server", code, body)
	}
	fake.mu.Lock()
	close(fake.block)
	fake.block = nil
	fake.mu.Unlock()
	if status := waitPlexHistory(t, a, token, server); status.State != "completed" {
		t.Fatalf("full import %+v", status)
	}
	// The full import added another user's play: none of it is this person's.
	if status := readPersonImport(t, a, token, person, server); status.Scope == nil || *status.Scope != "server" || status.Added != 1 || status.Person != 0 {
		t.Fatalf("full import scope %+v", status)
	}

	// Jellyfin offers a full import; Kavita has nothing to import.
	activityExec(t, s, "UPDATE provider_settings SET enabled=1 WHERE provider_id IN ('jellyfin','kavita')")
	link := func(name, kind, account string) int64 {
		activityExec(t, s, `INSERT INTO media_servers(server_nickname,service_type,url,api_key) VALUES(?,?,?,'fixture-secret')`, name, kind, "http://"+kind+".test")
		var id int64
		_ = s.reader.QueryRow("SELECT id FROM media_servers WHERE server_nickname=?", name).Scan(&id)
		if account != "" {
			if err := s.LinkServiceAccounts(t.Context(), owner.UUID, person, []string{seedExternalService(t, s, id, account)}); err != nil {
				t.Fatal(err)
			}
		}
		return id
	}
	jelly, kavita, other := link("Jelly++", "jellyfin", "j1"), link("Books", "kavita", "7"), link("Other", "plex", "")
	if code, body := startPersonImport(a, token, person, jelly); code != 409 || !strings.Contains(body, "HISTORY_FULL_IMPORT_ONLY") {
		t.Fatal("jellyfin", code, body)
	}
	if status := readPersonImport(t, a, token, person, jelly); status.Support != "server" {
		t.Fatal("jellyfin support", status)
	}
	if code, body := startPersonImport(a, token, person, kavita); code != 409 || !strings.Contains(body, "HISTORY_UNAVAILABLE") {
		t.Fatal("kavita", code, body)
	}
	if status := readPersonImport(t, a, token, person, kavita); status.Support != "none" {
		t.Fatal("kavita support", status)
	}
	if code, _ := startPersonImport(a, token, person, other); code != 404 {
		t.Fatal("a server without the person's account", code)
	}
	w = apiRequest(a, "POST", "/api/auth/login", "", map[string]any{"username": "viewer", "password": "a-strong-member-password"}, nil)
	viewer := responseData(t, w)["access_token"].(string)
	if code, _ := startPersonImport(a, viewer, person, server); code != 403 {
		t.Fatal("a viewer imported", code)
	}
	var audits int
	_ = s.reader.QueryRow("SELECT count(*) FROM audit_events WHERE action='activity.history.person_import'").Scan(&audits)
	if audits != 2 {
		t.Fatal("audits", audits)
	}
}
