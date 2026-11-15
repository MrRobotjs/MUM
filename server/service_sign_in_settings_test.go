package main

import (
	"database/sql"
	"errors"
	"testing"
	"time"
)

// signInSettingsFixture is an owner, a Jellyfin server with one synced
// account, and a regular MUM account that owns that service account.
type signInSettingsFixture struct {
	a       *App
	s       *Store
	owner   string // owner access token
	ownerID string
	server  int64
	service string
	user    string
}

func newSignInSettingsFixture(t *testing.T) signInSettingsFixture {
	t.Helper()
	a, s := testApp(t)
	token, _ := bootstrapOwner(t, a)
	owner, err := s.Authenticate(t.Context(), token)
	if err != nil {
		t.Fatal(err)
	}
	server := seedServer(t, s)
	service := seedService(t, s, server)
	user, err := s.CreateAccount(t.Context(), owner.UUID, "member", "fixture-hash", false)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.writer.Exec("INSERT INTO service_links(user_uuid,service_uuid,link_kind,created_at) VALUES(?,?,'owner',?)", user, service, utcTimestamp(time.Now())); err != nil {
		t.Fatal(err)
	}
	return signInSettingsFixture{a: a, s: s, owner: token, ownerID: owner.UUID, server: server, service: service, user: user}
}

func setSignInSwitches(t *testing.T, s *Store, enabled, admins bool) {
	t.Helper()
	value := func(b bool) string {
		if b {
			return "true"
		}
		return "false"
	}
	if err := s.write(t.Context(), func(tx *sql.Tx) error {
		if err := putSetting(t.Context(), tx, "SERVICE_SIGN_IN", value(enabled)); err != nil {
			return err
		}
		return putSetting(t.Context(), tx, "SERVICE_SIGN_IN_ADMINS", value(admins))
	}); err != nil {
		t.Fatal(err)
	}
}

func issueOriginSession(t *testing.T, s *Store, user string, origin sessionOrigin) sessionTokens {
	t.Helper()
	var tokens sessionTokens
	if err := s.write(t.Context(), func(tx *sql.Tx) error {
		var err error
		tokens, err = insertSession(t.Context(), tx, user, origin, false)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	return tokens
}

func grantAdministrator(t *testing.T, s *Store, user string) {
	t.Helper()
	if _, err := s.writer.Exec("INSERT INTO admin_roles(id,name,position) VALUES('sign-in-admin','Sign-in administrator',10) ON CONFLICT DO NOTHING; INSERT INTO admin_role_permissions VALUES('sign-in-admin','admin') ON CONFLICT DO NOTHING; INSERT INTO admin_privileges VALUES(?,'sign-in-admin')", user); err != nil {
		t.Fatal(err)
	}
}

// sessionUsable reports whether both the access token and a renewal work.
func sessionUsable(t *testing.T, s *Store, tokens sessionTokens) (access, refresh bool) {
	t.Helper()
	_, err := s.Authenticate(t.Context(), tokens.Access)
	access = err == nil
	_, _, err = s.refreshSession(t.Context(), tokens.Refresh)
	refresh = err == nil
	return
}

func TestSignInSettingsDefaultsOffAndAdminOnly(t *testing.T) {
	f := newSignInSettingsFixture(t)
	w := apiRequest(f.a, "GET", "/api/settings/sign-in", f.owner, nil, nil)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	data := responseData(t, w)
	if data["service_sign_in"] != false || data["service_sign_in_admins"] != false {
		t.Fatal("switches must default off", data)
	}
	member := issueOriginSession(t, f.s, f.user, sessionOrigin{Kind: "password"})
	if w := apiRequest(f.a, "GET", "/api/settings/sign-in", member.Access, nil, nil); w.Code != 403 {
		t.Fatal("regular user read sign-in settings", w.Code)
	}
	if w := apiRequest(f.a, "PUT", "/api/settings/sign-in", member.Access, map[string]any{"service_sign_in": true, "service_sign_in_admins": false}, nil); w.Code != 403 {
		t.Fatal("regular user changed sign-in settings", w.Code)
	}
	for _, body := range []map[string]any{{"service_sign_in": true}, {"service_sign_in": "yes", "service_sign_in_admins": false}, {"service_sign_in": true, "service_sign_in_admins": false, "extra": 1}} {
		if w := apiRequest(f.a, "PUT", "/api/settings/sign-in", f.owner, body, nil); w.Code != 400 {
			t.Fatal("malformed settings accepted", body, w.Code)
		}
	}
	w = apiRequest(f.a, "PUT", "/api/settings/sign-in", f.owner, map[string]any{"service_sign_in": true, "service_sign_in_admins": true}, nil)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	data = responseData(t, apiRequest(f.a, "GET", "/api/settings/sign-in", f.owner, nil, nil))
	if data["service_sign_in"] != true || data["service_sign_in_admins"] != true {
		t.Fatal("settings did not round-trip", data)
	}
	if n := countRows(t, f.s, "SELECT count(*) FROM audit_events WHERE action='settings.sign_in.save' AND actor_uuid=?", f.ownerID); n != 1 {
		t.Fatal("settings change not audited", n)
	}
}

func TestSignInSettingsCountsPasswordlessAccounts(t *testing.T) {
	f := newSignInSettingsFixture(t)
	for _, name := range []string{"a", "b"} {
		if _, err := f.s.writer.Exec("INSERT INTO identities(uuid,kind) VALUES(?,'local'); INSERT INTO user_accounts(uuid,kind,created_at,updated_at) VALUES(?,'local',?,?)", name+"-uuid", name+"-uuid", utcTimestamp(time.Now()), utcTimestamp(time.Now())); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := f.s.writer.Exec("INSERT INTO identities(uuid,kind) VALUES('c-uuid','local'); INSERT INTO user_accounts(uuid,kind,is_active,created_at,updated_at) VALUES('c-uuid','local',0,?,?)", utcTimestamp(time.Now()), utcTimestamp(time.Now())); err != nil {
		t.Fatal(err)
	}
	grantAdministrator(t, f.s, "a-uuid")
	data := responseData(t, apiRequest(f.a, "GET", "/api/settings/sign-in", f.owner, nil, nil))
	if data["passwordless_accounts"] != float64(2) || data["passwordless_admins"] != float64(1) {
		t.Fatal("passwordless counts", data)
	}
}

func TestServiceSessionEndsWhenSwitchOff(t *testing.T) {
	f := newSignInSettingsFixture(t)
	setSignInSwitches(t, f.s, true, false)
	service := issueOriginSession(t, f.s, f.user, sessionOrigin{Kind: "service", Service: f.service})
	password := issueOriginSession(t, f.s, f.user, sessionOrigin{Kind: "password"})
	if _, err := f.s.Authenticate(t.Context(), service.Access); err != nil {
		t.Fatal("service session refused while allowed", err)
	}
	setSignInSwitches(t, f.s, false, false)
	if access, refresh := sessionUsable(t, f.s, service); access || refresh {
		t.Fatal("service session survived the switch turning off", access, refresh)
	}
	if access, refresh := sessionUsable(t, f.s, password); !access || !refresh {
		t.Fatal("password session ended with the switch", access, refresh)
	}
}

func TestServiceSessionEndsWhenUnlinkedOrInactive(t *testing.T) {
	for _, change := range []string{
		"DELETE FROM service_links WHERE service_uuid=?",
		"UPDATE service_accounts SET is_active=0 WHERE uuid=?",
		"UPDATE service_accounts SET removed_at='2026-01-01T00:00:00Z' WHERE uuid=?",
		"UPDATE media_servers SET is_active=0 WHERE id=(SELECT server_id FROM service_accounts WHERE uuid=?)",
		"UPDATE service_links SET link_kind='delegate' WHERE service_uuid=?",
	} {
		t.Run(change, func(t *testing.T) {
			f := newSignInSettingsFixture(t)
			setSignInSwitches(t, f.s, true, false)
			tokens := issueOriginSession(t, f.s, f.user, sessionOrigin{Kind: "service", Service: f.service})
			if _, err := f.s.writer.Exec(change, f.service); err != nil {
				t.Fatal(err)
			}
			if access, refresh := sessionUsable(t, f.s, tokens); access || refresh {
				t.Fatal("service session survived", change)
			}
		})
	}
}

func TestServiceSessionAdminRule(t *testing.T) {
	f := newSignInSettingsFixture(t)
	setSignInSwitches(t, f.s, true, true)
	grantAdministrator(t, f.s, f.user)
	tokens := issueOriginSession(t, f.s, f.user, sessionOrigin{Kind: "service", Service: f.service})
	setSignInSwitches(t, f.s, true, false)
	if _, err := f.s.Authenticate(t.Context(), tokens.Access); !errors.Is(err, ErrForbidden) {
		t.Fatal("administrator service session allowed while admins are off", err)
	}
	setSignInSwitches(t, f.s, true, true)
	if _, err := f.s.Authenticate(t.Context(), tokens.Access); err != nil {
		t.Fatal("administrator service session refused while admins are on", err)
	}
	// The owner never signs in through a server login.
	ownerService := seedService(t, f.s, f.server)
	if _, err := f.s.writer.Exec("INSERT INTO service_links(user_uuid,service_uuid,link_kind,created_at) VALUES(?,?,'owner',?)", f.ownerID, ownerService, utcTimestamp(time.Now())); err != nil {
		t.Fatal(err)
	}
	var owner sessionTokens
	if err := f.s.write(t.Context(), func(tx *sql.Tx) error {
		var err error
		owner, err = insertSession(t.Context(), tx, f.ownerID, sessionOrigin{Kind: "service", Service: ownerService}, false)
		return err
	}); !errors.Is(err, ErrForbidden) {
		t.Fatal("owner service session issued", err)
	}
	owner = issueOriginSession(t, f.s, f.ownerID, sessionOrigin{Kind: "password"})
	if _, err := f.s.writer.Exec("UPDATE app_sessions SET sign_in_origin='service',via_service_uuid=? WHERE user_uuid=?", ownerService, f.ownerID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.s.Authenticate(t.Context(), owner.Access); !errors.Is(err, ErrForbidden) {
		t.Fatal("owner service session allowed", err)
	}
}

func TestPlexConnectionSessionRule(t *testing.T) {
	f := newSignInSettingsFixture(t)
	setSignInSwitches(t, f.s, true, false)
	if _, err := f.s.writer.Exec("UPDATE provider_settings SET enabled=1 WHERE provider_id='plex'; INSERT INTO plex_connections(id,owner_uuid,account_id,username,secret,status,created_at,verified_at) VALUES('conn',?,'2','plexuser',x'00','active',?,?)", f.user, utcTimestamp(time.Now()), utcTimestamp(time.Now())); err != nil {
		t.Fatal(err)
	}
	tokens := issueOriginSession(t, f.s, f.user, sessionOrigin{Kind: "plex_connection", PlexConnection: "conn"})
	if _, err := f.s.Authenticate(t.Context(), tokens.Access); err != nil {
		t.Fatal("Plex session refused while allowed", err)
	}
	// A linked Plex account does not depend on the media server switches.
	grantAdministrator(t, f.s, f.user)
	setSignInSwitches(t, f.s, false, false)
	if access, refresh := sessionUsable(t, f.s, tokens); !access || !refresh {
		t.Fatal("linked Plex session ended by the media server switches")
	}
	if _, err := f.s.writer.Exec("UPDATE plex_connections SET status='revoked',revoked_at=? WHERE id='conn'", utcTimestamp(time.Now())); err != nil {
		t.Fatal(err)
	}
	if access, refresh := sessionUsable(t, f.s, tokens); access || refresh {
		t.Fatal("Plex session survived its connection")
	}
}

func TestOneOwnerLinkPerServiceAccount(t *testing.T) {
	f := newSignInSettingsFixture(t)
	other, err := f.s.CreateAccount(t.Context(), f.ownerID, "other", "fixture-hash", false)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.s.writer.Exec("INSERT INTO service_links(user_uuid,service_uuid,link_kind,created_at) VALUES(?,?,'owner',?)", other, f.service, utcTimestamp(time.Now())); err == nil {
		t.Fatal("a service account received a second owner")
	}
	if _, err := f.s.writer.Exec("INSERT INTO service_links(user_uuid,service_uuid,link_kind,created_at) VALUES(?,?,'delegate',?)", other, f.service, utcTimestamp(time.Now())); err != nil {
		t.Fatal("delegate link refused", err)
	}
}
