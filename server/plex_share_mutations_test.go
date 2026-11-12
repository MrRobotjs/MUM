package main

import (
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func selectedPlexCheckpointFixture(t *testing.T) (*App, *Store, string, int64, *plexAuthFixture) {
	t.Helper()
	a, s := testApp(t)
	admin, _ := bootstrapOwner(t, a)
	f := newPlexAuthFixture(t, "")
	a.ProviderHTTP = f.client
	token, invite, server := seedPlexProofInvitation(t, a, admin)
	if _, err := s.writer.Exec("INSERT INTO media_libraries(server_id,external_id,name) VALUES(?,'1','Movies')", server); err != nil {
		t.Fatal(err)
	}
	if _, err := s.writer.Exec(`UPDATE invitation_grants SET all_libraries=0,library_ids='["1"]' WHERE invite_id=?`, invite); err != nil {
		t.Fatal(err)
	}
	id, cookie := startInvitationProof(t, a, token)
	confirmInvitationProof(t, a, token, id, cookie)
	job, user := newUUID(), newUUID()
	prepared, err := a.preparePlexInvitationProof(t.Context(), token, id, cookie.Value, job, user)
	if err != nil {
		t.Fatal(err)
	}
	err = s.write(t.Context(), func(tx *sql.Tx) error {
		scope, err := loadPlexInvitationScope(t.Context(), tx, tokenHash(token), 1, "")
		if err != nil {
			return err
		}
		if err := seedPlexProofReservation(t.Context(), tx, scope, job, user); err != nil {
			return err
		}
		return consumePlexInvitationProof(t.Context(), tx, prepared)
	})
	if err != nil {
		t.Fatal(err)
	}
	return a, s, job, server, f
}
func TestPlexSelectedSendWorkerUsesDurableIntentAndPreservesSettings(t *testing.T) {
	for _, mode := range []string{"pending", "sent-only", "lost-response", "preexisting-invite", "downloads-mismatch", "new-friend", "revoked-during-refresh", "changed-mapping", "post-incomplete", "stale-provider"} {
		t.Run(mode, func(t *testing.T) {
			a, s, job, server, f := selectedPlexCheckpointFixture(t)
			original := f.client.Transport
			posts := 0
			var mappingChanged atomic.Bool
			f.mu.Lock()
			if mode == "revoked-during-refresh" {
				f.beforeAccount = func() {
					if _, err := s.writer.Exec("UPDATE invites SET is_active=0 WHERE id=(SELECT invite_id FROM provisioning_jobs WHERE id=?)", job); err != nil {
						t.Error(err)
					}
				}
			}
			if mode == "changed-mapping" {
				f.beforeAccount = func() { mappingChanged.Store(true) }
			}
			f.mu.Unlock()
			a.ProviderHTTP = &http.Client{Transport: providerTransport(func(r *http.Request) (*http.Response, error) {
				if r.Method == "POST" && r.URL.Host == "plex.tv" && strings.HasSuffix(r.URL.Path, "/shared_servers") {
					posts++
					if r.URL.Path != "/api/servers/fixture-machine/shared_servers" || r.URL.RawQuery != "" || r.Header.Get("X-Plex-Token") != "fixture-secret" {
						t.Error("share target/credentials")
					}
					var body map[string]json.RawMessage
					if json.NewDecoder(r.Body).Decode(&body) != nil || len(body) != 2 || string(body["server_id"]) != `"fixture-machine"` {
						t.Error("unexpected share body/settings")
					}
					var share struct {
						Libraries []int64 `json:"library_section_ids"`
						Account   int64   `json:"invited_id"`
					}
					if json.Unmarshal(body["shared_server"], &share) != nil || share.Account != 2 || len(share.Libraries) != 1 || share.Libraries[0] != 1001 {
						t.Error("share did not use verified account/cloud section IDs")
					}
					if p := readPlexCheckpoint(t, s, job, server); p.State != "send_uncertain" || p.token == "" {
						t.Error("remote write preceded durable intent")
					}
					if mode == "stale-provider" {
						if _, err := s.writer.Exec("UPDATE media_servers SET revision=revision+1 WHERE id=?", server); err != nil {
							t.Error(err)
						}
					}
					if mode == "lost-response" {
						return nil, errors.New("private-lost-cloud-response")
					}
					return &http.Response{StatusCode: 201, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(`<MediaContainer/>`)), Request: r}, nil
				}
				body := ""
				switch r.URL.Host + r.URL.Path {
				case "fixture.invalid/":
					body = `<MediaContainer machineIdentifier="fixture-machine"/>`
				case "fixture.invalid/library/sections":
					body = `<MediaContainer><Directory key="1"/></MediaContainer>`
				case "plex.tv/api/servers/fixture-machine":
					body = `<MediaContainer><Server machineIdentifier="fixture-machine"><Section id="1001" key="1"/></Server></MediaContainer>`
					if mappingChanged.Load() {
						body = strings.ReplaceAll(body, `1001`, `1002`)
					}
				case "plex.tv/api/users/":
					body = `<MediaContainer><User id="2" allowSync="0"><Server id="701" machineIdentifier="unrelated-server" pending="0" owned="0"/>`
					if posts > 0 && mode != "sent-only" {
						body += `<Server id="700" machineIdentifier="fixture-machine" pending="1" owned="1"/>`
					}
					body += `</User></MediaContainer>`
					if mode == "downloads-mismatch" {
						body = strings.ReplaceAll(body, `allowSync="0"`, `allowSync="1"`)
					}
					if mode == "new-friend" {
						body = `<MediaContainer/>`
					}
				case "plex.tv/api/servers/fixture-machine/shared_servers":
					body = `<MediaContainer/>`
					if posts > 0 && mode != "sent-only" {
						body = `<MediaContainer><SharedServer id="700" userID="2" allLibraries="0"><Section key="1" shared="1"/></SharedServer></MediaContainer>`
					}
					if posts > 0 && mode == "post-incomplete" {
						body = strings.ReplaceAll(body, `allLibraries="0"`, ``)
					}
				case "plex.tv/api/invites/requested":
					body = `<MediaContainer size="0"/>`
					if mode == "preexisting-invite" || posts > 0 && mode == "sent-only" {
						body = `<MediaContainer size="1"><Invite id="2" friend="0" home="0" server="1"><Server machineIdentifier="fixture-machine"/></Invite></MediaContainer>`
					}
				default:
					return original.RoundTrip(r)
				}
				if r.Method != "GET" || r.URL.RawQuery != "" {
					t.Error("unexpected mutation/query during sharing preflight")
				}
				return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(body)), Request: r}, nil
			})}
			err := a.sendPlexSelectedShare(t.Context(), job, server, 1)
			success := mode == "pending" || mode == "sent-only"
			if (err == nil) != success {
				t.Fatal(mode, err)
			}
			wantPosts := 0
			if success || mode == "lost-response" || mode == "post-incomplete" || mode == "stale-provider" {
				wantPosts = 1
			}
			if posts != wantPosts {
				t.Fatal("unexpected share writes", posts, wantPosts)
			}
			p := readPlexCheckpoint(t, s, job, server)
			if success && p.State != "awaiting_acceptance" {
				t.Fatal(p)
			}
			if !success && posts > 0 && p.State != "send_uncertain" {
				t.Fatal("uncertain write lost checkpoint", p)
			}
			if err := a.sendPlexSelectedShare(t.Context(), job, server, p.Revision); success || posts > 0 {
				if err == nil {
					t.Fatal("mutation replayed")
				}
			}
			if posts != wantPosts {
				t.Fatal("failed/uncertain share automatically retried")
			}
			var active, held bool
			var uses int
			if err := s.reader.QueryRow("SELECT u.is_active,j.reservation_held,i.current_uses FROM provisioning_jobs j JOIN user_accounts u ON u.uuid=j.user_uuid JOIN invites i ON i.id=j.invite_id WHERE j.id=?", job).Scan(&active, &held, &uses); err != nil || active || !held || uses != 0 {
				t.Fatal("share send completed provisioning", err)
			}
		})
	}
}
func TestPlexSentInvitationsRejectIncompleteAndAmbiguousSnapshots(t *testing.T) {
	valid := `<MediaContainer size="1"><Invite id="2" friend="0" home="0" server="1"><Server machineIdentifier="fixture-machine"/></Invite></MediaContainer>`
	cases := []struct{ name, body string }{
		{"valid", valid},
		{"missing-count", strings.ReplaceAll(valid, `size="1"`, ``)},
		{"truncated", strings.ReplaceAll(valid, `size="1"`, `size="2"`)},
		{"paged", strings.ReplaceAll(valid, `size="1"`, `size="1" offset="1"`)},
		{"partial-total", strings.ReplaceAll(valid, `size="1"`, `size="1" totalSize="2"`)},
		{"unknown-policy", strings.ReplaceAll(valid, `friend="0"`, ``)},
		{"missing-account", strings.ReplaceAll(valid, `id="2"`, ``)},
		{"noncanonical-account", strings.ReplaceAll(valid, `id="2"`, `id="02"`)},
		{"duplicate-machine", strings.ReplaceAll(valid, `</Invite>`, `<Server machineIdentifier="fixture-machine"/></Invite>`)},
		{"missing-machine", strings.ReplaceAll(valid, `machineIdentifier="fixture-machine"`, ``)},
		{"contradictory-server", strings.ReplaceAll(valid, `server="1"`, `server="0"`)},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			p, _ := plexShareFixture(t, nil)
			p.client = &http.Client{Transport: providerTransport(func(r *http.Request) (*http.Response, error) {
				if r.URL.String() != "https://plex.tv/api/invites/requested" || r.Method != "GET" {
					t.Error("unsafe invitation read")
				}
				return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(tc.body)), Header: make(http.Header), Request: r}, nil
			})}
			got, err := p.plexSentInvitations(t.Context())
			if (err == nil) != (tc.name == "valid") {
				t.Fatal(err)
			}
			if err == nil && (len(got) != 1 || noPlexSentInviteForAccount(got, "2") || !noPlexSentInviteForAccount(got, "3")) {
				t.Fatal(got)
			}
		})
	}
}

func TestPlexSelectedAdapterRejectsUnsafePlansBeforeMutation(t *testing.T) {
	for _, mode := range []string{"all-libraries", "unknown-downloads", "download-change", "wrong-machine", "wrong-operation", "expired", "noncanonical-account", "changed-section"} {
		t.Run(mode, func(t *testing.T) {
			p, count := plexShareFixture(t, nil)
			plan := checkpointPlan()
			plan.DownloadsKnown = true
			claim := plexShareCheckpoint{Account: "2", Machine: plan.Machine, State: "send_uncertain", Sections: plan.Sections, token: "fixture-lease", operation: "send", expires: utcTimestamp(time.Now().Add(time.Minute)), grant: InvitationGrant{LibraryIDs: []string{"1"}}}
			switch mode {
			case "all-libraries":
				claim.grant = InvitationGrant{AllLibraries: true}
			case "unknown-downloads":
				plan.DownloadsKnown = false
			case "download-change":
				plan.AllowDownloads = true
			case "wrong-machine":
				plan.Machine = "other"
			case "wrong-operation":
				claim.operation = "inspect"
			case "expired":
				claim.expires = utcTimestamp(time.Now().Add(-time.Minute))
			case "noncanonical-account":
				claim.Account = "02"
				plan.Account = "02"
			case "changed-section":
				plan.Sections = []plexShareSection{{"1", "1002"}}
			}
			if err := p.createPlexSelectedShare(t.Context(), claim, plan); err == nil || *count != 0 {
				t.Fatal("unsafe plan reached sharing endpoint", err, *count)
			}
		})
	}
}
