package main

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/coder/websocket/wsjson"
)

const credentialOwnerPassword = "a-strong-new-password"
const credentialOldPassword = "old-target-local-password"
const credentialNewPassword = "new-target-local-password"

func credentialFixture(t *testing.T) (*App, *Store, string, string) {
	t.Helper()
	a, s := testApp(t)
	token, _ := bootstrapOwner(t, a)
	owner, _ := s.Authenticate(t.Context(), token)
	hash, err := hashPassword(credentialOldPassword)
	if err != nil {
		t.Fatal(err)
	}
	target, err := s.CreateAccount(t.Context(), owner.UUID, "credential-target", hash, false)
	if err != nil {
		t.Fatal(err)
	}
	return a, s, token, target
}
func credentialRead(t *testing.T, a *App, token, target string) humanCredentialRecord {
	t.Helper()
	w := apiRequest(a, "GET", "/api/users/"+target+"/local-credentials", token, nil, nil)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	var body struct {
		Data humanCredentialRecord `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	return body.Data
}
func credentialInput(p humanCredentialRecord) humanCredentialInput {
	operation := "reset"
	if !p.HasPassword {
		operation = "set_initial"
	}
	return humanCredentialInput{Actor: p.Actor, Target: p.Target, Username: p.Username, HasPassword: &p.HasPassword, Revision: p.Revision, ProfileRevision: p.ProfileRevision, ActivationRevision: p.ActivationRevision, RoleRevision: p.RoleRevision, Operation: operation, Current: credentialOwnerPassword, Replacement: credentialNewPassword, Confirm: credentialNewPassword, Revoke: true, LocalOnly: true}
}
func credentialState(t *testing.T, s *Store, target string) string {
	t.Helper()
	var out string
	if err := s.reader.QueryRow(`SELECT json_object('user',(SELECT json_array(local_username,password_hash,profile_revision,is_active,access_expires_at,force_password_change) FROM user_accounts WHERE uuid=?),'revision',(SELECT revision FROM human_credential_state WHERE uuid=?),'sessions',(SELECT count(*) FROM app_sessions WHERE user_uuid=?),'audits',(SELECT count(*) FROM audit_events))`, target, target, target).Scan(&out); err != nil {
		t.Fatal(err)
	}
	return out
}
func TestHumanCredentialsResetRevokesSignInAndPreservesOtherDomains(t *testing.T) {
	a, s, token, target := credentialFixture(t)
	owner, _ := s.Authenticate(t.Context(), token)
	session, err := s.issueSession(t.Context(), target, false)
	if err != nil {
		t.Fatal(err)
	}
	service := seedService(t, s, seedServer(t, s))
	if err = s.LinkServiceAccounts(t.Context(), owner.UUID, target, []string{service}); err != nil {
		t.Fatal(err)
	}
	if _, err = s.writer.Exec("INSERT INTO user_roles(id,name) VALUES('credential-label','Friend'); INSERT INTO identity_user_roles VALUES(?,'credential-label')", target); err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(a)
	defer server.Close()
	socket, ctx := dialClient(t, server.URL, session.Access)
	defer socket.CloseNow()
	before := credentialRead(t, a, token, target)
	input := credentialInput(before)
	w := apiRequest(a, "PUT", "/api/users/"+target+"/local-credentials", token, input, nil)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	var event map[string]any
	if err = wsjson.Read(ctx, socket, &event); err == nil {
		t.Fatal("old socket survived", event)
	}
	if _, err = s.Authenticate(t.Context(), session.Access); err == nil {
		t.Fatal("old token survived")
	}
	if _, err = s.Authenticate(t.Context(), token); err != nil {
		t.Fatal("owner session revoked", err)
	}
	if w = apiRequest(a, "POST", "/api/auth/login", "", map[string]any{"username": "credential-target", "password": credentialOldPassword}, nil); w.Code != 401 {
		t.Fatal(w.Code, w.Body.String())
	}
	if w = apiRequest(a, "POST", "/api/auth/login", "", map[string]any{"username": "credential-target", "password": credentialNewPassword}, nil); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	after := credentialRead(t, a, token, target)
	if after.Revision == before.Revision || after.ProfileRevision == before.ProfileRevision || after.ActivationRevision != before.ActivationRevision || !after.CanReset {
		t.Fatal(after)
	}
	var intact bool
	if err = s.reader.QueryRow(`SELECT EXISTS(SELECT 1 FROM service_links WHERE user_uuid=? AND service_uuid=?) AND EXISTS(SELECT 1 FROM identity_user_roles WHERE user_uuid=? AND role_id='credential-label') AND NOT EXISTS(SELECT 1 FROM admin_privileges WHERE user_uuid=?)`, target, service, target, target).Scan(&intact); err != nil || !intact {
		t.Fatal(intact, err)
	}
	if w = apiRequest(a, "PUT", "/api/users/"+target+"/local-credentials", token, input, nil); w.Code != 409 {
		t.Fatal("replayed old proof", w.Code, w.Body.String())
	}
	var audits string
	s.reader.QueryRow("SELECT details FROM audit_events WHERE action='account.credentials.change'").Scan(&audits)
	if strings.Contains(audits, credentialNewPassword) || strings.Contains(audits, "pbkdf2") || strings.Contains(audits, credentialOwnerPassword) {
		t.Fatal("secret audit", audits)
	}
}
func TestHumanCredentialsInitialAndInactiveExpiryPreservation(t *testing.T) {
	a, s, token, target := credentialFixture(t)
	if _, err := s.writer.Exec("UPDATE user_accounts SET password_hash=NULL,is_active=0,access_expires_at='2000-01-01T00:00:00Z' WHERE uuid=?", target); err != nil {
		t.Fatal(err)
	}
	p := credentialRead(t, a, token, target)
	if !p.CanSetInitial || p.CanReset || p.HasPassword || p.Active {
		t.Fatal(p)
	}
	w := apiRequest(a, "PUT", "/api/users/"+target+"/local-credentials", token, credentialInput(p), nil)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	var intact bool
	if err := s.reader.QueryRow("SELECT is_active=0 AND access_expires_at='2000-01-01T00:00:00Z' AND password_hash IS NOT NULL FROM user_accounts WHERE uuid=?", target).Scan(&intact); err != nil || !intact {
		t.Fatal(intact, err)
	}
	w = apiRequest(a, "POST", "/api/auth/login", "", map[string]any{"username": "credential-target", "password": credentialNewPassword}, nil)
	if w.Code != 401 {
		t.Fatal("credentials revived inactive/expired account", w.Code)
	}
}
func TestHumanCredentialsRejectInputAuthorityAndUnsupportedTargets(t *testing.T) {
	a, s, token, target := credentialFixture(t)
	owner, _ := s.Authenticate(t.Context(), token)
	for _, tc := range []struct {
		name   string
		change func(*humanCredentialInput)
		code   int
	}{
		{"actor", func(p *humanCredentialInput) { p.Actor = target }, 403},
		{"target", func(p *humanCredentialInput) { p.Target = owner.UUID }, 409},
		{"username", func(p *humanCredentialInput) { p.Username = "other" }, 409},
		{"wrong owner password", func(p *humanCredentialInput) { p.Current = "wrong-owner-password" }, 403},
		{"missing acknowledgement", func(p *humanCredentialInput) { p.LocalOnly = false }, 400},
		{"operation", func(p *humanCredentialInput) { p.Operation = "set_initial" }, 409},
		{"confirmation", func(p *humanCredentialInput) { p.Confirm = "other-password" }, 400},
		{"same owner secret", func(p *humanCredentialInput) { p.Replacement = credentialOwnerPassword; p.Confirm = p.Replacement }, 400},
		{"same target secret", func(p *humanCredentialInput) { p.Replacement = credentialOldPassword; p.Confirm = p.Replacement }, 409},
	} {
		t.Run(tc.name, func(t *testing.T) {
			input := credentialInput(credentialRead(t, a, token, target))
			tc.change(&input)
			before := credentialState(t, s, target)
			w := apiRequest(a, "PUT", "/api/users/"+target+"/local-credentials", token, input, nil)
			if w.Code != tc.code || credentialState(t, s, target) != before {
				t.Fatal(w.Code, w.Body.String())
			}
		})
	}
	lower, err := s.issueSession(t.Context(), target, false)
	if err != nil {
		t.Fatal(err)
	}
	for _, method := range []string{"GET", "PUT"} {
		w := apiRequest(a, method, "/api/users/"+target+"/local-credentials", lower.Access, credentialInput(credentialRead(t, a, token, target)), nil)
		if w.Code != 403 {
			t.Fatal(method, w.Code)
		}
	}
	protected := credentialRead(t, a, token, owner.UUID)
	if protected.CanSetInitial || protected.CanReset {
		t.Fatal(protected)
	}
	service := seedService(t, s, seedServer(t, s))
	w := apiRequest(a, "GET", "/api/users/"+service+"/local-credentials", token, nil, nil)
	if w.Code != 404 {
		t.Fatal(w.Code)
	}
	if _, err = s.writer.Exec("UPDATE user_accounts SET local_username=NULL WHERE uuid=?", target); err != nil {
		t.Fatal(err)
	}
	if p := credentialRead(t, a, token, target); p.Reason != "username_unavailable" || p.CanReset {
		t.Fatal(p)
	}
}
func TestHumanCredentialsCommitRechecksPreparedAuthorityAndRevisions(t *testing.T) {
	for _, mode := range []string{"logout", "credential ABA", "username ABA", "activation ABA", "role revision", "actor password", "actor credential ABA", "pending work", "audit rollback"} {
		t.Run(mode, func(t *testing.T) {
			a, s, token, target := credentialFixture(t)
			actor, _ := s.Authenticate(t.Context(), token)
			if _, err := s.issueSession(t.Context(), target, false); err != nil {
				t.Fatal(err)
			}
			input := credentialInput(credentialRead(t, a, token, target))
			p, err := a.prepareHumanCredentials(t.Context(), actor.UUID, token, target, input)
			if err != nil {
				t.Fatal(err)
			}
			if p.input.Current != "" || p.input.Replacement != "" || p.input.Confirm != "" {
				t.Fatal("plaintext retained in commit proof")
			}
			switch mode {
			case "logout":
				apiRequest(a, "POST", "/api/auth/logout", token, nil, nil)
			case "credential ABA":
				if _, err = s.writer.Exec("UPDATE user_accounts SET force_password_change=1 WHERE uuid=?; UPDATE user_accounts SET force_password_change=0 WHERE uuid=?", target, target); err != nil {
					t.Fatal(err)
				}
			case "username ABA":
				if _, err = s.writer.Exec("UPDATE user_accounts SET local_username='temporary' WHERE uuid=?; UPDATE user_accounts SET local_username='credential-target' WHERE uuid=?", target, target); err != nil {
					t.Fatal(err)
				}
			case "activation ABA":
				if _, err = s.writer.Exec("UPDATE user_accounts SET is_active=0 WHERE uuid=?; UPDATE user_accounts SET is_active=1 WHERE uuid=?", target, target); err != nil {
					t.Fatal(err)
				}
			case "role revision":
				if _, err = s.writer.Exec("UPDATE admin_role_state SET revision=revision+1"); err != nil {
					t.Fatal(err)
				}
			case "actor password":
				if _, err = s.writer.Exec("UPDATE user_accounts SET password_hash='changed' WHERE uuid=?", actor.UUID); err != nil {
					t.Fatal(err)
				}
			case "actor credential ABA":
				if _, err = s.writer.Exec("UPDATE user_accounts SET force_password_change=1 WHERE uuid=?; UPDATE user_accounts SET force_password_change=0 WHERE uuid=?", actor.UUID, actor.UUID); err != nil {
					t.Fatal(err)
				}
			case "pending work":
				if _, err = s.writer.Exec(`INSERT INTO plex_authorizations(id,owner_uuid,browser_hash,status,expires_at,poll_after,created_at,updated_at) VALUES('credential-work',?,'fixture','creating','2099-01-01T00:00:00Z','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')`, target); err != nil {
					t.Fatal(err)
				}
			case "audit rollback":
				if _, err = s.writer.Exec("CREATE TRIGGER reject_credentials_audit BEFORE INSERT ON audit_events WHEN NEW.action='account.credentials.change' BEGIN SELECT RAISE(ABORT,'fixture failure'); END"); err != nil {
					t.Fatal(err)
				}
			}
			before := credentialState(t, s, target)
			err = s.write(t.Context(), func(tx *sql.Tx) error { _, err := commitHumanCredentials(t.Context(), tx, p); return err })
			if err == nil || credentialState(t, s, target) != before {
				t.Fatal(fmt.Sprint("stale/reset commit changed state: ", err))
			}
		})
	}
}

func TestHumanCredentialsAdministratorResetRemainsOwnerOnly(t *testing.T) {
	a, s, token, delegate, target := roleReadFixture(t)
	p := credentialRead(t, a, token, target)
	if p.Reason != "available" || !p.CanReset || p.CanSetInitial || p.CanSetUsername {
		t.Fatal(p)
	}
	if w := apiRequest(a, "GET", "/api/users/"+target+"/local-credentials", delegate, nil, nil); w.Code != 403 {
		t.Fatal(w.Code)
	}
	w := apiRequest(a, "PUT", "/api/users/"+target+"/local-credentials", token, credentialInput(p), nil)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	if _, err := s.Authenticate(t.Context(), delegate); err == nil {
		t.Fatal("administrator session survived")
	}
	var grants int
	if err := s.reader.QueryRow("SELECT count(*) FROM admin_privileges WHERE user_uuid=? AND role_id='high'", target).Scan(&grants); err != nil || grants != 1 {
		t.Fatal(grants, err)
	}
	if _, err := s.writer.Exec("UPDATE user_accounts SET password_hash=NULL WHERE uuid=?", target); err != nil {
		t.Fatal(err)
	}
	p = credentialRead(t, a, token, target)
	if p.Reason != "protected_administrator" || p.CanReset || p.CanSetInitial || p.CanSetUsername {
		t.Fatal(p)
	}
}

func TestHumanCredentialsUnnamedAtomicIdentityAndSignIn(t *testing.T) {
	for _, active := range []bool{true, false} {
		t.Run(fmt.Sprint(active), func(t *testing.T) {
			a, s, token, target := credentialFixture(t)
			owner, _ := s.Authenticate(t.Context(), token)
			service := seedService(t, s, seedServer(t, s))
			if err := s.LinkServiceAccounts(t.Context(), owner.UUID, target, []string{service}); err != nil {
				t.Fatal(err)
			}
			if _, err := s.writer.Exec("INSERT INTO user_roles(id,name) VALUES('initial-label','Friend'); INSERT INTO identity_user_roles VALUES(?,'initial-label')", target); err != nil {
				t.Fatal(err)
			}
			if _, err := s.writer.Exec("UPDATE user_accounts SET local_username=NULL,password_hash=NULL,is_active=? WHERE uuid=?", active, target); err != nil {
				t.Fatal(err)
			}
			if !active {
				if _, err := s.writer.Exec("UPDATE user_accounts SET access_expires_at='2000-01-01T00:00:00Z',local_username='' WHERE uuid=?", target); err != nil {
					t.Fatal(err)
				}
			}
			before := credentialRead(t, a, token, target)
			if !before.CanSetUsername || !before.CanSetInitial || before.CanReset || before.HasPassword || before.Username != "" {
				t.Fatal(before)
			}
			input := credentialInput(before)
			input.NewUsername = "New.Local-User"
			w := apiRequest(a, "PUT", "/api/users/"+target+"/local-credentials", token, input, nil)
			if w.Code != 200 {
				t.Fatal(w.Code, w.Body.String())
			}
			after := credentialRead(t, a, token, target)
			if after.Username != input.NewUsername || !after.HasPassword || after.CanSetUsername || after.CanSetInitial || !after.CanReset || after.Active != active {
				t.Fatal(after)
			}
			var intact bool
			if err := s.reader.QueryRow(`SELECT EXISTS(SELECT 1 FROM service_links WHERE user_uuid=? AND service_uuid=?) AND EXISTS(SELECT 1 FROM identity_user_roles WHERE user_uuid=? AND role_id='initial-label') AND NOT EXISTS(SELECT 1 FROM admin_privileges WHERE user_uuid=?)`, target, service, target, target).Scan(&intact); err != nil || !intact {
				t.Fatal(intact, err)
			}
			w = apiRequest(a, "POST", "/api/auth/login", "", map[string]any{"username": "new.local-user", "password": credentialNewPassword}, nil)
			expected := 200
			if !active {
				expected = 401
			}
			if w.Code != expected {
				t.Fatal(w.Code, w.Body.String())
			}
			if w = apiRequest(a, "PUT", "/api/users/"+target+"/local-credentials", token, input, nil); w.Code != 409 {
				t.Fatal("initial proof replayed", w.Code)
			}
		})
	}
}
func TestHumanCredentialsInitialUsernameValidationAndCollision(t *testing.T) {
	for _, tc := range []struct {
		name, value string
		code        int
	}{
		{"empty", "", 409}, {"padded", " spaced ", 400}, {"unicode", "naïve", 400}, {"control", "bad\nname", 400}, {"long", strings.Repeat("x", 256), 400}, {"case collision", "EXISTING-NAME", 409},
	} {
		t.Run(tc.name, func(t *testing.T) {
			a, s, token, target := credentialFixture(t)
			owner, _ := s.Authenticate(t.Context(), token)
			if _, err := s.CreateAccount(t.Context(), owner.UUID, "existing-name", "fixture-hash", false); err != nil {
				t.Fatal(err)
			}
			if _, err := s.writer.Exec("UPDATE user_accounts SET local_username=NULL,password_hash=NULL WHERE uuid=?", target); err != nil {
				t.Fatal(err)
			}
			input := credentialInput(credentialRead(t, a, token, target))
			input.NewUsername = tc.value
			before := credentialState(t, s, target)
			w := apiRequest(a, "PUT", "/api/users/"+target+"/local-credentials", token, input, nil)
			if w.Code != tc.code || credentialState(t, s, target) != before {
				t.Fatal(w.Code, w.Body.String())
			}
		})
	}
	a, s, token, target := credentialFixture(t)
	input := credentialInput(credentialRead(t, a, token, target))
	input.NewUsername = "rename-denied"
	if w := apiRequest(a, "PUT", "/api/users/"+target+"/local-credentials", token, input, nil); w.Code != 409 {
		t.Fatal(w.Code)
	}
	if _, err := s.writer.Exec("UPDATE user_accounts SET local_username=NULL WHERE uuid=?", target); err != nil {
		t.Fatal(err)
	}
	if p := credentialRead(t, a, token, target); p.CanSetUsername || p.CanSetInitial || p.Reason != "username_unavailable" {
		t.Fatal("unnamed existing secret was treated as missing", p)
	}
}
func TestHumanCredentialsInitialPreparedConflictsAndAtomicRollback(t *testing.T) {
	for _, mode := range []string{"claimed name", "target named", "credential ABA", "audit rollback"} {
		t.Run(mode, func(t *testing.T) {
			a, s, token, target := credentialFixture(t)
			owner, _ := s.Authenticate(t.Context(), token)
			if _, err := s.writer.Exec("UPDATE user_accounts SET local_username=NULL,password_hash=NULL WHERE uuid=?", target); err != nil {
				t.Fatal(err)
			}
			input := credentialInput(credentialRead(t, a, token, target))
			input.NewUsername = "claimed-name"
			p, err := a.prepareHumanCredentials(t.Context(), owner.UUID, token, target, input)
			if err != nil {
				t.Fatal(err)
			}
			switch mode {
			case "claimed name":
				if _, err = s.CreateAccount(t.Context(), owner.UUID, "CLAIMED-NAME", "fixture-hash", false); err != nil {
					t.Fatal(err)
				}
			case "target named":
				if _, err = s.writer.Exec("UPDATE user_accounts SET local_username='other-name' WHERE uuid=?", target); err != nil {
					t.Fatal(err)
				}
			case "credential ABA":
				if _, err = s.writer.Exec("UPDATE user_accounts SET local_username='temporary' WHERE uuid=?; UPDATE user_accounts SET local_username=NULL WHERE uuid=?", target, target); err != nil {
					t.Fatal(err)
				}
			case "audit rollback":
				if _, err = s.writer.Exec("CREATE TRIGGER reject_initial_audit BEFORE INSERT ON audit_events WHEN NEW.action='account.credentials.change' BEGIN SELECT RAISE(ABORT,'fixture'); END"); err != nil {
					t.Fatal(err)
				}
			}
			before := credentialState(t, s, target)
			err = s.write(t.Context(), func(tx *sql.Tx) error { _, err := commitHumanCredentials(t.Context(), tx, p); return err })
			if err == nil || credentialState(t, s, target) != before {
				t.Fatal("partial initial credential commit", err)
			}
		})
	}
}
