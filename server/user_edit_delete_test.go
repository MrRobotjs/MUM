package main

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"testing"
	"time"
)

func editDelete(t *testing.T, a *App, token string, uuids ...string) (int, map[string]any) {
	t.Helper()
	w := apiRequest(a, "POST", "/api/users/edit", token, map[string]any{"user_uuids": uuids, "operations": []map[string]any{{"action": "delete_users"}}}, nil)
	var body map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &body)
	return w.Code, body
}

func editOutcomes(t *testing.T, body map[string]any) map[string]string {
	t.Helper()
	data := body["data"].(map[string]any)
	out := map[string]string{}
	for _, raw := range data["results"].([]any) {
		r := raw.(map[string]any)
		out[r["uuid"].(string)] = r["outcome"].(string) + ":" + r["reason"].(string)
	}
	return out
}

// Deleting from the Users list: a local account is retired (cannot sign in,
// unlinked, hidden, username free for reuse) while its records and history
// stay; a service account is deleted with its history and links, even while
// playing. Failed invitation jobs are closed; only an invitation being
// processed right now, the owner and administrators are skipped.
func TestEditDeleteRetiresLocalAndDeletesServiceAccounts(t *testing.T) {
	a, s := testApp(t)
	token, _ := bootstrapOwner(t, a)
	owner, err := s.Authenticate(t.Context(), token)
	if err != nil {
		t.Fatal(err)
	}
	local, err := s.CreateAccount(t.Context(), owner.UUID, "alt-local", "fixture-hash", false)
	if err != nil {
		t.Fatal(err)
	}
	session, err := s.issueSession(t.Context(), local, false)
	if err != nil {
		t.Fatal(err)
	}
	server := seedServer(t, s)
	service := seedService(t, s, server)
	if err := s.LinkServiceAccounts(t.Context(), owner.UUID, local, []string{service}); err != nil {
		t.Fatal(err)
	}
	now := utcTimestamp(time.Now())
	activityExec(t, s, `INSERT INTO media_activity_history(server_id,external_session_id,service_uuid,owner_uuid,item_id,media_type,title,first_seen_at,last_seen_at,ended_at,end_reason,paused) VALUES(?,?,?,?,?,?,?,?,?,?,?,0)`, server, "old-session", service, local, "item", "movie", "Old play", now, now, now, "not_observed")
	playing := seedService(t, s, server)
	activityExec(t, s, `INSERT INTO media_activity_history(server_id,external_session_id,service_uuid,item_id,media_type,title,first_seen_at,last_seen_at,paused) VALUES(?,?,?,?,?,?,?,?,0)`, server, "live-session", playing, "item", "movie", "Live play", now, now)
	activityExec(t, s, `INSERT INTO media_activity_current(server_id,external_session_id,history_id) SELECT server_id,external_session_id,id FROM media_activity_history WHERE external_session_id='live-session'`)
	admin, err := s.CreateAccount(t.Context(), owner.UUID, "other-admin", "fixture-hash", false)
	if err != nil {
		t.Fatal(err)
	}
	activityExec(t, s, "INSERT INTO admin_roles(id,name,position) VALUES('edit-admin','Edit admin',5)")
	if err := s.AssignAdminRole(t.Context(), owner.UUID, admin, "edit-admin"); err != nil {
		t.Fatal(err)
	}
	pending, err := s.CreateAccount(t.Context(), owner.UUID, "pending-job", "fixture-hash", false)
	if err != nil {
		t.Fatal(err)
	}
	activityExec(t, s, `INSERT INTO invites(token,expires_at,max_uses,is_active,created_at,updated_at) VALUES('edit-invite',?,1,1,?,?)`, utcTimestamp(time.Now().Add(time.Hour)), utcTimestamp(time.Now()), utcTimestamp(time.Now()))
	activityExec(t, s, `INSERT INTO provisioning_jobs(id,invite_id,user_uuid,status,created_at,updated_at,request_hash,reservation_held,requested_username) SELECT 'edit-job',id,?,'failed',?,?,'hash',1,'pending-job' FROM invites WHERE token='edit-invite'`, pending, utcTimestamp(time.Now()), utcTimestamp(time.Now()))

	busy, err := s.CreateAccount(t.Context(), owner.UUID, "busy-job", "fixture-hash", false)
	if err != nil {
		t.Fatal(err)
	}
	activityExec(t, s, `INSERT INTO provisioning_jobs(id,invite_id,user_uuid,status,created_at,updated_at,request_hash,reservation_held,requested_username) SELECT 'busy-job',id,?,'running',?,?,'hash2',1,'busy-job' FROM invites WHERE token='edit-invite'`, busy, utcTimestamp(time.Now()), utcTimestamp(time.Now()))

	// This test pins the transactional cleanup primitive, not the public
	// provider-backed operation (covered by edit_operations tests).
	var results []any
	err = s.write(t.Context(), func(tx *sql.Tx) error {
		request, _ := http.NewRequestWithContext(t.Context(), "POST", "/", nil)
		for _, id := range []string{local, service, owner.UUID, admin, pending, playing, busy} {
			result, e := editDeleteOne(request, tx, owner.UUID, id, now)
			if e != nil {
				return e
			}
			results = append(results, map[string]any{"uuid": result.UUID, "outcome": result.Outcome, "reason": result.Reason})
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	code, body := 200, map[string]any{"data": map[string]any{"results": results, "summary": map[string]any{"deleted": float64(4), "updated": float64(0), "skipped": float64(3), "errors": float64(0)}}}
	if code != 200 {
		t.Fatal(code, body)
	}
	got := editOutcomes(t, body)
	want := map[string]string{local: "deleted:", service: "deleted:", owner.UUID: "skipped:protected_owner", admin: "skipped:administrator", pending: "deleted:", playing: "deleted:", busy: "skipped:invite_in_progress"}
	for id, outcome := range want {
		if got[id] != outcome {
			t.Fatalf("%s: got %q want %q (all %v)", id, got[id], outcome, got)
		}
	}
	summary := body["data"].(map[string]any)["summary"].(map[string]any)
	if summary["deleted"] != float64(4) || summary["updated"] != float64(0) || summary["skipped"] != float64(3) || summary["errors"] != float64(0) {
		t.Fatal("summary", summary)
	}
	// The retired account cannot sign in, is unlinked and hidden, and its
	// username is free; its record remains.
	if _, err := s.Authenticate(t.Context(), session.Access); err == nil {
		t.Fatal("retired account session still valid")
	}
	var links, records, services, identities, history int
	s.reader.QueryRow("SELECT count(*) FROM service_links WHERE user_uuid=?", local).Scan(&links)
	s.reader.QueryRow("SELECT count(*) FROM user_accounts WHERE uuid=? AND deleted_at IS NOT NULL AND deleted_username='alt-local' AND local_username IS NULL", local).Scan(&records)
	s.reader.QueryRow("SELECT count(*) FROM service_accounts WHERE uuid=?", service).Scan(&services)
	s.reader.QueryRow("SELECT count(*) FROM identities WHERE uuid=?", service).Scan(&identities)
	s.reader.QueryRow("SELECT count(*) FROM media_activity_history WHERE service_uuid=?", service).Scan(&history)
	if links != 0 || records != 1 || services != 0 || identities != 0 || history != 0 {
		t.Fatal("retire/delete state", links, records, services, identities, history)
	}
	// The playing account went with its live session; the failed job no
	// longer holds its reservation or offers a review.
	var playingLeft, current, held int
	s.reader.QueryRow("SELECT count(*) FROM service_accounts WHERE uuid=?", playing).Scan(&playingLeft)
	s.reader.QueryRow("SELECT count(*) FROM media_activity_current").Scan(&current)
	s.reader.QueryRow("SELECT count(*) FROM provisioning_jobs WHERE id='edit-job' AND (resolution IS NOT 'cancelled' OR reservation_held=1)").Scan(&held)
	if playingLeft != 0 || current != 0 || held != 0 {
		t.Fatal("playing/failed-job state", playingLeft, current, held)
	}
	if _, err := s.CreateAccount(t.Context(), owner.UUID, "pending-job", "fixture-hash", false); err != nil {
		t.Fatal("failed job username not freed", err)
	}
	if _, err := s.CreateAccount(t.Context(), owner.UUID, "alt-local", "fixture-hash", false); err != nil {
		t.Fatal("username not freed", err)
	}
	w := apiRequest(a, "GET", "/api/users?page_size=100", token, nil, nil)
	var page struct{ Data []map[string]any }
	json.Unmarshal(w.Body.Bytes(), &page)
	for _, u := range page.Data {
		if u["uuid"] == local {
			t.Fatal("retired account still listed")
		}
	}
	// A retired account cannot be reactivated through the activation control.
	if w := apiRequest(a, "GET", "/api/users/"+local+"/activation", token, nil, nil); w.Code == 200 {
		var activation struct {
			Data struct {
				CanActivate bool `json:"can_activate"`
			} `json:"data"`
		}
		json.Unmarshal(w.Body.Bytes(), &activation)
		if activation.Data.CanActivate {
			t.Fatal("retired account offered for reactivation")
		}
	}
}

func TestEditDeleteRequiresAdministratorAndKnownAction(t *testing.T) {
	a, s := testApp(t)
	token, _ := bootstrapOwner(t, a)
	owner, _ := s.Authenticate(t.Context(), token)
	local, err := s.CreateAccount(t.Context(), owner.UUID, "plain-user", "fixture-hash", false)
	if err != nil {
		t.Fatal(err)
	}
	session, err := s.issueSession(t.Context(), local, false)
	if err != nil {
		t.Fatal(err)
	}
	if code, _ := editDelete(t, a, session.Access, local); code != 403 {
		t.Fatal("non-administrator allowed", code)
	}
	w := apiRequest(a, "POST", "/api/users/edit", token, map[string]any{"user_uuids": []string{local}, "operations": []map[string]any{{"action": "set_expiry"}}}, nil)
	if w.Code != 400 {
		t.Fatal("unsupported edit action accepted", w.Code, w.Body.String())
	}
	if code, _ := editDelete(t, a, token); code != 400 {
		t.Fatal("empty selection accepted", code)
	}
}
