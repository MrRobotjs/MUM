package main

import (
	"app/server/providers/plex"
	"database/sql"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestPlexJobCredentialRefreshPersistsBoundDeviceAndNeverCompletesJob(t *testing.T) {
	a, s, job, server, _ := plexCheckpointFixture(t)
	claim := claimCheckpoint(t, s, readPlexCheckpoint(t, s, job, server), "send")
	var before []byte
	if err := s.reader.QueryRow("SELECT secret FROM plex_invitation_credentials WHERE job_id=?", job).Scan(&before); err != nil {
		t.Fatal(err)
	}
	secret, err := a.refreshPlexJobCredential(t.Context(), claim)
	if err != nil || secret.AccountID != "2" || secret.Token != plexFixtureToken || !secret.Expires.After(time.Now()) || secret.PINCode != "" {
		t.Fatal("refresh failed", err)
	}
	if _, err := json.Marshal(secret); err == nil {
		t.Fatal("credential was serializable")
	}
	var after []byte
	var token string
	if err := s.reader.QueryRow("SELECT secret,coalesce(refresh_token,'') FROM plex_invitation_credentials WHERE job_id=?", job).Scan(&after, &token); err != nil {
		t.Fatal(err)
	}
	if string(before) == string(after) || strings.Contains(string(after), plexFixtureToken) || token != "" {
		t.Fatal("refresh not encrypted/lease retained")
	}
	p := readPlexCheckpoint(t, s, job, server)
	if p.State != "send_uncertain" || p.token != claim.token {
		t.Fatal("refresh changed share outcome")
	}
}
func TestPlexJobCredentialRefreshRejectsChangesDuringHTTP(t *testing.T) {
	for _, mode := range []string{"account-mismatch", "restart", "provider-key", "credential-release", "key-loss"} {
		t.Run(mode, func(t *testing.T) {
			a, s, job, server, f := plexCheckpointFixture(t)
			claim := claimCheckpoint(t, s, readPlexCheckpoint(t, s, job, server), "send")
			f.mu.Lock()
			if mode == "account-mismatch" {
				f.mode = mode
			} else {
				f.beforeAccount = func() {
					var err error
					switch mode {
					case "restart":
						err = a.recoverProvisioning(t.Context())
					case "provider-key":
						_, err = s.writer.Exec("UPDATE media_servers SET api_key='changed' WHERE id=?", server)
					case "credential-release":
						_, err = s.writer.Exec("UPDATE plex_invitation_credentials SET status='released',secret=NULL WHERE job_id=?", job)
					case "key-loss":
						err = os.Remove(filepath.Join(s.dataDir, "plex.key"))
					}
					if err != nil {
						t.Error(err)
					}
				}
			}
			f.mu.Unlock()
			secret, err := a.refreshPlexJobCredential(t.Context(), claim)
			if err == nil || secret.Token != "" {
				t.Fatal("stale refresh returned usable credential")
			}
			var lease string
			if err := s.reader.QueryRow("SELECT coalesce(refresh_token,'') FROM plex_invitation_credentials WHERE job_id=?", job).Scan(&lease); err != nil || lease != "" {
				t.Fatal("refresh lease stuck", err)
			}
		})
	}
}
func TestPlexJobCredentialRefreshLeaseAndShutdownAdmission(t *testing.T) {
	a, s, job, server, _ := plexCheckpointFixture(t)
	claim := claimCheckpoint(t, s, readPlexCheckpoint(t, s, job, server), "send")
	if _, err := s.writer.Exec("UPDATE plex_invitation_credentials SET refresh_token='other-worker',refresh_expires_at='2999-01-01T00:00:00.000Z' WHERE job_id=?", job); err != nil {
		t.Fatal(err)
	}
	if _, err := a.refreshPlexJobCredential(t.Context(), claim); err == nil {
		t.Fatal("concurrent device refresh admitted")
	}
	a.CloseProvisioning()
	if err := a.inspectPlexRecipient(t.Context(), claim); err == nil {
		t.Fatal("shutdown admitted inspection")
	}
}
func TestPlexRecipientResourcesUseDistinctTokenAndExactConfiguredLibraries(t *testing.T) {
	for _, mode := range []string{"valid", "missing-resource", "duplicate-resource", "owned-resource", "missing-owner", "wrong-machine", "missing-library", "extra-library", "duplicate-library", "redirect", "bad-token"} {
		t.Run(mode, func(t *testing.T) {
			f := newPlexAuthFixture(t, "")
			original := f.client.Transport
			localRequests := 0
			expectedClientID := ""
			client := &http.Client{Transport: providerTransport(func(r *http.Request) (*http.Response, error) {
				if r.URL.Path == "/api/v2/resources" {
					if r.URL.Host != "clients.plex.tv" || r.Header.Get("X-Plex-Token") != plexFixtureToken || len(r.URL.Query()) != 3 {
						t.Error("resource credentials/target")
					}
					resource := `{"clientIdentifier":"fixture-machine","owned":false,"provides":"server","accessToken":"recipient-resource-secret","connections":[{"uri":"https://never-follow.invalid"}]}`
					switch mode {
					case "missing-resource":
						resource = ""
					case "duplicate-resource":
						resource += "," + resource
					case "owned-resource":
						resource = strings.ReplaceAll(resource, `false`, `true`)
					case "missing-owner":
						resource = strings.ReplaceAll(resource, `"owned":false,`, ``)
					case "bad-token":
						resource = strings.ReplaceAll(resource, `recipient-resource-secret`, ``)
					}
					return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(strings.NewReader("[" + resource + "]")), Request: r}, nil
				}
				if r.URL.Host == "configured.invalid" {
					localRequests++
					if r.Header.Get("X-Plex-Client-Identifier") != expectedClientID {
						t.Error("recipient PMS device identity changed")
					}
					if r.Header.Get("X-Plex-Token") != "recipient-resource-secret" || r.URL.RawQuery != "" {
						t.Error("PMS used cloud/owner token or query token")
					}
					body := `<MediaContainer machineIdentifier="fixture-machine"/>`
					status := 200
					header := make(http.Header)
					if mode == "redirect" {
						status = 302
						header.Set("Location", "https://never-follow.invalid")
					}
					if mode == "wrong-machine" {
						body = `<MediaContainer machineIdentifier="other"/>`
					}
					if r.URL.Path == "/library/sections" {
						body = `<MediaContainer><Directory key="1"/></MediaContainer>`
						switch mode {
						case "missing-library":
							body = `<MediaContainer/>`
						case "extra-library":
							body = `<MediaContainer><Directory key="1"/><Directory key="2"/></MediaContainer>`
						case "duplicate-library":
							body = `<MediaContainer><Directory key="1"/><Directory key="1"/></MediaContainer>`
						}
					}
					return &http.Response{StatusCode: status, Header: header, Body: io.NopCloser(strings.NewReader(body)), Request: r}, nil
				}
				if r.URL.Host == "never-follow.invalid" {
					t.Fatal("resource URL/redirect followed")
				}
				return original.RoundTrip(r)
			})}
			device, err := plex.NewDevice(client)
			if err != nil {
				t.Fatal(err)
			}
			expectedClientID = device.ClientID
			secret := plexStoredCredential{ClientID: device.ClientID, KeyID: device.KeyID, PrivateKey: device.PrivateKey, AccountID: "2", Token: plexFixtureToken, Expires: time.Now().Add(time.Minute)}
			observed := checkpointPlan()
			observed.State = "accepted"
			observed.ShareID = "700"
			observed.DownloadsKnown = true
			observed.AllLibraries = true
			err = verifyPlexRecipientLibraries(t.Context(), client, secret, "https://configured.invalid", observed, InvitationGrant{AllLibraries: true})
			if (err == nil) != (mode == "valid") {
				t.Fatal("unexpected recipient evidence", mode, err)
			}
			if mode == "valid" && localRequests != 2 {
				t.Fatal("missing identity/library verification")
			}
		})
	}
}
func TestPlexRecipientInspectionFailureRetainsCheckpointAndCapacity(t *testing.T) {
	a, s, job, server, f := plexCheckpointFixture(t)
	claim := claimCheckpoint(t, s, readPlexCheckpoint(t, s, job, server), "send")
	f.mu.Lock()
	f.mode = "account-error"
	f.mu.Unlock()
	if err := a.inspectPlexRecipient(t.Context(), claim); err == nil {
		t.Fatal("failed refresh accepted")
	}
	p := readPlexCheckpoint(t, s, job, server)
	if p.State != "send_uncertain" {
		t.Fatal(p)
	}
	if err := s.write(t.Context(), func(tx *sql.Tx) error { return plexShareJobEligible(t.Context(), tx, p) }); err != nil {
		t.Fatal("failed inspection released capacity/credential", err)
	}
}

func TestPlexRecipientInspectionRefreshesAndRecordsReadEvidenceOnly(t *testing.T) {
	a, s, job, server, f := plexCheckpointFixture(t)
	claim := claimCheckpoint(t, s, readPlexCheckpoint(t, s, job, server), "send")
	original := f.client.Transport
	a.ProviderHTTP = &http.Client{Transport: providerTransport(func(r *http.Request) (*http.Response, error) {
		body := ""
		switch r.URL.Host + r.URL.Path {
		case "fixture.invalid/":
			body = `<MediaContainer machineIdentifier="fixture-machine"/>`
		case "fixture.invalid/library/sections":
			body = `<MediaContainer><Directory key="1"/></MediaContainer>`
		case "plex.tv/api/servers/fixture-machine":
			body = `<MediaContainer><Server machineIdentifier="fixture-machine"><Section key="1" id="1001"/></Server></MediaContainer>`
		case "plex.tv/api/users/":
			body = `<MediaContainer><User id="2" allowSync="0"><Server id="700" machineIdentifier="fixture-machine" pending="0" owned="0"/></User></MediaContainer>`
		case "plex.tv/api/servers/fixture-machine/shared_servers":
			body = `<MediaContainer><SharedServer id="700" userID="2" allLibraries="1"><Section key="1" shared="1"/></SharedServer></MediaContainer>`
		case "clients.plex.tv/api/v2/resources":
			body = `[{"clientIdentifier":"fixture-machine","owned":false,"provides":"server","accessToken":"recipient-resource-secret"}]`
		default:
			return original.RoundTrip(r)
		}
		if r.Method != "GET" {
			t.Fatal("inspection performed sharing mutation")
		}
		if r.URL.Host == "fixture.invalid" {
			token := r.Header.Get("X-Plex-Token")
			if token != "fixture-secret" && token != "recipient-resource-secret" {
				t.Error("incorrect PMS credential")
			}
		} else if r.URL.Path != "/api/v2/resources" && r.Header.Get("X-Plex-Token") != "fixture-secret" {
			t.Error("cloud owner lookup used recipient token")
		}
		return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(body)), Request: r}, nil
	})}
	if err := a.inspectPlexRecipient(t.Context(), claim); err != nil {
		t.Fatal(err)
	}
	p := readPlexCheckpoint(t, s, job, server)
	if p.State != "access_observed" || p.token != "" {
		t.Fatal(p)
	}
	var active bool
	var uses int
	if err := s.reader.QueryRow("SELECT u.is_active,i.current_uses FROM provisioning_jobs j JOIN user_accounts u ON u.uuid=j.user_uuid JOIN invites i ON i.id=j.invite_id WHERE j.id=?", job).Scan(&active, &uses); err != nil || active || uses != 0 {
		t.Fatal("read worker completed provisioning", err)
	}
}
