package main

import (
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"
)

func TestPlexPendingSelectedCancellationRequiresExactSentShareProof(t *testing.T) {
	for _, mode := range []string{"valid", "lost-response", "missing-id", "wrong-id", "owned", "not-pending", "missing-flag", "home", "friend", "still-pending"} {
		t.Run(mode, func(t *testing.T) {
			a, s, job, server, _ := selectedPlexCheckpointFixture(t)
			plan := checkpointPlan()
			plan.DownloadsKnown = true
			claim, err := s.claimPlexShare(t.Context(), job, server, 1, "send", plan)
			if err != nil {
				t.Fatal(err)
			}
			observation := plan
			observation.State = "pending"
			observation.ShareID = "700"
			observation.LibraryIDs = []string{"1"}
			if err := s.recordPlexShareObservation(t.Context(), claim, observation); err != nil {
				t.Fatal(err)
			}
			removed := false
			deletes := 0
			a.ProviderHTTP = &http.Client{Transport: providerTransport(func(r *http.Request) (*http.Response, error) {
				if r.URL.RawQuery != "" || r.Header.Get("X-Plex-Token") != "fixture-secret" {
					t.Error("unsafe pending credentials")
				}
				if r.Method == "DELETE" {
					if r.URL.String() != "https://plex.tv/api/servers/fixture-machine/shared_servers/700" {
						t.Error("pending cancel used broad/account route", r.URL)
					}
					body, err := io.ReadAll(r.Body)
					if err != nil || strings.Contains(string(body), "sharing_settings") || !strings.Contains(string(body), `"library_section_ids":[1001]`) {
						t.Error("pending cancellation altered unrelated settings", err)
					}
					if p := readPlexCheckpoint(t, s, job, server); p.State != "cancel_uncertain" || p.token == "" {
						t.Error("pending DELETE lacked durable intent")
					}
					deletes++
					removed = true
					if mode == "lost-response" {
						return nil, errors.New("private lost pending DELETE response")
					}
					return &http.Response{StatusCode: 204, Header: make(http.Header), Body: io.NopCloser(strings.NewReader("")), Request: r}, nil
				}
				if r.Method != "GET" {
					t.Error("unexpected pending mutation")
				}
				body := ""
				switch r.URL.Host + r.URL.Path {
				case "fixture.invalid/":
					body = `<MediaContainer machineIdentifier="fixture-machine"/>`
				case "fixture.invalid/library/sections":
					body = `<MediaContainer><Directory key="1"/></MediaContainer>`
				case "plex.tv/api/servers/fixture-machine":
					body = `<MediaContainer><Server machineIdentifier="fixture-machine"><Section id="1001" key="1"/></Server></MediaContainer>`
				case "plex.tv/api/users/":
					target := `<Server id="700" machineIdentifier="fixture-machine" pending="1" owned="0"/>`
					if removed {
						target = ""
					}
					body = `<MediaContainer size="1"><User id="2" allowSync="0">` + target + `<Server id="701" machineIdentifier="other-machine" pending="1" owned="0"/></User></MediaContainer>`
				case "plex.tv/api/servers/fixture-machine/shared_servers":
					body = `<MediaContainer size="1"><SharedServer id="700" userID="2" allLibraries="0"><Section key="1" shared="1"/></SharedServer></MediaContainer>`
					if removed {
						body = `<MediaContainer size="0"/>`
					}
				case "plex.tv/api/invites/requested":
					target := `<Server id="700" machineIdentifier="fixture-machine" pending="1" owned="0"/>`
					switch mode {
					case "missing-id":
						target = strings.ReplaceAll(target, `id="700"`, ``)
					case "wrong-id":
						target = strings.ReplaceAll(target, `id="700"`, `id="702"`)
					case "owned":
						target = strings.ReplaceAll(target, `owned="0"`, `owned="1"`)
					case "not-pending":
						target = strings.ReplaceAll(target, `pending="1"`, `pending="0"`)
					case "missing-flag":
						target = strings.ReplaceAll(target, `pending="1"`, ``)
					}
					if removed && mode != "still-pending" {
						target = ""
					}
					body = `<MediaContainer size="1"><Invite id="2" friend="0" home="0" server="1">` + target + `<Server id="701" machineIdentifier="other-machine" pending="1" owned="0"/></Invite></MediaContainer>`
					if mode == "home" {
						body = strings.ReplaceAll(body, `home="0"`, `home="1"`)
					}
					if mode == "friend" {
						body = strings.ReplaceAll(body, `friend="0"`, `friend="1"`)
					}
				default:
					t.Error("unexpected pending URL", r.URL)
					return nil, errors.New("unexpected fixture target")
				}
				return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(body)), Request: r}, nil
			})}
			row := readPlexCheckpoint(t, s, job, server)
			if row.State != "awaiting_acceptance" {
				t.Fatal("pending grant was promoted")
			}
			err = a.cancelPlexSelectedShare(t.Context(), job, server, row.Revision, false)
			success := mode == "valid"
			attempted := success || mode == "lost-response" || mode == "still-pending"
			if (err == nil) != success {
				t.Fatal(mode, err)
			}
			want := 0
			if attempted {
				want = 1
			}
			if deletes != want {
				t.Fatal("unsafe pending DELETE count", deletes, want)
			}
			row = readPlexCheckpoint(t, s, job, server)
			expected := "awaiting_acceptance"
			if attempted {
				expected = "cancel_uncertain"
			}
			if success {
				expected = "cancelled"
			}
			if row.State != expected {
				t.Fatal(row.State, expected)
			}
			var held, active bool
			var uses int
			if err := s.reader.QueryRow("SELECT j.reservation_held,u.is_active,i.current_uses FROM provisioning_jobs j JOIN user_accounts u ON u.uuid=j.user_uuid JOIN invites i ON i.id=j.invite_id WHERE j.id=?", job).Scan(&held, &active, &uses); err != nil || !held || active || uses != 0 {
				t.Fatal("pending cancellation completed/released whole job", err)
			}
			if mode == "lost-response" {
				if err := a.recoverProvisioning(t.Context()); err != nil {
					t.Fatal(err)
				}
				row = readPlexCheckpoint(t, s, job, server)
				if err := a.cancelPlexSelectedShare(t.Context(), job, server, row.Revision, true); err != nil {
					t.Fatal(err)
				}
				if row = readPlexCheckpoint(t, s, job, server); row.State != "cancelled" || deletes != 1 {
					t.Fatal("pending cleanup replayed DELETE")
				}
			}
		})
	}
}
