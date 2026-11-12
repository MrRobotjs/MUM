package main

import (
	"app/server/providers/plex"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"
)

func userAvatarFixture(t *testing.T) (*App, *Store, string) {
	t.Helper()
	a, s := testApp(t)
	token, _ := bootstrapOwner(t, a)
	server := createManagedServer(t, a, token, "plex", "http://127.0.0.1:1")
	uuid := seedService(t, s, server)
	activityExec(t, s, "UPDATE service_accounts SET external_avatar_url='https://plex.tv/users/fixture-user/avatar' WHERE uuid=?", uuid)
	var identity int64
	var session string
	if err := s.reader.QueryRow("SELECT id FROM identities WHERE uuid=?", uuid).Scan(&identity); err != nil {
		t.Fatal(err)
	}
	if err := s.reader.QueryRow("SELECT session_id FROM session_access_tokens WHERE token_hash=?", tokenHash(token)).Scan(&session); err != nil {
		t.Fatal(err)
	}
	// Use a delegated administrator so revocation tests exercise current grants.
	activityExec(t, s, "INSERT INTO identities(uuid,kind) VALUES('avatar-admin','local')")
	activityExec(t, s, "INSERT INTO user_accounts(uuid,kind,local_username,created_at,updated_at) VALUES('avatar-admin','local','avatar-admin','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')")
	activityExec(t, s, "INSERT INTO admin_roles(id,name,position) VALUES('avatar-admin','Avatar admin',1)")
	activityExec(t, s, "INSERT INTO admin_role_permissions(role_id,permission_id) SELECT 'avatar-admin',id FROM admin_permissions WHERE name='administrator'")
	activityExec(t, s, "INSERT INTO admin_privileges(user_uuid,role_id) VALUES('avatar-admin','avatar-admin')")
	activityExec(t, s, "UPDATE app_sessions SET user_uuid='avatar-admin' WHERE id=?", session)
	return a, s, a.signedImageURL("user-avatar", "/api/user-avatars", session, identity, time.Now())
}

func TestUserAvatarRechecksAuthorityAndSourceAfterIO(t *testing.T) {
	for _, tc := range []struct {
		name, sql string
		status    int
	}{
		{"unchanged", "", 200},
		{"logout", "DELETE FROM app_sessions", 403},
		{"expired_account", "UPDATE user_accounts SET access_expires_at='2000-01-01T00:00:00Z' WHERE kind='local'", 403},
		{"inactive_account", "UPDATE user_accounts SET is_active=0 WHERE kind='local'", 403},
		{"revoked_permission", "DELETE FROM admin_privileges", 403},
		{"disabled_provider", "UPDATE provider_settings SET enabled=0 WHERE provider_id='plex'", 404},
		{"disabled_source", "UPDATE media_servers SET is_active=0", 404},
		{"disabled_identity", "UPDATE service_accounts SET is_active=0", 404},
		{"changed_config", "UPDATE media_servers SET config_revision=config_revision+1", 409},
		{"changed_avatar", "UPDATE service_accounts SET external_avatar_url='https://plex.tv/users/replaced/avatar'", 409},
		{"changed_external_identity", "UPDATE service_accounts SET external_user_id='replacement'", 409},
	} {
		t.Run(tc.name, func(t *testing.T) {
			a, s, link := userAvatarFixture(t)
			calls := 0
			a.ProviderHTTP = &http.Client{Transport: providerTransport(func(r *http.Request) (*http.Response, error) {
				calls++
				if r.URL.Host != "plex.tv" || r.Header.Get("X-Plex-Token") != "" || r.Header.Get("Authorization") != "" || r.Header.Get("Cookie") != "" || r.URL.RawQuery != "" {
					t.Fatal("avatar leaked credentials or origin")
				}
				if tc.sql != "" {
					activityExec(t, s, tc.sql)
				}
				return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": {"image/png"}}, Body: io.NopCloser(strings.NewReader("PNG user avatar")), Request: r}, nil
			})}
			w := apiRequest(a, "GET", link, "", nil, nil)
			if calls != 1 || w.Code != tc.status || w.Header().Get("Cache-Control") != "private, no-store" {
				t.Fatalf("calls=%d status=%d body=%s", calls, w.Code, w.Body.String())
			}
			if tc.status != 200 && strings.Contains(w.Body.String(), "PNG user avatar") {
				t.Fatal("delivered revoked avatar")
			}
			if strings.Contains(w.Body.String(), "fixture-secret") || strings.Contains(w.Body.String(), "plex.tv") {
				t.Fatal("raw source leaked")
			}
		})
	}
}

func TestUserAvatarRejectsUnauthenticatedAndRevokedLinksBeforeIO(t *testing.T) {
	a, s, link := userAvatarFixture(t)
	a.ProviderHTTP = &http.Client{Transport: providerTransport(func(r *http.Request) (*http.Response, error) {
		t.Fatal("contacted provider without authority")
		return nil, nil
	})}
	for _, target := range []string{"/api/user-avatars/1", link + "tampered"} {
		if w := apiRequest(a, "GET", target, "", nil, nil); w.Code != 403 {
			t.Fatal(w.Code, w.Body.String())
		}
	}
	activityExec(t, s, "DELETE FROM app_sessions")
	if w := apiRequest(a, "GET", link, "", nil, nil); w.Code != 403 {
		t.Fatal(w.Code, w.Body.String())
	}
}

func TestSafePlexUserAvatar(t *testing.T) {
	if got := plex.UserAvatar("https://plex.tv/users/fixture/avatar?c=12&X-Plex-Token=secret"); got != "https://plex.tv/users/fixture/avatar?c=12" {
		t.Fatal(got)
	}
	for _, valid := range []string{"https://plex.tv/avatars/EB9F9F/31/3/80", "https://assets.plex.tv/users/fixture-avatar.png"} {
		if got := plex.UserAvatar(valid + "?X-Plex-Token=secret"); got != valid {
			t.Fatal("missing known public image", got)
		}
	}
	for _, bad := range []string{"https://evil.test/users/a/avatar", "https://plex.tv:444/users/a/avatar", "https://user:secret@plex.tv/users/a/avatar", "//plex.tv/users/a/avatar", "https://plex.tv/library/metadata/1/thumb", "https://plex.tv/users/%2e%2e/avatar"} {
		if plex.UserAvatar(bad) != "" {
			t.Fatal("unsafe avatar accepted", bad)
		}
	}
}

func TestPlexUserAvatarKnownImageTransportStripsCredentials(t *testing.T) {
	for _, avatar := range []string{"https://plex.tv/avatars/EB9F9F/31/3/80", "https://assets.plex.tv/users/fixture-avatar.png"} {
		calls := 0
		client := &http.Client{Transport: providerTransport(func(r *http.Request) (*http.Response, error) {
			calls++
			if r.Header.Get("X-Plex-Token") != "" || r.Header.Get("Authorization") != "" || r.Header.Get("Cookie") != "" || r.URL.RawQuery != "" {
				t.Fatal("public image received credentials")
			}
			return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": {"image/png"}}, Body: io.NopCloser(strings.NewReader("PNG user avatar")), Request: r}, nil
		})}
		p, err := newServerConnection(ProviderConfig{"plex", "https://source.invalid", "private-source-key"}, client)
		if err != nil {
			t.Fatal(err)
		}
		if _, body, err := p.userAvatar(t.Context(), avatar); err != nil || string(body) != "PNG user avatar" || calls != 1 {
			t.Fatal("public avatar missing", err, calls)
		}
	}
}
