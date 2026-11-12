package main

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"
)

func TestPlexSelectedRevocationUsesRecordedShareAndCompleteAbsence(t *testing.T) {
	for _, mode := range []string{"valid", "already-absent", "lost-response", "ghost-user", "ghost-share", "new-share-id", "reused-share-id", "pending-target", "truncated-users", "truncated-shares", "missing-count", "stale-provider", "changed-grant", "unrelated-invite"} {
		t.Run(mode, func(t *testing.T) {
			a, s, job, server, _ := selectedPlexCheckpointFixture(t)
			plan := checkpointPlan()
			plan.DownloadsKnown = true
			claim, err := s.claimPlexShare(t.Context(), job, server, 1, "send", plan)
			if err != nil {
				t.Fatal(err)
			}
			observed := plan
			observed.State = "accepted"
			observed.ShareID = "700"
			observed.LibraryIDs = []string{"1"}
			if err := s.recordPlexShareObservation(t.Context(), claim, observed); err != nil {
				t.Fatal(err)
			}
			deleted := mode == "already-absent"
			deletes := 0
			a.ProviderHTTP = &http.Client{Transport: providerTransport(func(r *http.Request) (*http.Response, error) {
				if r.Header.Get("X-Plex-Token") != "fixture-secret" || r.URL.RawQuery != "" {
					t.Error("revocation token must be owner header only")
				}
				if r.Method == "DELETE" {
					deletes++
					if r.URL.String() != "https://plex.tv/api/servers/fixture-machine/shared_servers/700" {
						t.Error("unscoped deletion", r.URL)
					}
					var body map[string]json.RawMessage
					if json.NewDecoder(r.Body).Decode(&body) != nil || len(body) != 2 || string(body["server_id"]) != `"fixture-machine"` {
						t.Error("unexpected revoke body/settings")
					}
					var share map[string][]int64
					if json.Unmarshal(body["shared_server"], &share) != nil || len(share) != 1 || len(share["library_section_ids"]) != 1 || share["library_section_ids"][0] != 1001 {
						t.Error("revoke did not use exact mapped cloud section")
					}
					if p := readPlexCheckpoint(t, s, job, server); p.State != "cancel_uncertain" || p.token == "" {
						t.Error("delete preceded durable intent")
					}
					deleted = true
					if mode == "changed-grant" {
						grant := InvitationGrant{ServerID: server, LibraryIDs: []string{"2"}}
						if _, err := s.writer.Exec("UPDATE provisioning_steps SET grant_snapshot=? WHERE job_id=? AND server_id=?", canonicalPlexInvitationGrant(grant), job, server); err != nil {
							t.Error(err)
						}
					}

					if mode == "stale-provider" {
						if _, err := s.writer.Exec("UPDATE media_servers SET revision=revision+1 WHERE id=?", server); err != nil {
							t.Error(err)
						}
					}
					if mode == "lost-response" {
						return nil, errors.New("private lost DELETE response")
					}
					return &http.Response{StatusCode: 204, Header: make(http.Header), Body: io.NopCloser(strings.NewReader("")), Request: r}, nil
				}
				if r.Method != "GET" {
					t.Error("unexpected revoke method")
				}
				body := ""
				switch r.URL.Host + r.URL.Path {
				case "fixture.invalid/":
					body = `<MediaContainer machineIdentifier="fixture-machine"/>`
				case "fixture.invalid/library/sections":
					body = `<MediaContainer><Directory key="1"/></MediaContainer>`
				case "plex.tv/api/servers/fixture-machine":
					body = `<MediaContainer><Server machineIdentifier="fixture-machine"><Section key="1" id="1001"/></Server></MediaContainer>`
				case "plex.tv/api/users/":
					body = `<MediaContainer size="2"><User id="2" allowSync="0"><Server id="701" machineIdentifier="unrelated-server" pending="0" owned="0"/>`
					if !deleted || mode == "ghost-user" {
						body += `<Server id="700" machineIdentifier="fixture-machine" pending="0" owned="1"/>`
					}
					body += `</User><User id="9"/></MediaContainer>`
					if deleted && mode == "truncated-users" {
						body = strings.ReplaceAll(body, `size="2"`, `size="3"`)
					}
				case "plex.tv/api/servers/fixture-machine/shared_servers":
					other := `<SharedServer id="800" userID="9" allLibraries="0"/>`
					target := `<SharedServer id="700" userID="2" allLibraries="0"><Section key="1" shared="1"/></SharedServer>`
					if !deleted {
						body = `<MediaContainer size="2">` + other + target + `</MediaContainer>`
					} else {
						body = `<MediaContainer size="1">` + other + `</MediaContainer>`
					}
					if deleted && mode == "ghost-share" {
						body = `<MediaContainer size="2">` + other + target + `</MediaContainer>`
					}
					if deleted && mode == "new-share-id" {
						body = `<MediaContainer size="2">` + other + strings.ReplaceAll(target, `id="700"`, `id="702"`) + `</MediaContainer>`
					}
					if deleted && mode == "reused-share-id" {
						body = strings.ReplaceAll(body, `id="800"`, `id="700"`)
					}
					if deleted && mode == "truncated-shares" {
						body = strings.ReplaceAll(body, `size="1"`, `size="2"`)
					}
					if deleted && mode == "missing-count" {
						body = strings.ReplaceAll(body, `size="1"`, ``)
					}
				case "plex.tv/api/invites/requested":
					body = `<MediaContainer size="0"/>`
					if deleted && (mode == "pending-target" || mode == "unrelated-invite") {
						machine := "fixture-machine"
						if mode == "unrelated-invite" {
							machine = "unrelated-server"
						}
						body = `<MediaContainer size="1"><Invite id="2" friend="0" home="0" server="1"><Server machineIdentifier="` + machine + `"/></Invite></MediaContainer>`
					}
				default:
					t.Error("unsafe/unexpected revocation path", r.URL)
					return nil, errors.New("unexpected fixture path")
				}
				return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(body)), Request: r}, nil
			})}
			p := readPlexCheckpoint(t, s, job, server)
			err = a.cancelPlexSelectedShare(t.Context(), job, server, p.Revision, false)
			success := mode == "valid" || mode == "already-absent" || mode == "unrelated-invite"
			if (err == nil) != success {
				t.Fatal(mode, err)
			}
			wantDeletes := 1
			if mode == "already-absent" {
				wantDeletes = 0
			}
			if deletes != wantDeletes {
				t.Fatal("unexpected DELETE count", deletes, wantDeletes)
			}
			p = readPlexCheckpoint(t, s, job, server)
			if success && p.State != "cancelled" {
				t.Fatal("absence did not cancel checkpoint", p)
			}
			if !success && p.State != "cancel_uncertain" {
				t.Fatal("ambiguous cleanup lost uncertainty", p)
			}
			var released, held, active bool
			if err := s.reader.QueryRow("SELECT c.status='released' AND c.secret IS NULL,j.reservation_held,u.is_active FROM plex_invitation_credentials c JOIN provisioning_jobs j ON j.id=c.job_id JOIN user_accounts u ON u.uuid=j.user_uuid WHERE j.id=?", job).Scan(&released, &held, &active); err != nil || released != success || !held || active {
				t.Fatal("cleanup incorrectly released whole job/credential", err)
			}
			if err := a.cancelPlexSelectedShare(t.Context(), job, server, p.Revision, false); err == nil {
				t.Fatal("terminal or uncertain delete repeated")
			}
			if deletes != wantDeletes {
				t.Fatal("DELETE automatically replayed")
			}
			if mode == "lost-response" {
				if err := a.recoverProvisioning(t.Context()); err != nil {
					t.Fatal(err)
				}
				p = readPlexCheckpoint(t, s, job, server)
				if err := a.cancelPlexSelectedShare(t.Context(), job, server, p.Revision, true); err != nil {
					t.Fatal("read-only reconciliation failed", err)
				}
				if p = readPlexCheckpoint(t, s, job, server); p.State != "cancelled" || deletes != 1 {
					t.Fatal("reconciliation replayed delete or lost cancellation", p, deletes)
				}
			}
		})
	}
}

func TestPlexSelectedRevocationRejectsUnsafeMutationAdmission(t *testing.T) {
	for _, mode := range []string{"pending", "all-libraries", "unknown-share", "wrong-share", "wrong-account", "wrong-machine", "expired", "wrong-operation"} {
		t.Run(mode, func(t *testing.T) {
			provider, count := plexShareFixture(t, nil)
			observation := checkpointPlan()
			observation.State = "accepted"
			observation.ShareID = "700"
			observation.DownloadsKnown = true
			observation.LibraryIDs = []string{"1"}
			claim := plexShareCheckpoint{Account: "2", Machine: observation.Machine, Share: "700", State: "cancel_uncertain", Sections: observation.Sections, token: "fixture-operation", operation: "cancel", expires: utcTimestamp(time.Now().Add(time.Minute)), grant: InvitationGrant{LibraryIDs: []string{"1"}}}
			switch mode {
			case "pending":
				observation.State = "pending"
			case "all-libraries":
				claim.grant = InvitationGrant{AllLibraries: true}
				observation.AllLibraries = true
			case "unknown-share":
				claim.Share = ""
			case "wrong-share":
				observation.ShareID = "701"
			case "wrong-account":
				observation.Account = "9"
			case "wrong-machine":
				observation.Machine = "other"
			case "expired":
				claim.expires = utcTimestamp(time.Now().Add(-time.Minute))
			case "wrong-operation":
				claim.operation = "inspect"
			}
			if err := provider.removePlexSelectedSections(t.Context(), claim, observation, plexPendingShareProof{}); err == nil || *count != 0 {
				t.Fatal("unsafe revoke reached remote endpoint", err, *count)
			}
		})
	}
}
