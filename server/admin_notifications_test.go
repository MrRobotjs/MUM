package main

import (
	"database/sql"
	"errors"
	"strconv"
	"strings"
	"testing"
)

func inboxSnapshot(t *testing.T, a *App, token string) map[string]any {
	t.Helper()
	w := apiRequest(a, "GET", "/api/notifications", token, nil, nil)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	return responseData(t, w)
}
func inboxBody(s map[string]any, operation string, ids ...int64) map[string]any {
	return map[string]any{"expected_actor_uuid": s["actor_uuid"], "content_revision": s["content_revision"], "inbox_revision": s["inbox_revision"], "operation": operation, "notification_ids": ids}
}
func noticeFixture(t *testing.T, s *Store, server int64, recipient string) int64 {
	t.Helper()
	var result sql.Result
	var err error
	if recipient == "" {
		result, err = s.writer.Exec("INSERT INTO admin_notifications(notification_type,audience,server_id) VALUES('SERVER_NOT_SYNCED','administrators',?)", server)
	} else {
		result, err = s.writer.Exec("INSERT INTO admin_notifications(notification_type,audience,recipient_uuid,server_id) VALUES('SERVER_NOT_SYNCED','recipient',?,?)", recipient, server)
	}
	if err != nil {
		t.Fatal(err)
	}
	id, err := result.LastInsertId()
	if err != nil {
		t.Fatal(err)
	}
	return id
}
func TestNotificationVisibilityIndependentReceiptsAndNoSecrets(t *testing.T) {
	a, s, owner, delegate, user := roleReadFixture(t)
	server := seedServer(t, s)
	broadcast := noticeFixture(t, s, server, "")
	private := noticeFixture(t, s, server, user)
	own := inboxSnapshot(t, a, owner)
	other := inboxSnapshot(t, a, delegate)
	if own["total"] != float64(1) || other["total"] != float64(2) {
		t.Fatal(own, other)
	}
	w := apiRequest(a, "POST", "/api/notifications/state", owner, inboxBody(own, "read", broadcast), nil)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	if inboxSnapshot(t, a, delegate)["unread_count"] != float64(2) {
		t.Fatal("one administrator marked another inbox read")
	}
	// Owner cannot infer or mutate another administrator's private target.
	fresh := inboxSnapshot(t, a, owner)
	if w := apiRequest(a, "POST", "/api/notifications/state", owner, inboxBody(fresh, "dismiss", private), nil); w.Code != 404 {
		t.Fatal(w.Code)
	}
	if w := apiRequest(a, "POST", "/api/notifications/state", owner, inboxBody(fresh, "dismiss", broadcast), nil); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	if inboxSnapshot(t, a, owner)["total"] != float64(0) || inboxSnapshot(t, a, delegate)["total"] != float64(2) {
		t.Fatal("dismissal was global")
	}
	// Another actor's receipt did not invalidate this actor's frozen snapshot.
	if w := apiRequest(a, "POST", "/api/notifications/state", delegate, inboxBody(other, "read_all"), nil); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	if inboxSnapshot(t, a, delegate)["unread_count"] != float64(0) {
		t.Fatal("bulk read failed")
	}
	var events int
	s.reader.QueryRow("SELECT count(*) FROM admin_notifications").Scan(&events)
	if events != 2 {
		t.Fatal("source events were deleted")
	}
	raw := apiRequest(a, "GET", "/api/notifications", delegate, nil, nil).Body.String()
	for _, secret := range []string{"api_key", "recipient_uuid", "details", "password_hash", "http://"} {
		if strings.Contains(raw, secret) {
			t.Fatal("private content exposed", secret)
		}
	}
}
func TestNotificationRevisionAuthorityAndAtomicRollback(t *testing.T) {
	for _, mode := range []string{"actor", "regular", "stale-content", "stale-inbox", "private-batch", "duplicate", "unsupported", "logout", "revoked", "rollback"} {
		t.Run(mode, func(t *testing.T) {
			a, s, owner, delegate, user := roleReadFixture(t)
			server := seedServer(t, s)
			id := noticeFixture(t, s, server, "")
			private := noticeFixture(t, s, server, user)
			snapshot := inboxSnapshot(t, a, owner)
			body := inboxBody(snapshot, "read", id)
			access := owner
			want := 409
			switch mode {
			case "actor":
				body["expected_actor_uuid"] = user
				want = 403
			case "regular":
				s.writer.Exec("DELETE FROM admin_privileges WHERE user_uuid=?", user)
				access = delegate
				body["expected_actor_uuid"] = user
				want = 403
			case "stale-content":
				noticeFixture(t, s, server, user)
			case "stale-inbox":
				s.writer.Exec("INSERT INTO admin_notification_receipts(user_uuid,notification_id,is_read) VALUES(?,?,1)", snapshot["actor_uuid"], id)
			case "private-batch":
				body["notification_ids"] = []int64{id, private}
				want = 404
			case "duplicate":
				body["notification_ids"] = []int64{id, id}
				want = 400
			case "unsupported":
				body["operation"] = "delete_global"
				want = 400
			case "logout":
				s.writer.Exec("DELETE FROM app_sessions WHERE user_uuid=?", snapshot["actor_uuid"])
				want = 401
			case "revoked":
				access = delegate
				s.writer.Exec("DELETE FROM admin_role_permissions WHERE role_id='high'")
				body["expected_actor_uuid"] = user
				want = 403
			}
			if mode == "rollback" {
				p := notificationChange{Actor: snapshot["actor_uuid"].(string), Content: int64(snapshot["content_revision"].(float64)), Inbox: 1, Operation: "dismiss", IDs: []int64{id}}
				rollback := errors.New("rollback after receipt and audit")
				err := s.write(t.Context(), func(tx *sql.Tx) error {
					if _, err := commitNotificationChange(t.Context(), tx, p, owner); err != nil {
						return err
					}
					return rollback
				})
				if !errors.Is(err, rollback) {
					t.Fatal(err)
				}
			} else {
				w := apiRequest(a, "POST", "/api/notifications/state", access, body, nil)
				if w.Code != want {
					t.Fatal(mode, w.Code, w.Body.String())
				}
			}
			var receipts int
			s.reader.QueryRow("SELECT count(*) FROM admin_notification_receipts").Scan(&receipts)
			if mode != "stale-inbox" && receipts != 0 {
				t.Fatal("partial receipt committed")
			}
		})
	}
}
func TestNotificationPagesResolutionAndCurrentProducer(t *testing.T) {
	a, s, token, _, _ := roleReadFixture(t)
	server := seedServer(t, s)
	if _, err := s.writer.Exec(`WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<101) INSERT INTO admin_notifications(notification_type,audience,server_id,recipient_uuid) SELECT 'SERVER_NOT_SYNCED','recipient',?,? FROM n`, server, responseData(t, apiRequest(a, "GET", "/api/auth/session", token, nil, nil))["user"].(map[string]any)["uuid"]); err != nil {
		t.Fatal(err)
	}
	first := inboxSnapshot(t, a, token)
	if len(first["notifications"].([]any)) != 100 || first["total"] != float64(101) {
		t.Fatal(first)
	}
	after := int64(first["next_after"].(float64))
	w := apiRequest(a, "GET", "/api/notifications?after="+strconv.FormatInt(after, 10), token, nil, nil)
	last := responseData(t, w)
	if len(last["notifications"].([]any)) != 1 || last["next_after"] != nil || last["content_revision"] != first["content_revision"] {
		t.Fatal(last)
	}
	if _, err := s.writer.Exec("UPDATE admin_notifications SET resolved=1 WHERE server_id=?", server); err != nil {
		t.Fatal(err)
	}
	resolved := inboxSnapshot(t, a, token)
	if resolved["unread_count"] != float64(0) {
		t.Fatal("resolved alerts remained unread")
	}
	w = apiRequest(a, "POST", "/api/servers", token, map[string]any{"server_nickname": "Notification source", "service_type": "jellyfin", "url": "http://127.0.0.1:9", "api_key": "fixture-private-secret", "is_active": false}, nil)
	if w.Code != 201 {
		t.Fatal(w.Code, w.Body.String())
	}
	produced := inboxSnapshot(t, a, token)
	if produced["total"] != float64(102) || produced["unread_count"] != float64(1) {
		t.Fatal("server producer missing", produced)
	}
	for _, query := range []string{"limit=100", "after=00", "after=-1", "after=1&after=2"} {
		if w := apiRequest(a, "GET", "/api/notifications?"+query, token, nil, nil); w.Code != 400 {
			t.Fatal(query, w.Code)
		}
	}
}

func TestNotificationResolutionRequiresCommittedSuccessfulSync(t *testing.T) {
	a, _ := testApp(t)
	token, _ := bootstrapOwner(t, a)
	upstream, mode := providerFixture(t, "jellyfin")
	id := createManagedServer(t, a, token, "jellyfin", upstream.URL)
	if inboxSnapshot(t, a, token)["unread_count"] != float64(1) {
		t.Fatal("producer missing")
	}
	mode.Store(3)
	if w := apiRequest(a, "POST", "/api/servers/"+strconv.FormatInt(id, 10)+"/sync", token, nil, nil); w.Code != 502 {
		t.Fatal(w.Code, w.Body.String())
	}
	if inboxSnapshot(t, a, token)["unread_count"] != float64(1) {
		t.Fatal("failed sync resolved notification")
	}
	mode.Store(0)
	if w := apiRequest(a, "POST", "/api/servers/"+strconv.FormatInt(id, 10)+"/sync", token, nil, nil); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	snapshot := inboxSnapshot(t, a, token)
	if snapshot["unread_count"] != float64(0) || snapshot["notifications"].([]any)[0].(map[string]any)["resolved"] != true {
		t.Fatal(snapshot)
	}
}
