package main

import (
	"database/sql"
	"errors"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/coder/websocket/wsjson"
)

const changedAccountPassword = "changed-local-private-password"

func accountPasswordBody(user, current string) map[string]any {
	return map[string]any{"expected_user_uuid": user, "current_password": current, "new_password": changedAccountPassword, "confirm_password": changedAccountPassword, "acknowledge_revoke_sessions": true}
}

func TestAccountPasswordChangesHashRevokesAliasesRefreshAndSockets(t *testing.T) {
	a, s := testApp(t)
	token, cookie := bootstrapOwner(t, a)
	owner, _ := s.Authenticate(t.Context(), token)
	rotated, _, err := s.refreshSession(t.Context(), cookie.Value)
	if err != nil {
		t.Fatal(err)
	}
	other, err := s.issueSession(t.Context(), owner.UUID, false)
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(a)
	defer server.Close()
	conn, ctx := dialClient(t, server.URL, other.Access)
	defer conn.CloseNow()
	w := apiRequest(a, "POST", "/api/account/password", token, accountPasswordBody(owner.UUID, "a-strong-new-password"), nil)
	if w.Code != 200 || responseData(t, w)["reauthentication_required"] != true {
		t.Fatal(w.Code, w.Body.String())
	}
	for _, access := range []string{token, rotated.Access, other.Access} {
		if _, err := s.Authenticate(t.Context(), access); err == nil {
			t.Fatal("old access alias survived")
		}
	}
	for _, refresh := range []string{rotated.Refresh, other.Refresh} {
		if _, _, err := s.refreshSession(t.Context(), refresh); err == nil {
			t.Fatal("old refresh survived")
		}
	}
	var reply map[string]any
	if err := wsjson.Read(ctx, conn, &reply); err == nil {
		t.Fatal("old socket remained open")
	}
	if ctx.Err() != nil {
		t.Fatal("revoked socket was not closed before the read deadline")
	}
	if cookies := w.Result().Cookies(); len(cookies) != 1 || cookies[0].Name != "mum_refresh" || cookies[0].MaxAge != -1 || !cookies[0].HttpOnly {
		t.Fatal("refresh cookie not cleared")
	}
	var hash, kind string
	var active bool
	if err := s.reader.QueryRow("SELECT password_hash,kind,is_active FROM user_accounts WHERE uuid=?", owner.UUID).Scan(&hash, &kind, &active); err != nil || !verifyPassword(hash, changedAccountPassword) || verifyPassword(hash, "a-strong-new-password") || kind != "owner" || !active {
		t.Fatal("password/owner invariants failed", err)
	}
	if w := apiRequest(a, "POST", "/api/auth/login", "", map[string]any{"username": "owner", "password": changedAccountPassword}, nil); w.Code != 200 {
		t.Fatal("new password cannot sign in", w.Code, w.Body.String())
	}
	var audit string
	if err := s.reader.QueryRow("SELECT details FROM audit_events WHERE action='account.password.change'").Scan(&audit); err != nil || strings.Contains(audit, changedAccountPassword) || strings.Contains(audit, token) {
		t.Fatal("audit missing or leaked", err)
	}
}

func TestAccountPasswordOrdinaryUserAndConfirmationGuards(t *testing.T) {
	a, s := testApp(t)
	admin, _ := bootstrapOwner(t, a)
	owner, _ := s.Authenticate(t.Context(), admin)
	hash, err := hashPassword(invitationPassword)
	if err != nil {
		t.Fatal(err)
	}
	user, err := s.CreateAccount(t.Context(), owner.UUID, "password-reader", hash, false)
	if err != nil {
		t.Fatal(err)
	}
	tokens, err := s.issueSession(t.Context(), user, false)
	if err != nil {
		t.Fatal(err)
	}
	for _, mode := range []string{"anonymous", "other-user", "wrong-current", "missing-ack", "mismatch", "same-password", "short", "unknown-field"} {
		t.Run(mode, func(t *testing.T) {
			body := accountPasswordBody(user, invitationPassword)
			access := tokens.Access
			want := 400
			switch mode {
			case "anonymous":
				access = ""
				want = 401
			case "other-user":
				body["expected_user_uuid"] = owner.UUID
				want = 403
			case "wrong-current":
				body["current_password"] = "wrong-local-password"
				want = 403
			case "missing-ack":
				body["acknowledge_revoke_sessions"] = false
			case "mismatch":
				body["confirm_password"] = "different-password"
			case "same-password":
				body["new_password"] = invitationPassword
				body["confirm_password"] = invitationPassword
			case "short":
				body["new_password"] = "short"
				body["confirm_password"] = "short"
			case "unknown-field":
				body["user_uuid"] = owner.UUID
			}
			if w := apiRequest(a, "POST", "/api/account/password", access, body, nil); w.Code != want {
				t.Fatal(w.Code, w.Body.String())
			}
		})
	}
	r := httptest.NewRequest("POST", "/api/account/password", strings.NewReader("{}"))
	r.Header.Set("Authorization", "Bearer "+tokens.Access)
	r.Header.Set("Origin", "https://foreign.invalid")
	w := httptest.NewRecorder()
	a.ServeHTTP(w, r)
	if w.Code != 403 {
		t.Fatal("foreign origin admitted")
	}
	if _, err := s.Authenticate(t.Context(), tokens.Access); err != nil {
		t.Fatal("rejected change revoked session")
	}
	if w := apiRequest(a, "POST", "/api/account/password", tokens.Access, accountPasswordBody(user, invitationPassword), nil); w.Code != 200 {
		t.Fatal("ordinary user cannot change own password", w.Code, w.Body.String())
	}
	if _, err := s.Authenticate(t.Context(), admin); err != nil {
		t.Fatal("another user's sessions revoked")
	}
}

func TestAccountPasswordCommitRechecksAndRollsBack(t *testing.T) {
	for _, mode := range []string{"logout", "hash-change", "expiry", "rollback"} {
		t.Run(mode, func(t *testing.T) {
			a, s := testApp(t)
			token, _ := bootstrapOwner(t, a)
			owner, _ := s.Authenticate(t.Context(), token)
			p, err := a.prepareAccountPassword(t.Context(), owner.UUID, token, "a-strong-new-password", changedAccountPassword)
			if err != nil {
				t.Fatal(err)
			}
			if mode == "logout" {
				_, err = s.writer.Exec("DELETE FROM app_sessions WHERE user_uuid=?", owner.UUID)
			}
			if mode == "hash-change" {
				_, err = s.writer.Exec("UPDATE user_accounts SET password_hash='changed-authority' WHERE uuid=?", owner.UUID)
			}
			if mode == "expiry" {
				_, err = s.writer.Exec("UPDATE session_access_tokens SET expires_at='2000-01-01T00:00:00Z'")
			}
			if err != nil {
				t.Fatal(err)
			}
			rollback := errors.New("fixture failure after password/session/audit writes")
			err = s.write(t.Context(), func(tx *sql.Tx) error {
				if err := commitAccountPassword(t.Context(), tx, p); err != nil {
					return err
				}
				if mode == "rollback" {
					return rollback
				}
				return nil
			})
			if err == nil {
				t.Fatal("stale/rolled-back change committed")
			}
			if mode == "rollback" {
				if !errors.Is(err, rollback) {
					t.Fatal(err)
				}
				if _, err := s.Authenticate(t.Context(), token); err != nil {
					t.Fatal("rollback lost session")
				}
				var hash string
				s.reader.QueryRow("SELECT password_hash FROM user_accounts WHERE uuid=?", owner.UUID).Scan(&hash)
				if hash != p.previous {
					t.Fatal("rollback changed hash")
				}
				if err := s.write(t.Context(), func(tx *sql.Tx) error { return commitAccountPassword(t.Context(), tx, p) }); err != nil {
					t.Fatal("rolled-back change not reusable", err)
				}
			}
		})
	}
}

func TestAccountPasswordPreverifiedLoginAndCompetingChangesCannotSurvive(t *testing.T) {
	a, s := testApp(t)
	token, _ := bootstrapOwner(t, a)
	owner, _ := s.Authenticate(t.Context(), token)
	first, err := a.prepareAccountPassword(t.Context(), owner.UUID, token, "a-strong-new-password", changedAccountPassword)
	if err != nil {
		t.Fatal(err)
	}
	second, err := a.prepareAccountPassword(t.Context(), owner.UUID, token, "a-strong-new-password", "competing-local-password")
	if err != nil {
		t.Fatal(err)
	}
	if err := s.write(t.Context(), func(tx *sql.Tx) error { return commitAccountPassword(t.Context(), tx, first) }); err != nil {
		t.Fatal(err)
	}
	if err := s.write(t.Context(), func(tx *sql.Tx) error { return commitAccountPassword(t.Context(), tx, second) }); err == nil {
		t.Fatal("competing prepared change committed")
	}
	if _, err := s.issuePasswordSession(t.Context(), owner.UUID, first.previous, 1, false); err == nil {
		t.Fatal("preverified old password issued a new session")
	}
	if _, err := s.issuePasswordSession(t.Context(), owner.UUID, first.replacement, 2, false); err != nil {
		t.Fatal("current verified password rejected", err)
	}
}
