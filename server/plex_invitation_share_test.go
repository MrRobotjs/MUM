package main

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"
)

// plexInviteFixture simulates the Plex server and plex.tv for invitation
// sharing. No real service is contacted.
type plexInviteFixture struct {
	mu       sync.Mutex
	mode     string // new, accepted, pending, sent
	failPost bool   // the POST is lost: plex.tv may or may not have received it
	recorded bool   // whether plex.tv recorded the lost POST
	posts    []map[string]any
	puts     []string
	putBody  []map[string]any
}

func (f *plexInviteFixture) client(t *testing.T) *http.Client {
	return &http.Client{Transport: providerTransport(func(r *http.Request) (*http.Response, error) {
		f.mu.Lock()
		defer f.mu.Unlock()
		target := r.URL.Host + r.URL.Path
		respond := func(body string) (*http.Response, error) {
			return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(body)), Request: r}, nil
		}
		decode := func() map[string]any {
			var body map[string]any
			raw, _ := io.ReadAll(r.Body)
			if err := json.Unmarshal(raw, &body); err != nil {
				t.Error("invalid share body", string(raw))
			}
			return body
		}
		switch {
		case r.Method == "POST" && target == "plex.tv/api/servers/fixture-machine/shared_servers":
			f.posts = append(f.posts, decode())
			if f.failPost {
				if f.recorded {
					f.mode = "pending-invite" // plex.tv received it; only the response was lost
				}
				return nil, errors.New("connection reset after send")
			}
			f.mode = "pending-invite"
			return respond(`<MediaContainer/>`)
		case r.Method == "PUT" && target == "plex.tv/api/servers/fixture-machine/shared_servers/700":
			f.puts = append(f.puts, target)
			f.putBody = append(f.putBody, decode())
			return respond(`<MediaContainer/>`)
		case r.Method != "GET":
			t.Error("unexpected Plex mutation", r.Method, target)
			return nil, errors.New("unexpected mutation")
		}
		switch target {
		case "fixture.invalid/":
			return respond(`<MediaContainer machineIdentifier="fixture-machine"/>`)
		case "fixture.invalid/library/sections":
			return respond(`<MediaContainer><Directory key="1"/><Directory key="2"/></MediaContainer>`)
		case "plex.tv/api/servers/fixture-machine":
			return respond(`<MediaContainer><Server machineIdentifier="fixture-machine"><Section id="1001" key="1"/><Section id="1002" key="2"/></Server></MediaContainer>`)
		case "plex.tv/api/users/":
			switch f.mode {
			case "accepted":
				return respond(`<MediaContainer><User id="2" allowSync="0"><Server id="700" machineIdentifier="fixture-machine" pending="0" owned="1"/></User></MediaContainer>`)
			case "pending":
				return respond(`<MediaContainer><User id="2" allowSync="0"><Server id="700" machineIdentifier="fixture-machine" pending="1" owned="1"/></User></MediaContainer>`)
			case "friend":
				// Still a friend after leaving this server; shares another one.
				return respond(`<MediaContainer><User id="2" allowSync="0"><Server id="900" machineIdentifier="other-machine" pending="0" owned="0"/></User></MediaContainer>`)
			}
			return respond(`<MediaContainer/>`)
		case "plex.tv/api/servers/fixture-machine/shared_servers":
			if f.mode == "accepted" || f.mode == "pending" {
				return respond(`<MediaContainer><SharedServer id="700" userID="2" allLibraries="0"><Section key="1" shared="1"/><Section key="2" shared="0"/></SharedServer></MediaContainer>`)
			}
			return respond(`<MediaContainer/>`)
		case "plex.tv/api/invites/requested":
			if f.mode == "sent" || f.mode == "pending-invite" {
				return respond(`<MediaContainer size="1"><Invite id="2" friend="0" home="0" server="1"><Server machineIdentifier="fixture-machine"/></Invite></MediaContainer>`)
			}
			return respond(`<MediaContainer size="0"/>`)
		}
		t.Error("unexpected Plex request", r.Method, target)
		return nil, errors.New("unexpected request")
	})}
}

// plexInviteSetup returns an invitation for the Plex server (libraries 1 and 2
// known) whose invitee has signed in with Plex as account 2 ("reader").
func plexInviteSetup(t *testing.T, mode string, grant string) (*App, *Store, string, string, *http.Cookie, int64, *plexInviteFixture) {
	t.Helper()
	// The invitee signs in after the invitation is final: the sign-in is bound
	// to the invitation's grants.
	a, s := testApp(t)
	admin, _ := bootstrapOwner(t, a)
	a.ProviderHTTP = newPlexAuthFixture(t, "").client
	token, invite, server := seedPlexProofInvitation(t, a, admin)
	activityExec(t, s, "INSERT INTO media_libraries(server_id,external_id,name) VALUES(?,'1','Movies'),(?,'2','TV Shows')", server, server)
	if grant == "" {
		grant = `all_libraries=0,library_ids='["1"]'`
	}
	activityExec(t, s, "UPDATE invitation_grants SET "+grant+" WHERE invite_id=?", invite)
	proof, cookie := startInvitationProof(t, a, token)
	confirmInvitationProof(t, a, token, proof, cookie)
	f := &plexInviteFixture{mode: mode}
	a.ProviderHTTP = f.client(t)
	return a, s, token, proof, cookie, server, f
}

func redeemPlexInvite(t *testing.T, a *App, token, proof string, cookie *http.Cookie, name string) map[string]any {
	t.Helper()
	w := apiRequest(a, "POST", "/api/public/invitations/"+token+"/redeem", "", plexReservationBody(proof, name, newUUID()), cookie)
	if w.Code != 201 {
		t.Fatal(w.Code, w.Body.String())
	}
	return responseData(t, w)
}

func plexAccountState(t *testing.T, s *Store, server int64) (owner string, active bool, username string, libraries string) {
	t.Helper()
	if err := s.reader.QueryRow(`SELECT coalesce((SELECT u.local_username FROM service_links l JOIN user_accounts u ON u.uuid=l.user_uuid WHERE l.service_uuid=a.uuid AND l.link_kind='owner'),''),a.is_active,a.external_username,a.allowed_library_ids FROM service_accounts a WHERE a.server_id=? AND a.external_user_id='2'`, server).Scan(&owner, &active, &username, &libraries); err != nil {
		t.Fatal(err)
	}
	return
}

// Flask's inviteFriend: a Plex user who is not a friend gets an invitation for
// the selected libraries; the share is pending until they accept in Plex.
func TestPlexInvitationInvitesNewPlexUser(t *testing.T) {
	a, s, token, proof, cookie, server, f := plexInviteSetup(t, "new", "")
	receipt := redeemPlexInvite(t, a, token, proof, cookie, "new-reader")
	if receipt["status"] != "completed" {
		t.Fatal(receipt)
	}
	if len(f.posts) != 1 || len(f.puts) != 0 {
		t.Fatal("expected exactly one invitation", f.posts, f.puts)
	}
	share := f.posts[0]["shared_server"].(map[string]any)
	settings := f.posts[0]["sharing_settings"].(map[string]any)
	ids, _ := json.Marshal(share["library_section_ids"])
	if f.posts[0]["server_id"] != "fixture-machine" || share["invited_email"] != "reader" || string(ids) != "[1001]" || settings["allowSync"] != "0" {
		t.Fatal("invitation body", f.posts[0])
	}
	owner, active, username, libraries := plexAccountState(t, s, server)
	if owner != "new-reader" || active || username != "reader" || libraries != `["1"]` {
		t.Fatal("pending Plex account should be recorded inactive and owned by the new user", owner, active, username, libraries)
	}
	var userActive bool
	var uses int
	var proofStatus string
	s.reader.QueryRow("SELECT is_active FROM user_accounts WHERE local_username='new-reader'").Scan(&userActive)
	s.reader.QueryRow("SELECT current_uses FROM invites WHERE token=?", tokenHash(token)).Scan(&uses)
	s.reader.QueryRow("SELECT status FROM plex_invitation_authorizations WHERE id=?", proof).Scan(&proofStatus)
	if !userActive || uses != 1 || proofStatus != "consumed" {
		t.Fatal("redemption not completed", userActive, uses, proofStatus)
	}
	// The sign-in is single use.
	w := apiRequest(a, "POST", "/api/public/invitations/"+token+"/redeem", "", plexReservationBody(proof, "second", newUUID()), cookie)
	if w.Code == 201 || len(f.posts) != 1 {
		t.Fatal("consumed Plex sign-in reused", w.Code, w.Body.String())
	}
}

// Flask's updateFriend: an existing share on this server gets the invite's libraries.
func TestPlexInvitationUpdatesExistingFriendShare(t *testing.T) {
	a, s, token, proof, cookie, server, f := plexInviteSetup(t, "accepted", `all_libraries=0,library_ids='["1","2"]'`)
	if receipt := redeemPlexInvite(t, a, token, proof, cookie, "friend-reader"); receipt["status"] != "completed" {
		t.Fatal(receipt)
	}
	if len(f.posts) != 0 || len(f.puts) != 1 {
		t.Fatal("existing friend should be updated, not re-invited", f.posts, f.puts)
	}
	ids, _ := json.Marshal(f.putBody[0]["shared_server"].(map[string]any)["library_section_ids"])
	if string(ids) != "[1001,1002]" {
		t.Fatal("updated libraries", string(ids))
	}
	if owner, active, _, _ := plexAccountState(t, s, server); owner != "friend-reader" || !active {
		t.Fatal("accepted friend should be active and linked", owner, active)
	}
}

// An invitation already waiting in Plex is not sent again.
func TestPlexInvitationAlreadyInvitedIsNotResent(t *testing.T) {
	a, s, token, proof, cookie, server, f := plexInviteSetup(t, "sent", "")
	if receipt := redeemPlexInvite(t, a, token, proof, cookie, "sent-reader"); receipt["status"] != "completed" {
		t.Fatal(receipt)
	}
	if len(f.posts) != 0 || len(f.puts) != 0 {
		t.Fatal("pending invitation resent", f.posts, f.puts)
	}
	if owner, active, _, _ := plexAccountState(t, s, server); owner != "sent-reader" || active {
		t.Fatal("pending invitation should be recorded inactive", owner, active)
	}
}

// All libraries and downloads follow Flask's inviteFriend parameters.
func TestPlexInvitationAllLibrariesWithDownloads(t *testing.T) {
	a, _, token, proof, cookie, _, f := plexInviteSetup(t, "new", `all_libraries=1,library_ids='[]',allow_downloads=1`)
	redeemPlexInvite(t, a, token, proof, cookie, "all-reader")
	if len(f.posts) != 1 {
		t.Fatal(f.posts)
	}
	ids, _ := json.Marshal(f.posts[0]["shared_server"].(map[string]any)["library_section_ids"])
	if string(ids) != "[1001,1002]" || f.posts[0]["sharing_settings"].(map[string]any)["allowSync"] != "1" {
		t.Fatal("all libraries with downloads", f.posts[0])
	}
}

// A lost response is resolved by reading Plex's sent invitations, never by
// sending again.
func TestPlexInvitationUncertainSendIsResolvedNotRetried(t *testing.T) {
	for _, recorded := range []bool{true, false} {
		a, s, token, proof, cookie, server, f := plexInviteSetup(t, "new", "")
		f.failPost, f.recorded = true, recorded
		receipt := redeemPlexInvite(t, a, token, proof, cookie, "lost-reader")
		if len(f.posts) != 1 {
			t.Fatal("uncertain send retried", len(f.posts))
		}
		if recorded {
			if receipt["status"] != "completed" {
				t.Fatal("recorded invitation should complete", receipt)
			}
			if owner, _, _, _ := plexAccountState(t, s, server); owner != "lost-reader" {
				t.Fatal("owner", owner)
			}
			continue
		}
		if receipt["status"] != "failed" || receipt["requires_review"] != true {
			t.Fatal("unconfirmed invitation must not be reported as successful", receipt)
		}
		var accounts int
		s.reader.QueryRow("SELECT count(*) FROM service_accounts WHERE server_id=?", server).Scan(&accounts)
		if accounts != 0 {
			t.Fatal("unconfirmed invitation recorded an account")
		}
	}
}

func TestPlexInvitationRequiresPlexSignIn(t *testing.T) {
	a, s, token, _, _, _, f := plexInviteSetup(t, "new", "")
	w := apiRequest(a, "POST", "/api/public/invitations/"+token+"/redeem", "", redeemBody("no-plex", newUUID()), nil)
	if w.Code != 400 || !strings.Contains(w.Body.String(), "PLEX_AUTH_REQUIRED") || len(f.posts) != 0 {
		t.Fatal(w.Code, w.Body.String())
	}
	var jobs int
	s.reader.QueryRow("SELECT count(*) FROM provisioning_jobs").Scan(&jobs)
	if jobs != 0 {
		t.Fatal("job reserved without Plex sign-in")
	}
}

// The account a different MUM user already owns is never taken over.
func TestPlexInvitationNeverTakesOverOwnedAccount(t *testing.T) {
	a, s, token, proof, cookie, server, _ := plexInviteSetup(t, "accepted", "")
	var owner struct{ UUID string }
	if err := s.reader.QueryRow("SELECT uuid FROM user_accounts ORDER BY created_at LIMIT 1").Scan(&owner.UUID); err != nil {
		t.Fatal(err)
	}
	activityExec(t, s, "INSERT INTO identities(uuid,kind) VALUES('owned-service','service')")
	activityExec(t, s, `INSERT INTO service_accounts(uuid,server_id,external_user_id,external_username,service_settings,is_active,created_at,updated_at) VALUES('owned-service',?,'2','reader','{}',1,?,?)`, server, utcTimestamp(time.Now()), utcTimestamp(time.Now()))
	activityExec(t, s, "INSERT INTO service_links(user_uuid,service_uuid,link_kind,created_at) VALUES(?,'owned-service','owner',?)", owner.UUID, utcTimestamp(time.Now()))
	w := apiRequest(a, "POST", "/api/public/invitations/"+token+"/redeem", "", plexReservationBody(proof, "takeover", newUUID()), cookie)
	if w.Code == 201 && responseData(t, w)["status"] == "completed" {
		t.Fatal("owned Plex account was taken over")
	}
	var linked string
	s.reader.QueryRow("SELECT user_uuid FROM service_links WHERE service_uuid='owned-service'").Scan(&linked)
	if linked != owner.UUID {
		t.Fatal("ownership changed", linked)
	}
}

func TestPlexAdvertisesInvitationsAndAllowsPlexInvites(t *testing.T) {
	a, _ := testApp(t)
	admin, _ := bootstrapOwner(t, a)
	w := apiRequest(a, "GET", "/api/providers", admin, nil, nil)
	if w.Code != 200 {
		t.Fatal(w.Code)
	}
	var page struct {
		Data []struct {
			ID           string   `json:"id"`
			Capabilities []string `json:"capabilities"`
		} `json:"data"`
	}
	json.Unmarshal(w.Body.Bytes(), &page)
	found := false
	for _, p := range page.Data {
		if p.ID == "plex" {
			found = strings.Contains(strings.Join(p.Capabilities, ","), "invitations.redeem")
		}
	}
	if !found {
		t.Fatal("Plex does not advertise invitations.redeem")
	}
	server := createManagedServer(t, a, admin, "plex", "http://fixture.invalid")
	if w := apiRequest(a, "POST", "/api/invitations", admin, map[string]any{"expires_at": time.Now().Add(time.Hour).UTC().Format(time.RFC3339), "max_uses": 1, "grants": []InvitationGrant{{ServerID: server, AllLibraries: true}}}, nil); w.Code != 201 {
		t.Fatal("Plex invitation creation rejected", w.Code, w.Body.String())
	}
}

// A friend who left the server (still in the friends list, no share of this
// server) is re-added by account ID, as plexapi's updateFriend does; the
// email-style invitation is only for people who are not friends.
func TestPlexInvitationReAddsFriendWhoLeftTheServer(t *testing.T) {
	a, s, token, proof, cookie, server, f := plexInviteSetup(t, "friend", "")
	if receipt := redeemPlexInvite(t, a, token, proof, cookie, "returning-reader"); receipt["status"] != "completed" {
		t.Fatal(receipt)
	}
	if len(f.posts) != 1 || len(f.puts) != 0 {
		t.Fatal(f.posts, f.puts)
	}
	share := f.posts[0]["shared_server"].(map[string]any)
	if share["invited_id"] != float64(2) || share["invited_email"] != nil || f.posts[0]["sharing_settings"] != nil {
		t.Fatal("friend should be re-added by account ID", f.posts[0])
	}
	if owner, _, _, _ := plexAccountState(t, s, server); owner != "returning-reader" {
		t.Fatal("owner", owner)
	}
}
