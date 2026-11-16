package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"
)

func TestPurgeDecision(t *testing.T) {
	now := time.Date(2026, 11, 15, 12, 0, 0, 0, time.UTC)
	ago := func(days int) *time.Time { v := now.AddDate(0, 0, -days); return &v }
	rule := editPurgeRule{InactiveDays: 30, ExcludeSharers: true, ExcludeProtected: true}
	for name, c := range map[string]struct {
		account purgeAccount
		rule    editPurgeRule
		want    string
	}{
		"old MUM play":                       {purgeAccount{Joined: *ago(400), MUMLast: ago(31)}, rule, ""},
		"recent MUM play":                    {purgeAccount{Joined: *ago(400), MUMLast: ago(29)}, rule, "recently_active"},
		"recent Plex play wins over old MUM": {purgeAccount{Joined: *ago(400), MUMLast: ago(200), PlexLast: ago(3)}, rule, "recently_active"},
		"recent MUM play wins over old Plex": {purgeAccount{Joined: *ago(400), MUMLast: ago(3), PlexLast: ago(200)}, rule, "recently_active"},
		"never played, joined long ago":      {purgeAccount{Joined: *ago(31)}, rule, ""},
		"never played, joined recently":      {purgeAccount{Joined: *ago(5)}, rule, "recently_joined"},
		"never played, join date ignored":    {purgeAccount{Joined: *ago(5)}, editPurgeRule{InactiveDays: 30, IgnoreJoinDate: true}, ""},
		"protected and skipped":              {purgeAccount{Joined: *ago(400), Protected: true}, rule, "purge_protected"},
		"protected but not skipped":          {purgeAccount{Joined: *ago(400), Protected: true}, editPurgeRule{InactiveDays: 30}, ""},
		"shares back and skipped":            {purgeAccount{Joined: *ago(400), SharesBack: true}, rule, "shares_back"},
		"shares back but not skipped":        {purgeAccount{Joined: *ago(400), SharesBack: true}, editPurgeRule{InactiveDays: 30}, ""},
		"Plex Home member":                   {purgeAccount{Joined: *ago(400), Home: true}, editPurgeRule{InactiveDays: 30}, "plex_home"},
		"owner or administrator":             {purgeAccount{Joined: *ago(400), Guarded: true}, editPurgeRule{InactiveDays: 30}, "protected_account"},
	} {
		if got := purgeDecision(c.account, c.rule, now); got != c.want {
			t.Errorf("%s: %q, want %q", name, got, c.want)
		}
	}
}

type purgeListed struct {
	UUID              string  `json:"uuid"`
	Username          string  `json:"username"`
	ServerName        string  `json:"server_name"`
	ServiceType       string  `json:"service_type"`
	LastStreamedAt    *string `json:"last_streamed_at"`
	LastPlaySource    *string `json:"last_play_source"`
	DaysSinceActivity *int    `json:"days_since_activity"`
	IsWhitelisted     bool    `json:"is_whitelisted"`
	IsSharer          bool    `json:"is_sharer"`
}

func listPurge(t *testing.T, a *App, token string, query url.Values) (int, []purgeListed) {
	t.Helper()
	w := apiRequest(a, "GET", "/api/users/eligible-for-purge?"+query.Encode(), token, nil, nil)
	if w.Code != 200 {
		return w.Code, nil
	}
	var out struct {
		Data struct{ Users []purgeListed }
	}
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	return 200, out.Data.Users
}

func TestEligibleForPurgeListsInactivePlexAccounts(t *testing.T) {
	a, s := testApp(t)
	token, _ := bootstrapOwner(t, a)
	owner, _ := s.Authenticate(t.Context(), token)
	activityExec(t, s, `INSERT INTO media_servers(server_nickname,service_type,url,api_key) VALUES('Plex++','plex','http://plex.test','fixture-secret'),('Jelly','jellyfin','http://jelly.test','fixture-secret')`)
	var plex, jelly int64
	_ = s.reader.QueryRow("SELECT id FROM media_servers WHERE server_nickname='Plex++'").Scan(&plex)
	_ = s.reader.QueryRow("SELECT id FROM media_servers WHERE server_nickname='Jelly'").Scan(&jelly)
	old := utcTimestamp(time.Now().AddDate(-1, 0, 0))
	recent := utcTimestamp(time.Now().AddDate(0, 0, -2))
	account := func(server int64, external string) string {
		id := seedExternalService(t, s, server, external)
		activityExec(t, s, "UPDATE service_accounts SET external_username=?,created_at=? WHERE uuid=?", external, old, id)
		return id
	}
	play := func(service string, server int64, at string) {
		activityExec(t, s, `INSERT INTO media_activity_history(server_id,external_session_id,service_uuid,item_id,media_type,title,first_seen_at,last_seen_at,paused) VALUES(?,?,?,?,?,?,?,?,0)`, server, newUUID(), service, "item", "movie", "Film", at, at)
	}
	inactive := account(plex, "inactive")
	play(inactive, plex, old)
	plexActive := account(plex, "plex-active") // only Plex's own history knows this play
	activityExec(t, s, "INSERT INTO plex_history_imports(server_id,history_key,account_id,viewed_at,imported_at) VALUES(?,'/h/1','plex-active',?,?)", plex, recent, recent)
	never := account(plex, "never")
	newcomer := account(plex, "newcomer")
	activityExec(t, s, "UPDATE service_accounts SET created_at=? WHERE uuid=?", recent, newcomer)
	joinedLongAgo := account(plex, "joined-long-ago") // MUM saw it recently, Plex says it joined long ago
	activityExec(t, s, "UPDATE service_accounts SET created_at=?,service_join_date=? WHERE uuid=?", recent, "2024-01-01T00:00:00Z", joinedLongAgo)
	protected := account(plex, "protected")
	activityExec(t, s, "UPDATE service_accounts SET is_purge_whitelisted=1 WHERE uuid=?", protected)
	sharer := account(plex, "sharer")
	home := account(plex, "home")
	for kind, id := range map[string]string{"shares_back": sharer, "home_user": home} {
		activityExec(t, s, "INSERT INTO identity_user_roles(user_uuid,role_id) SELECT ?,role_id FROM relationship_roles WHERE kind=?", id, kind)
	}
	mine := account(plex, "mine")
	if err := s.LinkServiceAccounts(t.Context(), owner.UUID, owner.UUID, []string{mine}); err != nil {
		t.Fatal(err)
	}
	removed := account(plex, "removed")
	activityExec(t, s, "UPDATE service_accounts SET removed_at=? WHERE uuid=?", recent, removed)
	account(jelly, "jelly-inactive")

	names := func(users []purgeListed) string {
		var out []string
		for _, u := range users {
			out = append(out, u.Username)
		}
		return strings.Join(out, ",")
	}
	code, users := listPurge(t, a, token, url.Values{"inactive_days": {"30"}, "exclude_sharers": {"true"}, "exclude_whitelisted": {"true"}, "ignore_creation_date": {"false"}})
	if code != 200 {
		t.Fatal(code)
	}
	// Oldest activity first; never-played accounts by their join date.
	if got := names(users); got != "joined-long-ago,inactive,never" {
		t.Fatal("listed", got)
	}
	first := users[1]
	if first.UUID != inactive || first.ServerName != "Plex++" || first.ServiceType != "plex" || first.LastPlaySource == nil || *first.LastPlaySource != "mum" || first.LastStreamedAt == nil || first.DaysSinceActivity == nil || *first.DaysSinceActivity < 364 {
		t.Fatalf("inactive %+v", first)
	}
	if users[2].UUID != never || users[2].LastPlaySource != nil || users[2].LastStreamedAt != nil {
		t.Fatalf("never played %+v", users[2])
	}
	code, users = listPurge(t, a, token, url.Values{"inactive_days": {"30"}, "exclude_sharers": {"false"}, "exclude_whitelisted": {"false"}, "ignore_creation_date": {"true"}})
	if code != 200 {
		t.Fatal(code)
	}
	got := map[string]purgeListed{}
	for _, u := range users {
		got[u.Username] = u
	}
	for _, want := range []string{"inactive", "never", "newcomer", "joined-long-ago", "protected", "sharer"} {
		if _, ok := got[want]; !ok {
			t.Fatal("missing", want, names(users))
		}
	}
	if len(got) != 6 || !got["protected"].IsWhitelisted || !got["sharer"].IsSharer {
		t.Fatal("with fewer exclusions", names(users))
	}
	_ = plexActive

	// The newest play from either source counts: a recent MUM play hides an
	// account whose Plex history is old.
	activityExec(t, s, "INSERT INTO plex_history_imports(server_id,history_key,account_id,viewed_at,imported_at) VALUES(?,'/h/2','inactive',?,?)", plex, old, old)
	play(inactive, plex, recent)
	if _, users = listPurge(t, a, token, url.Values{"inactive_days": {"30"}}); strings.Contains(names(users), "inactive") {
		t.Fatal("listed an account with a recent MUM play", names(users))
	}

	for _, bad := range []url.Values{{"inactive_days": {"0"}}, {"inactive_days": {"x"}}, {"inactive_days": {"30"}, "exclude_sharers": {"maybe"}}, {"inactive_days": {"30"}, "other": {"1"}}} {
		if code, _ := listPurge(t, a, token, bad); code != 400 {
			t.Fatal("bad query accepted", bad, code)
		}
	}
	// A role without the Administrator permission cannot purge.
	hash, _ := hashPassword("a-strong-member-password")
	if _, err := s.CreateAccount(t.Context(), owner.UUID, "role-only", hash, false); err != nil {
		t.Fatal(err)
	}
	activityExec(t, s, "INSERT INTO admin_roles(id,name,position) VALUES('cosmetic','Cosmetic',6)")
	activityExec(t, s, "INSERT INTO admin_privileges SELECT uuid,'cosmetic' FROM user_accounts WHERE local_username='role-only'")
	w := apiRequest(a, "POST", "/api/auth/login", "", map[string]any{"username": "role-only", "password": "a-strong-member-password"}, nil)
	viewer := responseData(t, w)["access_token"].(string)
	if code, _ := listPurge(t, a, viewer, url.Values{"inactive_days": {"30"}}); code != 403 {
		t.Fatal("a role without the Administrator permission listed purge candidates", code)
	}
}

// purgeFixture is an owner and one Plex server whose friend 42 ("Reader") is
// an inactive server account; DELETE removes the friendship.
func purgeFixture(t *testing.T) (*App, *Store, string, string, *int) {
	t.Helper()
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
			responses["https://plex.tv/api/users/"] = `<MediaContainer size="0"/>`
			responses["https://plex.tv/api/servers/machine-A/shared_servers"] = `<MediaContainer size="0"/>`
			responses["https://plex.tv/api/invites/requested"] = `<MediaContainer size="0"/>`
			return nil, fmt.Errorf("fixture response lost")
		}
		return original.RoundTrip(r)
	})
	a, s := testApp(t)
	token, _ := bootstrapOwner(t, a)
	a.ProviderHTTP = provider.client
	result, err := s.writer.Exec(`INSERT INTO media_servers(server_nickname,service_type,url,api_key) VALUES('Plex++','plex','http://fixture.invalid','fixture-secret')`)
	if err != nil {
		t.Fatal(err)
	}
	server, _ := result.LastInsertId()
	service := seedService(t, s, server)
	activityExec(t, s, "UPDATE service_accounts SET external_user_id='42',external_username='Reader',created_at=? WHERE uuid=?", utcTimestamp(time.Now().AddDate(-1, 0, 0)), service)
	activityExec(t, s, "UPDATE provider_settings SET enabled=1 WHERE provider_id='plex'")
	return a, s, token, service, &writes
}

var purgeRule = map[string]any{"inactive_days": 30, "exclude_sharers": true, "exclude_whitelisted": true, "ignore_creation_date": false}

func preparePurge(t *testing.T, a *App, token string, ids ...string) editReceipt {
	t.Helper()
	w := apiRequest(a, "POST", "/api/users/edit/prepare", token, map[string]any{"request_id": newUUID(), "user_uuids": ids, "operation": map[string]any{"action": "delete_users", "purge": purgeRule}}, nil)
	var prepared struct{ Data editReceipt }
	if err := json.Unmarshal(w.Body.Bytes(), &prepared); err != nil || w.Code != 201 {
		t.Fatalf("prepare %d %s", w.Code, w.Body.String())
	}
	return prepared.Data
}

func runPurge(t *testing.T, a *App, token string, prepared editReceipt) editReceipt {
	t.Helper()
	if w := apiRequest(a, "POST", "/api/edit-operations/"+prepared.ID+"/execute", token, map[string]any{"revision": prepared.Revision, "acknowledge_effects": true}, nil); w.Code != 202 {
		t.Fatalf("execute %d %s", w.Code, w.Body.String())
	}
	return waitEdit(t, a, token, prepared.ID)
}

func TestPurgeRemovesInactivePlexAccountAfterPlexConfirms(t *testing.T) {
	a, s, token, service, writes := purgeFixture(t)
	owner, _ := s.Authenticate(t.Context(), token)
	local, _ := s.CreateAccount(t.Context(), owner.UUID, "local-only", "fixture-hash", false)
	prepared := preparePurge(t, a, token, service, local)
	reasons := map[string]string{}
	for _, r := range prepared.Results {
		reasons[r.UUID] = r.Outcome + "/" + r.Reason
	}
	// A purge never retires MUM accounts.
	if reasons[service] != "pending/" || reasons[local] != "skipped/service_account_required" {
		t.Fatal(reasons)
	}
	receipt := runPurge(t, a, token, prepared)
	if receipt.State != "completed" || receipt.Summary["deleted"] != 1 || *writes != 1 {
		t.Fatalf("purge %+v writes %d", receipt, *writes)
	}
	var kept, retired int
	_ = s.reader.QueryRow("SELECT count(*) FROM service_accounts WHERE uuid=? AND removed_at IS NULL", service).Scan(&kept)
	_ = s.reader.QueryRow("SELECT count(*) FROM user_accounts WHERE uuid=? AND deleted_at IS NOT NULL", local).Scan(&retired)
	if kept != 0 || retired != 0 {
		t.Fatal("after purge", kept, retired)
	}
	var details string
	if err := s.reader.QueryRow("SELECT details FROM audit_events WHERE action='users.purge'").Scan(&details); err != nil {
		t.Fatal("no purge audit", err)
	}
	var audit map[string]any
	_ = json.Unmarshal([]byte(details), &audit)
	if audit["inactive_days"] != float64(30) || audit["deleted"] != float64(1) || audit["skipped"] != float64(1) {
		t.Fatal("audit", details)
	}
}

func TestPurgeSkipsAccountThatPlayedSinceTheList(t *testing.T) {
	a, s, token, service, writes := purgeFixture(t)
	prepared := preparePurge(t, a, token, service)
	if prepared.Summary["pending"] != 1 {
		t.Fatal(prepared)
	}
	var server int64
	_ = s.reader.QueryRow("SELECT server_id FROM service_accounts WHERE uuid=?", service).Scan(&server)
	now := utcTimestamp(time.Now())
	activityExec(t, s, `INSERT INTO media_activity_history(server_id,external_session_id,service_uuid,item_id,media_type,title,first_seen_at,last_seen_at,paused) VALUES(?,?,?,?,?,?,?,?,0)`, server, "fresh", service, "item", "movie", "Film", now, now)
	receipt := runPurge(t, a, token, prepared)
	if receipt.Summary["skipped"] != 1 || receipt.Results[0].Reason != "recently_active" || *writes != 0 {
		t.Fatalf("purge %+v writes %d", receipt, *writes)
	}
	var kept int
	_ = s.reader.QueryRow("SELECT count(*) FROM service_accounts WHERE uuid=? AND removed_at IS NULL", service).Scan(&kept)
	if kept != 1 {
		t.Fatal("removed an active account")
	}
}

func TestPurgeSkipsAccountProtectedSinceTheList(t *testing.T) {
	a, s, token, service, writes := purgeFixture(t)
	prepared := preparePurge(t, a, token, service)
	// Protection set directly, without touching the account's fingerprint.
	activityExec(t, s, "UPDATE service_accounts SET is_purge_whitelisted=1 WHERE uuid=?", service)
	receipt := runPurge(t, a, token, prepared)
	if receipt.Summary["skipped"] != 1 || receipt.Results[0].Reason != "purge_protected" || *writes != 0 {
		t.Fatalf("purge %+v writes %d", receipt, *writes)
	}
	if w := apiRequest(a, "POST", "/api/users/edit/prepare", token, map[string]any{"request_id": newUUID(), "user_uuids": []string{service}, "operation": map[string]any{"action": "delete_users", "purge": map[string]any{"inactive_days": 0}}}, nil); w.Code != 400 {
		t.Fatal("zero days accepted", w.Code)
	}
	if w := apiRequest(a, "POST", "/api/users/edit/prepare", token, map[string]any{"request_id": newUUID(), "user_uuids": []string{service}, "operation": map[string]any{"action": "clear_expiration", "purge": purgeRule}}, nil); w.Code != 400 {
		t.Fatal("purge rule on another action accepted", w.Code)
	}
}

// Removing a Plex share removes the friendship, which also ends access to the
// owner's other Plex servers. A person still active (or protected) on another
// server is neither listed nor removed.
func TestPurgeKeepsFriendActiveOnAnotherServer(t *testing.T) {
	a, s, token, service, writes := purgeFixture(t)
	result, err := s.writer.Exec(`INSERT INTO media_servers(server_nickname,service_type,url,api_key) VALUES('Plex Two','plex','http://two.invalid','fixture-secret')`)
	if err != nil {
		t.Fatal(err)
	}
	second, _ := result.LastInsertId()
	other := seedService(t, s, second)
	now := utcTimestamp(time.Now())
	activityExec(t, s, "UPDATE service_accounts SET external_user_id='42',external_username='Reader',created_at=? WHERE uuid=?", utcTimestamp(time.Now().AddDate(-1, 0, 0)), other)
	activityExec(t, s, `INSERT INTO media_activity_history(server_id,external_session_id,service_uuid,item_id,media_type,title,first_seen_at,last_seen_at,paused) VALUES(?,?,?,?,?,?,?,?,0)`, second, "elsewhere", other, "item", "movie", "Film", now, now)
	if _, users := listPurge(t, a, token, url.Values{"inactive_days": {"30"}}); len(users) != 0 {
		t.Fatal("listed a person active on another server", users)
	}
	prepared := preparePurge(t, a, token, service)
	if prepared.Results[0].Outcome != "skipped" || prepared.Results[0].Reason != "kept_on_another_server" || *writes != 0 {
		t.Fatalf("prepared %+v", prepared)
	}
	// Once inactive everywhere, both accounts are listed.
	activityExec(t, s, "DELETE FROM media_activity_history WHERE service_uuid=?", other)
	if _, users := listPurge(t, a, token, url.Values{"inactive_days": {"30"}}); len(users) != 2 {
		t.Fatal("inactive everywhere", users)
	}
}
