package main

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestUserListProfileAndServerScopedLibraryNames(t *testing.T) {
	a, s, token, _, _ := roleReadFixture(t)
	sid := seedServer(t, s)
	service := seedService(t, s, sid)
	activityExec(t, s, "UPDATE media_servers SET service_type='plex' WHERE id=?", sid)
	activityExec(t, s, "UPDATE provider_settings SET enabled=1 WHERE provider_id='plex'")
	activityExec(t, s, `INSERT INTO media_libraries(server_id,external_id,name) VALUES(?,'7','Movies'),(?,'8','Music')`, sid, sid)
	activityExec(t, s, `INSERT INTO media_servers(server_nickname,service_type,url) VALUES('Other','plex','http://other.invalid')`)
	activityExec(t, s, `INSERT INTO media_libraries(server_id,external_id,name) SELECT id,'7','Wrong server library' FROM media_servers WHERE server_nickname='Other'`)
	activityExec(t, s, `UPDATE service_accounts SET external_avatar_url='https://plex.tv/users/fixture-user/avatar',service_join_date='2025-06-19T12:00:00Z',allowed_library_ids='["7","999"]' WHERE uuid=?`, service)
	read := func() map[string]any {
		t.Helper()
		w := apiRequest(a, "GET", "/api/users/"+service, token, nil, nil)
		if w.Code != 200 {
			t.Fatal(w.Code, w.Body.String())
		}
		if strings.Contains(w.Body.String(), "plex.tv") {
			t.Fatal("private avatar descriptor exposed")
		}
		return responseData(t, w)
	}
	got := read()
	if got["service_join_date"] != "2025-06-19T12:00:00Z" {
		t.Error("missing join date", got["service_join_date"])
	}
	avatar, _ := got["avatar_url"].(string)
	if !strings.HasPrefix(avatar, "/api/user-avatars/") {
		t.Error("missing signed avatar", avatar)
	}
	names, _ := json.Marshal(got["libraries"])
	if string(names) != `["Movies","Library 999 (name unavailable)"]` {
		t.Error("wrong library display names", string(names))
	}
	ids, _ := json.Marshal(got["allowed_library_ids"])
	if string(ids) != `["7","999"]` {
		t.Error("grant IDs changed", string(ids))
	}
	activityExec(t, s, `UPDATE service_accounts SET service_settings='{"all_libraries":true}' WHERE uuid=?`, service)
	names, _ = json.Marshal(read()["libraries"])
	if string(names) != `["Movies","Music"]` {
		t.Error("all-libraries names missing", string(names))
	}
	activityExec(t, s, `UPDATE service_accounts SET external_avatar_url=NULL,service_join_date=NULL WHERE uuid=?`, service)
	got = read()
	if got["avatar_url"] != nil || got["service_join_date"] != nil {
		t.Fatal("unknown profile data invented", got["service_join_date"])
	}
}

func TestUserListLocalJoinIsActualLocalCreation(t *testing.T) {
	a, _, token, _, _ := roleReadFixture(t)
	w := apiRequest(a, "GET", "/api/users?user_type=owner", token, nil, nil)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	var page struct{ Data []map[string]any }
	if err := json.Unmarshal(w.Body.Bytes(), &page); err != nil || len(page.Data) != 1 {
		t.Fatal(err)
	}
	if page.Data[0]["service_join_date"] != page.Data[0]["created_at"] {
		t.Fatal("local join date should reflect actual local account creation")
	}
}

func TestUserListUnknownEmailIsNull(t *testing.T) {
	a, s, token, _, _ := roleReadFixture(t)
	service := seedService(t, s, seedServer(t, s))
	activityExec(t, s, `UPDATE service_accounts SET external_email=NULL WHERE uuid=?`, service)
	w := apiRequest(a, "GET", "/api/users/"+service, token, nil, nil)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	got := responseData(t, w)
	if v, present := got["external_email"]; !present || v != nil || got["email"] != nil {
		t.Fatal("unknown email should be null so the card shows No email", got["email"], got["external_email"])
	}
}

// A local account has no service columns; with the Plex provider enabled the
// avatar-eligibility expression must still read as false, not NULL.
func TestUserListIncludesLocalAccountsWithPlexEnabled(t *testing.T) {
	a, s, token, _, _ := roleReadFixture(t)
	sid := seedServer(t, s)
	seedService(t, s, sid)
	activityExec(t, s, "UPDATE media_servers SET service_type='plex' WHERE id=?", sid)
	activityExec(t, s, "UPDATE provider_settings SET enabled=1 WHERE provider_id='plex'")
	w := apiRequest(a, "GET", "/api/users?page=1&page_size=50&sort=username_asc", token, nil, nil)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	var page struct{ Data []map[string]any }
	if err := json.Unmarshal(w.Body.Bytes(), &page); err != nil {
		t.Fatal(err)
	}
	kinds := map[string]bool{}
	for _, user := range page.Data {
		kinds[user["user_type"].(string)] = true
	}
	if !kinds["owner"] || !kinds["service"] {
		t.Fatal("local and service accounts should both be listed", kinds)
	}
}

// "Seen" on a user card is the latest observed playback for that account.
func TestUserListLastStreamedFromActivityHistory(t *testing.T) {
	a, s, token, _, _ := roleReadFixture(t)
	sid := seedServer(t, s)
	service := seedService(t, s, sid)
	activityExec(t, s, `INSERT INTO media_activity_history(server_id,external_session_id,service_uuid,item_id,media_type,title,first_seen_at,last_seen_at,ended_at,end_reason,paused) VALUES(?,'s1',?,'i','track','Song','2026-11-06T10:00:00Z','2026-11-06T10:30:00Z','2026-11-06T10:31:00Z','not_observed',0),(?,'s2',?,'i','track','Song','2026-11-06T11:00:00Z','2026-11-06T11:45:00Z',NULL,NULL,0)`, sid, service, sid, service)
	w := apiRequest(a, "GET", "/api/users/"+service, token, nil, nil)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	if got := responseData(t, w)["last_streamed_at"]; got != "2026-11-06T11:45:00Z" {
		t.Fatal("last streamed", got)
	}
	w = apiRequest(a, "GET", "/api/users?user_type=owner", token, nil, nil)
	var page struct{ Data []map[string]any }
	if err := json.Unmarshal(w.Body.Bytes(), &page); err != nil || len(page.Data) != 1 {
		t.Fatal(err)
	}
	if v, present := page.Data[0]["last_streamed_at"]; !present || v != nil {
		t.Fatal("account without playback should report null", v)
	}
}

// "Last Streamed" sorts by each user's most recent play, newest or oldest
// first; users who have never streamed come last either way.
func TestUserListSortsByLastStreamed(t *testing.T) {
	a, s, token, _, _ := roleReadFixture(t)
	sid := seedServer(t, s)
	early, late, never := seedService(t, s, sid), seedService(t, s, sid), seedService(t, s, sid)
	activityExec(t, s, `INSERT INTO media_activity_history(server_id,external_session_id,service_uuid,item_id,media_type,title,first_seen_at,last_seen_at,paused) VALUES(?,'e',?,'i','Movie','Film','2026-11-01T10:00:00Z','2026-11-01T11:00:00Z',0),(?,'l',?,'i','Movie','Film','2026-11-05T10:00:00Z','2026-11-05T11:00:00Z',0)`, sid, early, sid, late)
	order := func(sort string) []string {
		t.Helper()
		w := apiRequest(a, "GET", "/api/users?user_type=service&page_size=50&sort="+sort, token, nil, nil)
		if w.Code != 200 {
			t.Fatal(sort, w.Code, w.Body.String())
		}
		var page struct{ Data []map[string]any }
		if err := json.Unmarshal(w.Body.Bytes(), &page); err != nil {
			t.Fatal(err)
		}
		ids := []string{}
		for _, row := range page.Data {
			ids = append(ids, row["uuid"].(string))
		}
		return ids
	}
	if got := order("last_streamed_desc"); strings.Join(got, ",") != strings.Join([]string{late, early, never}, ",") {
		t.Fatal("recent first", got)
	}
	if got := order("last_streamed_asc"); strings.Join(got, ",") != strings.Join([]string{early, late, never}, ",") {
		t.Fatal("oldest first", got)
	}
}
