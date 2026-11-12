package main

import (
	"database/sql"
	"errors"
	"net/http/httptest"
	"strings"
	"testing"
)

func emailBody(user, password, email string, revision int64) map[string]any {
	return map[string]any{"expected_user_uuid": user, "profile_revision": revision, "current_password": password, "email": email, "acknowledge_unverified_contact": true}
}
func TestAccountEmailNormalization(t *testing.T) {
	for _, value := range []string{"Name <a@example.com>", "a@example.com\r\nBcc:x@y.com", "a..b@example.com", "é@example.com", "\"a b\"@example.com", "a@-example.com", "a@example..com", strings.Repeat("x", 65) + "@example.com"} {
		if _, err := normalizeAccountEmail(value); err == nil {
			t.Fatal("invalid contact accepted", value)
		}
	}
	for input, want := range map[string]string{" User+tag@EXAMPLE.COM ": "User+tag@example.com", "": "", "   ": ""} {
		got, err := normalizeAccountEmail(input)
		if err != nil || got != want {
			t.Fatal(got, err)
		}
	}
}
func TestAccountEmailOwnChangeClearAndSessionPreservation(t *testing.T) {
	a, s := testApp(t)
	token, _ := bootstrapOwner(t, a)
	owner, _ := s.Authenticate(t.Context(), token)
	w := apiRequest(a, "PATCH", "/api/account/email", token, emailBody(owner.UUID, "a-strong-new-password", " User+tag@EXAMPLE.COM ", 1), nil)
	if w.Code != 200 || responseData(t, w)["email"] != "User+tag@example.com" || responseData(t, w)["email_verified"] != false || responseData(t, w)["profile_revision"] != float64(2) {
		t.Fatal(w.Code, w.Body.String())
	}
	if _, err := s.Authenticate(t.Context(), token); err != nil {
		t.Fatal("contact change signed out actor")
	}
	profile := apiRequest(a, "GET", "/api/account/profile", token, nil, nil)
	p := responseData(t, profile)
	if p["email"] != "User+tag@example.com" || p["profile_revision"] != float64(2) || p["profile_changes_available"] != false || p["email_change_available"] != true {
		t.Fatal(p)
	}
	w = apiRequest(a, "PATCH", "/api/account/email", token, emailBody(owner.UUID, "a-strong-new-password", "", 2), nil)
	if w.Code != 200 || responseData(t, w)["email"] != nil {
		t.Fatal(w.Code, w.Body.String())
	}
	var email sql.NullString
	var kind string
	var revision int64
	if err := s.reader.QueryRow("SELECT email,kind,profile_revision FROM user_accounts WHERE uuid=?", owner.UUID).Scan(&email, &kind, &revision); err != nil || email.Valid || kind != "owner" || revision != 3 {
		t.Fatal("clear/owner/revision invariant", err)
	}
	var details string
	if err := s.reader.QueryRow("SELECT group_concat(details) FROM audit_events WHERE action='account.email.change'").Scan(&details); err != nil || strings.Contains(details, "User+tag") || strings.Contains(details, token) {
		t.Fatal("missing or sensitive audit", err)
	}
}
func TestAccountEmailStrictAuthorityAndValidation(t *testing.T) {
	a, s := testApp(t)
	admin, _ := bootstrapOwner(t, a)
	owner, _ := s.Authenticate(t.Context(), admin)
	hash, err := hashPassword(invitationPassword)
	if err != nil {
		t.Fatal(err)
	}
	user, err := s.CreateAccount(t.Context(), owner.UUID, "email-reader", hash, false)
	if err != nil {
		t.Fatal(err)
	}
	tokens, err := s.issueSession(t.Context(), user, false)
	if err != nil {
		t.Fatal(err)
	}
	for _, mode := range []string{"anonymous", "target", "password", "revision", "missing-email", "null-email", "display-name", "ack", "unknown-field"} {
		t.Run(mode, func(t *testing.T) {
			body := emailBody(user, invitationPassword, "reader@example.com", 1)
			access := tokens.Access
			want := 400
			switch mode {
			case "anonymous":
				access = ""
				want = 401
			case "target":
				body["expected_user_uuid"] = owner.UUID
				want = 403
			case "password":
				body["current_password"] = "incorrect-local-password"
				want = 403
			case "revision":
				body["profile_revision"] = 2
				want = 409
			case "missing-email":
				delete(body, "email")
			case "null-email":
				body["email"] = nil
			case "display-name":
				body["email"] = "Name <reader@example.com>"
			case "ack":
				body["acknowledge_unverified_contact"] = false
			case "unknown-field":
				body["is_active"] = false
			}
			if w := apiRequest(a, "PATCH", "/api/account/email", access, body, nil); w.Code != want {
				t.Fatal(w.Code, w.Body.String())
			}
		})
	}
	r := httptest.NewRequest("PATCH", "/api/account/email", strings.NewReader("{}"))
	r.Header.Set("Origin", "https://foreign.invalid")
	r.Header.Set("Authorization", "Bearer "+tokens.Access)
	w := httptest.NewRecorder()
	a.ServeHTTP(w, r)
	if w.Code != 403 {
		t.Fatal("cross-origin update")
	}
	if w := apiRequest(a, "PATCH", "/api/account/email", tokens.Access, emailBody(user, invitationPassword, "reader@example.com", 1), nil); w.Code != 200 {
		t.Fatal("ordinary user edit failed", w.Code, w.Body.String())
	}
	var untouched bool
	if err := s.reader.QueryRow("SELECT email IS NULL AND profile_revision=1 FROM user_accounts WHERE uuid=?", owner.UUID).Scan(&untouched); err != nil || !untouched {
		t.Fatal("other actor changed", err)
	}
}
func TestAccountEmailCommitRechecksCredentialSessionAndRevision(t *testing.T) {
	for _, mode := range []string{"logout", "credential", "revision", "aba", "rollback"} {
		t.Run(mode, func(t *testing.T) {
			a, s := testApp(t)
			token, _ := bootstrapOwner(t, a)
			owner, _ := s.Authenticate(t.Context(), token)
			p, err := a.prepareAccountEmail(t.Context(), owner.UUID, token, "a-strong-new-password", "new@example.com", 1)
			if err != nil {
				t.Fatal(err)
			}
			switch mode {
			case "logout":
				_, err = s.writer.Exec("DELETE FROM app_sessions WHERE user_uuid=?", owner.UUID)
			case "credential":
				_, err = s.writer.Exec("UPDATE user_accounts SET password_hash='changed-authority' WHERE uuid=?", owner.UUID)
			case "revision":
				_, err = s.writer.Exec("UPDATE user_accounts SET profile_revision=profile_revision+1 WHERE uuid=?", owner.UUID)
			case "aba":
				_, err = s.writer.Exec("UPDATE user_accounts SET email='temporary@example.com',profile_revision=profile_revision+1 WHERE uuid=?", owner.UUID)
				if err == nil {
					_, err = s.writer.Exec("UPDATE user_accounts SET email=NULL,profile_revision=profile_revision+1 WHERE uuid=?", owner.UUID)
				}
			}
			if err != nil {
				t.Fatal(err)
			}
			rollback := errors.New("fixture rollback after email and audit writes")
			err = s.write(t.Context(), func(tx *sql.Tx) error {
				if err := commitAccountEmail(t.Context(), tx, p); err != nil {
					return err
				}
				if mode == "rollback" {
					return rollback
				}
				return nil
			})
			if err == nil {
				t.Fatal("stale change committed")
			}
			var address sql.NullString
			if err := s.reader.QueryRow("SELECT email FROM user_accounts WHERE uuid=?", owner.UUID).Scan(&address); err != nil || address.Valid {
				t.Fatal("failed change retained email", err)
			}
			if mode == "rollback" {
				if _, err := s.Authenticate(t.Context(), token); err != nil {
					t.Fatal("rollback lost session")
				}
				if err := s.write(t.Context(), func(tx *sql.Tx) error { return commitAccountEmail(t.Context(), tx, p) }); err != nil {
					t.Fatal("rollback proof could not commit", err)
				}
			}
		})
	}
}
func TestAccountEmailCompetingPreparedChangesHaveOneWinner(t *testing.T) {
	a, s := testApp(t)
	token, _ := bootstrapOwner(t, a)
	owner, _ := s.Authenticate(t.Context(), token)
	first, err := a.prepareAccountEmail(t.Context(), owner.UUID, token, "a-strong-new-password", "first@example.com", 1)
	if err != nil {
		t.Fatal(err)
	}
	second, err := a.prepareAccountEmail(t.Context(), owner.UUID, token, "a-strong-new-password", "second@example.com", 1)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.write(t.Context(), func(tx *sql.Tx) error { return commitAccountEmail(t.Context(), tx, first) }); err != nil {
		t.Fatal(err)
	}
	if err := s.write(t.Context(), func(tx *sql.Tx) error { return commitAccountEmail(t.Context(), tx, second) }); !errors.Is(err, ErrConflict) {
		t.Fatal("stale revision accepted", err)
	}
}
