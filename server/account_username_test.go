package main

import (
	"database/sql"
	"errors"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/coder/websocket/wsjson"
)

func usernameBody(user, password, name string, revision int64) map[string]any {
	return map[string]any{"expected_user_uuid": user, "profile_revision": revision, "current_password": password, "username": name, "acknowledge_revoke_sessions": true}
}

func TestAccountUsernameRevokesAllSessionsPreservesIdentityAndPassword(t *testing.T) {
	a, s := testApp(t)
	token, cookie := bootstrapOwner(t, a)
	owner, _ := s.Authenticate(t.Context(), token)
	rotated, _, err := s.refreshSession(t.Context(), cookie.Value)
	if err != nil {
		t.Fatal(err)
	}
	second, err := s.issueSession(t.Context(), owner.UUID, false)
	if err != nil {
		t.Fatal(err)
	}
	serverID := seedServer(t, s)
	service := seedService(t, s, serverID)
	if err := s.LinkServiceAccounts(t.Context(), owner.UUID, owner.UUID, []string{service}); err != nil {
		t.Fatal(err)
	}
	var hash, external string
	if err := s.reader.QueryRow("SELECT password_hash FROM user_accounts WHERE uuid=?", owner.UUID).Scan(&hash); err != nil {
		t.Fatal(err)
	}
	if err := s.reader.QueryRow("SELECT external_user_id FROM service_accounts WHERE uuid=?", service).Scan(&external); err != nil {
		t.Fatal(err)
	}
	current := responseData(t, apiRequest(a, "GET", "/api/account/username", token, nil, nil))
	if current["initial_credentials_available"] != false || current["username_change_available"] != true || current["username"] != "owner" {
		t.Fatal(current)
	}
	server := httptest.NewServer(a)
	defer server.Close()
	conn, ctx := dialClient(t, server.URL, second.Access)
	defer conn.CloseNow()
	w := apiRequest(a, "PATCH", "/api/account/username", token, usernameBody(owner.UUID, "a-strong-new-password", " renamed-owner ", 1), nil)
	if w.Code != 200 || responseData(t, w)["username"] != "renamed-owner" || responseData(t, w)["profile_revision"] != float64(2) || responseData(t, w)["sessions_revoked"] != true {
		t.Fatal(w.Code, w.Body.String())
	}
	for _, access := range []string{token, rotated.Access, second.Access} {
		if _, err := s.Authenticate(t.Context(), access); err == nil {
			t.Fatal("old access survived")
		}
	}
	for _, refresh := range []string{rotated.Refresh, second.Refresh} {
		if _, _, err := s.refreshSession(t.Context(), refresh); err == nil {
			t.Fatal("old refresh survived")
		}
	}
	var reply map[string]any
	if err := wsjson.Read(ctx, conn, &reply); err == nil || ctx.Err() != nil {
		t.Fatal("socket not closed before deadline", err)
	}
	if cookies := w.Result().Cookies(); len(cookies) != 1 || cookies[0].MaxAge != -1 || cookies[0].Name != "mum_refresh" {
		t.Fatal("cookie not cleared")
	}
	var unchanged bool
	if err := s.reader.QueryRow("SELECT password_hash=? AND kind='owner' AND is_active=1 FROM user_accounts WHERE uuid=?", hash, owner.UUID).Scan(&unchanged); err != nil || !unchanged {
		t.Fatal("identity/hash changed", err)
	}
	if err := s.reader.QueryRow("SELECT external_user_id=? AND EXISTS(SELECT 1 FROM service_links WHERE user_uuid=? AND service_uuid=?) FROM service_accounts WHERE uuid=?", external, owner.UUID, service, service).Scan(&unchanged); err != nil || !unchanged {
		t.Fatal("service link changed", err)
	}
	for _, sample := range []struct {
		name string
		want int
	}{{"owner", 401}, {"RENAMED-OWNER", 200}} {
		w := apiRequest(a, "POST", "/api/auth/login", "", map[string]any{"username": sample.name, "password": "a-strong-new-password"}, nil)
		if w.Code != sample.want {
			t.Fatal(sample.name, w.Code, w.Body.String())
		}
	}
	var audit string
	if err := s.reader.QueryRow("SELECT details FROM audit_events WHERE action='account.username.change'").Scan(&audit); err != nil || audit != "{}" {
		t.Fatal("audit missing or leaked", err)
	}
}

func TestAccountUsernameOrdinaryScopeStrictInputAndUniqueness(t *testing.T) {
	a, s := testApp(t)
	admin, _ := bootstrapOwner(t, a)
	owner, _ := s.Authenticate(t.Context(), admin)
	hash, err := hashPassword(invitationPassword)
	if err != nil {
		t.Fatal(err)
	}
	user, err := s.CreateAccount(t.Context(), owner.UUID, "username-reader", hash, false)
	if err != nil {
		t.Fatal(err)
	}
	session, err := s.issueSession(t.Context(), user, false)
	if err != nil {
		t.Fatal(err)
	}
	for _, mode := range []string{"anonymous", "target", "revision", "password", "ack", "empty", "long", "unicode", "control", "unknown", "duplicate", "same"} {
		t.Run(mode, func(t *testing.T) {
			body := usernameBody(user, invitationPassword, "changed-reader", 1)
			token, want := session.Access, 400
			switch mode {
			case "anonymous":
				token, want = "", 401
			case "target":
				body["expected_user_uuid"], want = owner.UUID, 403
			case "revision":
				body["profile_revision"], want = 9, 409
			case "password":
				body["current_password"], want = "wrong-local-password", 403
			case "ack":
				body["acknowledge_revoke_sessions"] = false
			case "empty":
				body["username"] = "   "
			case "long":
				body["username"] = strings.Repeat("a", 256)
			case "unicode":
				body["username"] = "reader-é"
			case "control":
				body["username"] = "reader\nname"
			case "unknown":
				body["is_admin"] = true
			case "duplicate":
				body["username"], want = "OWNER", 409
			case "same":
				body["username"], want = "username-reader", 409
			}
			if w := apiRequest(a, "PATCH", "/api/account/username", token, body, nil); w.Code != want {
				t.Fatal(w.Code, w.Body.String())
			}
		})
	}
	r := httptest.NewRequest("PATCH", "/api/account/username", strings.NewReader("{}"))
	r.Header.Set("Origin", "https://foreign.invalid")
	r.Header.Set("Authorization", "Bearer "+session.Access)
	w := httptest.NewRecorder()
	a.ServeHTTP(w, r)
	if w.Code != 403 {
		t.Fatal(w.Code)
	}
	if w := apiRequest(a, "PATCH", "/api/account/username", session.Access, usernameBody(user, invitationPassword, "USERNAME-READER", 1), nil); w.Code != 200 {
		t.Fatal("case-only change", w.Code, w.Body.String())
	}
	if _, err := s.Authenticate(t.Context(), admin); err != nil {
		t.Fatal("other actor session revoked", err)
	}
	p := responseData(t, apiRequest(a, "GET", "/api/account/username?uuid="+user, admin, nil, nil))
	if p["user_uuid"] != owner.UUID || p["profile_revision"] != float64(1) {
		t.Fatal("other actor changed", p)
	}
}

func TestAccountUsernamePreparedAuthorityRevisionAndRollback(t *testing.T) {
	for _, mode := range []string{"logout", "access-expired", "profile-expired", "hash", "revision", "name", "duplicate", "rollback"} {
		t.Run(mode, func(t *testing.T) {
			a, s := testApp(t)
			token, _ := bootstrapOwner(t, a)
			owner, _ := s.Authenticate(t.Context(), token)
			p, err := a.prepareAccountUsername(t.Context(), owner.UUID, token, "a-strong-new-password", "new-owner", 1)
			if err != nil {
				t.Fatal(err)
			}
			switch mode {
			case "logout":
				_, err = s.writer.Exec("DELETE FROM app_sessions WHERE user_uuid=?", owner.UUID)
			case "access-expired":
				_, err = s.writer.Exec("UPDATE session_access_tokens SET expires_at='2000-01-01T00:00:00Z'")
			case "profile-expired":
				_, err = s.writer.Exec("UPDATE user_accounts SET access_expires_at='2000-01-01T00:00:00Z' WHERE uuid=?", owner.UUID)
			case "hash":
				_, err = s.writer.Exec("UPDATE user_accounts SET password_hash='changed' WHERE uuid=?", owner.UUID)
			case "revision":
				_, err = s.writer.Exec("UPDATE user_accounts SET profile_revision=profile_revision+1 WHERE uuid=?", owner.UUID)
			case "name":
				_, err = s.writer.Exec("UPDATE user_accounts SET local_username='different' WHERE uuid=?", owner.UUID)
			case "duplicate":
				_, err = s.CreateAccount(t.Context(), owner.UUID, "NEW-OWNER", "fixture-hash", false)
			}
			if err != nil {
				t.Fatal(err)
			}
			rollback := errors.New("fixture rollback after rename/session/audit")
			err = s.write(t.Context(), func(tx *sql.Tx) error {
				if err := commitAccountUsername(t.Context(), tx, p); err != nil {
					return err
				}
				return rollback
			})
			if err == nil || mode == "rollback" && !errors.Is(err, rollback) {
				t.Fatal(err)
			}
			var count int
			if err := s.reader.QueryRow("SELECT count(*) FROM audit_events WHERE action='account.username.change'").Scan(&count); err != nil || count != 0 {
				t.Fatal(count, err)
			}
			if mode == "rollback" {
				if _, err := s.Authenticate(t.Context(), token); err != nil {
					t.Fatal("rollback revoked session")
				}
				if err := s.write(t.Context(), func(tx *sql.Tx) error { return commitAccountUsername(t.Context(), tx, p) }); err != nil {
					t.Fatal("rollback changed prepared authority", err)
				}
			}
		})
	}
}

func TestAccountUsernameLoginProofRejectsRevisionABAAndCompetingEdits(t *testing.T) {
	a, s := testApp(t)
	token, _ := bootstrapOwner(t, a)
	owner, _ := s.Authenticate(t.Context(), token)
	first, err := a.prepareAccountUsername(t.Context(), owner.UUID, token, "a-strong-new-password", "renamed", 1)
	if err != nil {
		t.Fatal(err)
	}
	second, err := a.prepareAccountUsername(t.Context(), owner.UUID, token, "a-strong-new-password", "competing", 1)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.write(t.Context(), func(tx *sql.Tx) error { return commitAccountUsername(t.Context(), tx, first) }); err != nil {
		t.Fatal(err)
	}
	if err := s.write(t.Context(), func(tx *sql.Tx) error { return commitAccountUsername(t.Context(), tx, second) }); err == nil {
		t.Fatal("competing prepared rename committed")
	}
	if _, err := s.issuePasswordSession(t.Context(), owner.UUID, first.credential, 1, false); err == nil {
		t.Fatal("login verified before rename survived")
	}
	if _, err := s.writer.Exec("UPDATE user_accounts SET local_username='owner',profile_revision=profile_revision+1 WHERE uuid=?", owner.UUID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.issuePasswordSession(t.Context(), owner.UUID, first.credential, 1, false); err == nil {
		t.Fatal("rename away/back restored old proof")
	}
	if _, err := s.issuePasswordSession(t.Context(), owner.UUID, first.credential, 3, false); err != nil {
		t.Fatal("fresh login rejected", err)
	}
}

func TestAccountUsernamePasswordlessSnapshotNeverEnablesInitialCredentials(t *testing.T) {
	a, s := testApp(t)
	token, _ := bootstrapOwner(t, a)
	owner, _ := s.Authenticate(t.Context(), token)
	if _, err := s.writer.Exec("UPDATE user_accounts SET password_hash=NULL WHERE uuid=?", owner.UUID); err != nil {
		t.Fatal(err)
	}
	p := responseData(t, apiRequest(a, "GET", "/api/account/username", token, nil, nil))
	if p["username_change_available"] != false || p["initial_credentials_available"] != false {
		t.Fatal("unsupported credentials enabled", p)
	}
	if w := apiRequest(a, "PATCH", "/api/account/username", token, usernameBody(owner.UUID, "a-strong-new-password", "new-owner", 1), nil); w.Code != 403 {
		t.Fatal(w.Code, w.Body.String())
	}
}

func TestAccountUsernamePreservesOriginalInvitationReceiptIdentity(t *testing.T) {
	a, s, token, job, receipt := publicPlexReceiptFixture(t)
	var user string
	if err := s.reader.QueryRow("SELECT user_uuid FROM provisioning_jobs WHERE id=?", job).Scan(&user); err != nil {
		t.Fatal(err)
	}
	if _, err := s.writer.Exec("UPDATE user_accounts SET is_active=1 WHERE uuid=?", user); err != nil {
		t.Fatal(err)
	}
	session, err := s.issueSession(t.Context(), user, false)
	if err != nil {
		t.Fatal(err)
	}
	if w := apiRequest(a, "PATCH", "/api/account/username", session.Access, usernameBody(user, invitationPassword, "renamed-public-reader", 1), nil); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	path := "/api/public/invitations/" + token + "/receipt"
	if w := apiRequest(a, "POST", path, "", receipt, nil); w.Code != 200 {
		t.Fatal("original receipt identity changed", w.Code, w.Body.String())
	}
	receipt["username"] = "renamed-public-reader"
	if w := apiRequest(a, "POST", path, "", receipt, nil); w.Code != 403 {
		t.Fatal("receipt silently rekeyed to new login name", w.Code)
	}
}
