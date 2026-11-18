package main

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

// avatarFixture serves a Jellyfin user picture, a Plex local thumbnail and a
// Discord CDN avatar, and records every request.
type avatarFixture struct {
	mu       sync.Mutex
	requests []string
}

func (f *avatarFixture) server(t *testing.T) *httptest.Server {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		f.requests = append(f.requests, r.URL.Path)
		f.mu.Unlock()
		switch r.URL.Path {
		case "/Users/j1/Images/Primary", "/accounts/42/thumb", "/avatars/80351110224678912/a1b2c3d4e5f60718a1b2c3d4e5f60718.png":
			w.Header().Set("Content-Type", "image/png")
			_, _ = w.Write([]byte("\x89PNG\r\n\x1a\nfixture"))
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(server.Close)
	return server
}

func (f *avatarFixture) seen(path string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, p := range f.requests {
		if p == path {
			return true
		}
	}
	return false
}

// avatarSetup: the owner and a member "viewer"; Plex, Jellyfin and Kavita
// servers on the fixture; the viewer owns Plex account 42 (local picture),
// Jellyfin account j1 and Kavita account k1.
func avatarSetup(t *testing.T) (*App, *Store, *avatarFixture, string, string, string, map[string]string) {
	t.Helper()
	a, s := testApp(t)
	fixture := &avatarFixture{}
	upstream := fixture.server(t)
	a.ProviderHTTP = upstream.Client()
	a.DiscordCDN = upstream.URL
	token, _ := bootstrapOwner(t, a)
	owner, _ := s.Authenticate(t.Context(), token)
	activityExec(t, s, "UPDATE provider_settings SET enabled=1 WHERE provider_id IN ('plex','jellyfin','kavita')")
	accounts := map[string]string{}
	for _, row := range []struct{ name, kind, account, avatar string }{
		{"Plex++", "plex", "42", "/accounts/42/thumb"}, {"Jelly++", "jellyfin", "j1", ""}, {"Books", "kavita", "k1", ""},
	} {
		activityExec(t, s, `INSERT INTO media_servers(server_nickname,service_type,url,api_key,is_active) VALUES(?,?,?,'fixture-secret',1)`, row.name, row.kind, upstream.URL)
		var server int64
		_ = s.reader.QueryRow("SELECT id FROM media_servers WHERE server_nickname=?", row.name).Scan(&server)
		accounts[row.kind] = seedExternalService(t, s, server, row.account)
		if row.avatar != "" {
			activityExec(t, s, "UPDATE service_accounts SET external_avatar_url=? WHERE uuid=?", row.avatar, accounts[row.kind])
		}
	}
	hash, _ := hashPassword("a-strong-member-password")
	viewer, err := s.CreateAccount(t.Context(), owner.UUID, "viewer", hash, false)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.LinkServiceAccounts(t.Context(), owner.UUID, viewer, []string{accounts["plex"], accounts["jellyfin"], accounts["kavita"]}); err != nil {
		t.Fatal(err)
	}
	w := apiRequest(a, "POST", "/api/auth/login", "", map[string]any{"username": "viewer", "password": "a-strong-member-password"}, nil)
	return a, s, fixture, token, responseData(t, w)["access_token"].(string), viewer, accounts
}

// A member sees pictures of their own linked accounts: Plex and Jellyfin
// have one, Kavita has none. The links work only for them, through MUM.
func TestAccountServiceLinkAvatars(t *testing.T) {
	a, _, fixture, token, viewerToken, viewer, accounts := avatarSetup(t)
	w := apiRequest(a, "GET", "/api/account/service-links", viewerToken, nil, nil)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	links := responseData(t, w)["links"].([]any)
	avatars := map[string]string{}
	for _, raw := range links {
		link := raw.(map[string]any)
		url, _ := link["avatar_url"].(string)
		avatars[link["server_type"].(string)] = url
	}
	if !strings.HasPrefix(avatars["plex"], "/api/service-avatars/") || !strings.HasPrefix(avatars["jellyfin"], "/api/service-avatars/") || avatars["kavita"] != "" {
		t.Fatalf("avatars %v", avatars)
	}
	for kind, path := range map[string]string{"plex": "/accounts/42/thumb", "jellyfin": "/Users/j1/Images/Primary"} {
		got := apiRequest(a, "GET", avatars[kind], "", nil, nil)
		if got.Code != 200 || got.Header().Get("Content-Type") != "image/png" || !fixture.seen(path) {
			t.Fatal(kind, got.Code, got.Body.String())
		}
	}
	// The administrator's own link to the same account works too (admins see
	// every account); a tampered link doesn't.
	if got := apiRequest(a, "GET", strings.Replace(avatars["jellyfin"], "g=", "g=x", 1), "", nil, nil); got.Code != 403 {
		t.Fatal("tampered link served", got.Code)
	}
	admin := apiRequest(a, "GET", "/api/account-links/"+viewer+"/accounts", token, nil, nil)
	if admin.Code != 200 || !strings.Contains(admin.Body.String(), `"avatar_url":"/api/service-avatars/`) {
		t.Fatal("admin linked accounts", admin.Code, admin.Body.String())
	}
	_ = accounts
}

// A link signed for one member doesn't show another member's account.
func TestServiceAvatarLinkIsForItsOwnerOnly(t *testing.T) {
	a, s, _, token, viewerToken, _, accounts := avatarSetup(t)
	owner, _ := s.Authenticate(t.Context(), token)
	hash, _ := hashPassword("another-strong-password")
	if _, err := s.CreateAccount(t.Context(), owner.UUID, "other", hash, false); err != nil {
		t.Fatal(err)
	}
	w := apiRequest(a, "POST", "/api/auth/login", "", map[string]any{"username": "other", "password": "another-strong-password"}, nil)
	otherToken := responseData(t, w)["access_token"].(string)
	var session string
	if err := s.reader.QueryRow("SELECT session_id FROM session_access_tokens WHERE token_hash=?", tokenHash(otherToken)).Scan(&session); err != nil {
		t.Fatal(err)
	}
	var item int64
	_ = s.reader.QueryRow("SELECT id FROM identities WHERE uuid=?", accounts["jellyfin"]).Scan(&item)
	link := a.signedImageURL(serviceAvatarPurpose, "/api/service-avatars", session, item, time.Now())
	if got := apiRequest(a, "GET", link, "", nil, nil); got.Code != 404 {
		t.Fatal("another member saw the picture", got.Code)
	}
	_ = viewerToken
}

// Discord: the picture of the linked Discord account, fetched by MUM from
// Discord's image server, for the account itself only.
func TestAccountDiscordAvatar(t *testing.T) {
	a, s, fixture, _, viewerToken, viewer, _ := avatarSetup(t)
	activityExec(t, s, "UPDATE user_accounts SET discord_user_id='80351110224678912',discord_username='chris_r',discord_avatar_hash='a1b2c3d4e5f60718a1b2c3d4e5f60718' WHERE uuid=?", viewer)
	w := apiRequest(a, "GET", "/api/account/discord", viewerToken, nil, nil)
	url, _ := responseData(t, w)["avatar_url"].(string)
	if !strings.HasPrefix(url, "/api/discord-avatars/") {
		t.Fatal("discord avatar link", w.Body.String())
	}
	if got := apiRequest(a, "GET", url, "", nil, nil); got.Code != 200 || !fixture.seen("/avatars/80351110224678912/a1b2c3d4e5f60718a1b2c3d4e5f60718.png") {
		t.Fatal("discord avatar", got.Code, got.Body.String())
	}
	// A hash that isn't Discord's form is never fetched.
	activityExec(t, s, "UPDATE user_accounts SET discord_avatar_hash='../../x' WHERE uuid=?", viewer)
	if got := apiRequest(a, "GET", url, "", nil, nil); got.Code == 200 {
		t.Fatal("bad hash fetched")
	}
	w = apiRequest(a, "GET", "/api/account/discord", viewerToken, nil, nil)
	if _, ok := responseData(t, w)["avatar_url"].(string); ok {
		t.Fatal("bad hash offered a link")
	}
}

// The Plex sign-in link shows the picture of the Plex server account with the
// same plex.tv ID, even when that account isn't linked to this member.
func TestPlexConnectionAvatar(t *testing.T) {
	a, s, _, token, viewerToken, viewer, accounts := avatarSetup(t)
	owner, _ := s.Authenticate(t.Context(), token)
	// Unlink the Plex account from the viewer: the plex.tv ID still matches.
	activityExec(t, s, "DELETE FROM service_links WHERE service_uuid=?", accounts["plex"])
	activityExec(t, s, `INSERT INTO plex_connections(id,owner_uuid,account_id,username,status,created_at,verified_at) VALUES('pc1',?,'42','AllCinema','active','2026-11-18T00:00:00Z','2026-11-18T00:00:00Z')`, viewer)
	w := apiRequest(a, "GET", "/api/plex/connection", viewerToken, nil, nil)
	url, _ := responseData(t, w)["avatar_url"].(string)
	if !strings.HasPrefix(url, "/api/service-avatars/") {
		t.Fatal("plex link avatar", w.Body.String())
	}
	if got := apiRequest(a, "GET", url, "", nil, nil); got.Code != 200 {
		t.Fatal("plex link picture", got.Code, got.Body.String())
	}
	// Revoked: the picture is no longer theirs.
	activityExec(t, s, "UPDATE plex_connections SET status='revoked' WHERE id='pc1'")
	if got := apiRequest(a, "GET", url, "", nil, nil); got.Code != 404 {
		t.Fatal("revoked link still shows the picture", got.Code)
	}
	_ = owner
	_ = fmt.Sprint
}
