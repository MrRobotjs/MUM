package main

import (
	"encoding/json"
	"fmt"
	"net/url"
	"testing"
	"time"

	"app/server/providers/provider"
)

func deleteTimeline(a *App, token, target string, ids ...string) (int, string) {
	w := apiRequest(a, "POST", "/api/activity/identities/"+target+"/timeline/delete", token, map[string]any{"ids": ids}, nil)
	return w.Code, w.Body.String()
}

// Delete mode removes the person's MUM and imported plays together, in one
// audited transaction, and refuses the whole request when any play is still
// playing or isn't theirs.
func TestTimelineDeletePlays(t *testing.T) {
	a, s, token, viewer, local := timelineFixture(t)
	var mumOne, mumThree, plexTwo, someoneElse int64
	_ = s.reader.QueryRow("SELECT id FROM media_activity_history WHERE title='MUM one'").Scan(&mumOne)
	_ = s.reader.QueryRow("SELECT id FROM media_activity_history WHERE title='MUM three'").Scan(&mumThree)
	_ = s.reader.QueryRow("SELECT rowid FROM history_imports WHERE entry_key='/h/2'").Scan(&plexTwo)
	_ = s.reader.QueryRow("SELECT rowid FROM history_imports WHERE entry_key='/h/9'").Scan(&someoneElse)
	activityExec(t, s, `INSERT INTO transcode_policy_stops(history_id,attempted_at,outcome) VALUES(?,'2026-11-01T01:00:00.000000000Z','terminated')`, mumOne)
	count := func(query string) (n int) {
		_ = s.reader.QueryRow(query).Scan(&n)
		return n
	}
	before := count("SELECT count(*) FROM media_activity_history") + count("SELECT count(*) FROM history_imports")

	// Not theirs, a viewer, a bad ID: nothing changes.
	if code, body := deleteTimeline(a, token, local, fmt.Sprintf("mum-%d", mumOne), fmt.Sprintf("plex-%d", someoneElse)); code != 404 {
		t.Fatal("another person's play", code, body)
	}
	if code, _ := deleteTimeline(a, viewer, local, fmt.Sprintf("mum-%d", mumOne)); code != 403 {
		t.Fatal("a viewer deleted", code)
	}
	for _, bad := range [][]string{{}, {"mum-0"}, {"kavita-1"}, {"mum-1", "mum-1"}, {"mum-01"}} {
		if code, _ := deleteTimeline(a, token, local, bad...); code != 400 {
			t.Fatal("accepted", bad, code)
		}
	}
	// A play still in progress can't be deleted, and takes the others with it.
	activityExec(t, s, `INSERT INTO media_activity_current(server_id,external_session_id,history_id) SELECT server_id,external_session_id,id FROM media_activity_history WHERE id=?`, mumThree)
	// The timeline says which play is still in progress, so its delete button is off.
	w := apiRequest(a, "GET", "/api/activity/identities/"+local+"/timeline?scope=all", token, nil, nil)
	var progress struct {
		Data struct {
			Items []struct {
				Title      string `json:"title"`
				InProgress bool   `json:"in_progress"`
			}
		}
	}
	if err := json.Unmarshal(w.Body.Bytes(), &progress); err != nil {
		t.Fatal(err)
	}
	for _, item := range progress.Data.Items {
		if item.InProgress != (item.Title == "MUM three") {
			t.Fatalf("in progress %+v", progress.Data.Items)
		}
	}
	if code, body := deleteTimeline(a, token, local, fmt.Sprintf("mum-%d", mumOne), fmt.Sprintf("mum-%d", mumThree)); code != 409 {
		t.Fatal("deleted a play in progress", code, body)
	}
	if got := count("SELECT count(*) FROM media_activity_history") + count("SELECT count(*) FROM history_imports"); got != before {
		t.Fatal("a refused request deleted plays", got, before)
	}

	code, body := deleteTimeline(a, token, local, fmt.Sprintf("mum-%d", mumOne), fmt.Sprintf("plex-%d", plexTwo))
	if code != 200 {
		t.Fatal(code, body)
	}
	if got := count("SELECT count(*) FROM media_activity_history") + count("SELECT count(*) FROM history_imports"); got != before-2 {
		t.Fatal("deleted", before-got)
	}
	if count("SELECT count(*) FROM transcode_policy_stops") != 0 {
		t.Fatal("policy record of a deleted play kept")
	}
	if count("SELECT count(*) FROM audit_events WHERE action='activity.history.delete'") != 1 {
		t.Fatal("deletion not audited")
	}
	if _, page := readTimeline(t, a, token, local, url.Values{"scope": {"all"}}); timelineTitles(page) != "plex:Plex four,plex:Plex three,mum:MUM three" {
		t.Fatal("timeline after delete", timelineTitles(page))
	}
	// A deleted imported play can be imported again.
	var server int64
	_ = s.reader.QueryRow("SELECT id FROM media_servers WHERE server_nickname='Plex++'").Scan(&server)
	viewed := time.Date(2026, 11, 1, 2, 0, 0, 0, time.UTC)
	if err := a.storeHistoryPage(t.Context(), server, "plex", provider.HistoryPage{Entries: []provider.HistoryEntry{{Key: "/h/2", AccountID: "42", ViewedAt: viewed, Type: "episode", Title: "Plex two"}}, Read: 1, Total: 1}); err != nil {
		t.Fatal(err)
	}
	if count("SELECT count(*) FROM history_imports WHERE entry_key='/h/2'") != 1 {
		t.Fatal("a deleted play could not be imported again")
	}
}
