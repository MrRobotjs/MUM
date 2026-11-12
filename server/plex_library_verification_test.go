package main

import (
	"database/sql"
	"io"
	"net/http"
	"strings"
	"testing"
)

func plexVerificationFixture(t *testing.T, change func(*Store, string, int64)) (*App, *Store, string, int64) {
	t.Helper()
	a, s, job, server, f := selectedPlexCheckpointFixture(t)
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
	original := f.client.Transport
	a.ProviderHTTP = &http.Client{Transport: providerTransport(func(r *http.Request) (*http.Response, error) {
		body := ""
		switch r.URL.Host + r.URL.Path {
		case "fixture.invalid/":
			body = `<MediaContainer machineIdentifier="fixture-machine"/>`
		case "fixture.invalid/library/sections":
			body = `<MediaContainer><Directory key="1"/></MediaContainer>`
			if r.Header.Get("X-Plex-Token") == "recipient-resource-secret" && change != nil {
				change(s, job, server)
			}
		case "plex.tv/api/servers/fixture-machine":
			body = `<MediaContainer><Server machineIdentifier="fixture-machine"><Section id="1001" key="1"/></Server></MediaContainer>`
		case "plex.tv/api/users/":
			body = `<MediaContainer><User id="2" allowSync="0"><Server id="700" machineIdentifier="fixture-machine" pending="0" owned="0"/></User></MediaContainer>`
		case "plex.tv/api/servers/fixture-machine/shared_servers":
			body = `<MediaContainer><SharedServer id="700" userID="2" allLibraries="0"><Section key="1" shared="1"/></SharedServer></MediaContainer>`
		case "clients.plex.tv/api/v2/resources":
			body = `[{"clientIdentifier":"fixture-machine","owned":false,"provides":"server","accessToken":"recipient-resource-secret"}]`
		default:
			return original.RoundTrip(r)
		}
		if r.Method != "GET" {
			t.Error("library verifier performed sharing mutation")
		}
		return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(body)), Request: r}, nil
	})}
	return a, s, job, server
}
func TestPlexLibraryVerificationPersistsFreshProvenanceWithoutCompleting(t *testing.T) {
	a, s, job, server := plexVerificationFixture(t, nil)
	p := readPlexCheckpoint(t, s, job, server)
	if err := a.verifyPlexLibraryCompletion(t.Context(), job, server, p.Revision); err != nil {
		t.Fatal(err)
	}
	p = readPlexCheckpoint(t, s, job, server)
	if err := s.write(t.Context(), func(tx *sql.Tx) error {
		return validatePlexCompletionEvidence(t.Context(), tx, job, server, p.Revision)
	}); err != nil {
		t.Fatal(err)
	}
	var scope string
	var evidenceRev int64
	if err := s.reader.QueryRow("SELECT scope,checkpoint_revision FROM plex_library_verifications WHERE job_id=?", job).Scan(&scope, &evidenceRev); err != nil || scope != plexLibraryVerificationScope || evidenceRev != p.Revision {
		t.Fatal(scope, err)
	}
	receipt, err := a.loadRedemption(t.Context(), job)
	if err != nil {
		t.Fatal(err)
	}
	if receipt.Status != "running" || !receipt.Reserved || receipt.Plex.CompletionAvailable || receipt.Steps[0].Plex.AccessVerified {
		t.Fatal("evidence promoted to completion", receipt)
	}
	var user string
	var invite int64
	if err := s.reader.QueryRow("SELECT user_uuid,invite_id FROM provisioning_jobs WHERE id=?", job).Scan(&user, &invite); err != nil {
		t.Fatal(err)
	}
	if _, err := s.writer.Exec("UPDATE provisioning_steps SET status='completed',stage='completed' WHERE job_id=?", job); err != nil {
		t.Fatal(err)
	}
	if err := a.completeRedemption(t.Context(), job, user, invite, map[int64]ManagedServer{}); err == nil {
		t.Fatal("generic completion bypassed explicit future finalizer")
	}
}
func TestPlexLibraryVerificationRechecksAuthorityAfterRecipientHTTP(t *testing.T) {
	for _, mode := range []string{"invite-revoked", "server-revision", "credential-revision", "job-revision", "profile-active", "reservation-release", "grant-change", "step-change"} {
		t.Run(mode, func(t *testing.T) {
			a, s, job, server := plexVerificationFixture(t, func(s *Store, job string, server int64) {
				var err error
				switch mode {
				case "invite-revoked":
					_, err = s.writer.Exec("UPDATE invites SET is_active=0 WHERE id=(SELECT invite_id FROM provisioning_jobs WHERE id=?)", job)
				case "server-revision":
					_, err = s.writer.Exec("UPDATE media_servers SET revision=revision+1 WHERE id=?", server)
				case "credential-revision":
					_, err = s.writer.Exec("UPDATE plex_invitation_credentials SET revision=revision+1 WHERE job_id=?", job)
				case "job-revision":
					_, err = s.writer.Exec("UPDATE provisioning_jobs SET revision=revision+1 WHERE id=?", job)
				case "profile-active":
					_, err = s.writer.Exec("UPDATE user_accounts SET is_active=1 WHERE uuid=(SELECT user_uuid FROM provisioning_jobs WHERE id=?)", job)
				case "reservation-release":
					_, err = s.writer.Exec("UPDATE provisioning_jobs SET reservation_held=0 WHERE id=?", job)
				case "step-change":
					grant := InvitationGrant{ServerID: server, LibraryIDs: []string{"2"}}
					_, err = s.writer.Exec("UPDATE provisioning_steps SET grant_snapshot=? WHERE job_id=?", canonicalPlexInvitationGrant(grant), job)
				case "grant-change":
					_, err = s.writer.Exec(`UPDATE invitation_grants SET library_ids='["2"]' WHERE invite_id=(SELECT invite_id FROM provisioning_jobs WHERE id=?)`, job)
				}
				if err != nil {
					t.Error(err)
				}
			})
			p := readPlexCheckpoint(t, s, job, server)
			if err := a.verifyPlexLibraryCompletion(t.Context(), job, server, p.Revision); err == nil {
				t.Fatal("stale evidence recorded")
			}
			var count int
			if err := s.reader.QueryRow("SELECT count(*) FROM plex_library_verifications WHERE job_id=?", job).Scan(&count); err != nil || count != 0 {
				t.Fatal("partial evidence persisted", err, count)
			}
			if after := readPlexCheckpoint(t, s, job, server); after.Revision != p.Revision+1 || after.token == "" {
				t.Fatal("failed transaction consumed observation lease", after)
			}
		})
	}
}
func TestPlexLibraryCompletionGateRejectsExpiredAndChangedEvidence(t *testing.T) {
	for _, mode := range []string{"expired", "future", "checkpoint", "credential", "job", "provider", "grant", "scope-revoked"} {
		t.Run(mode, func(t *testing.T) {
			a, s, job, server := plexVerificationFixture(t, nil)
			p := readPlexCheckpoint(t, s, job, server)
			if err := a.verifyPlexLibraryCompletion(t.Context(), job, server, p.Revision); err != nil {
				t.Fatal(err)
			}
			p = readPlexCheckpoint(t, s, job, server)
			var err error
			switch mode {
			case "expired":
				_, err = s.writer.Exec("UPDATE plex_library_verifications SET valid_until='2000-01-01T00:00:00.000Z' WHERE job_id=?", job)
			case "future":
				_, err = s.writer.Exec("UPDATE plex_library_verifications SET verified_at='2999-01-01T00:00:00.000Z' WHERE job_id=?", job)
			case "checkpoint":
				_, err = s.writer.Exec("UPDATE plex_share_checkpoints SET revision=revision+1 WHERE job_id=?", job)
			case "credential":
				_, err = s.writer.Exec("UPDATE plex_invitation_credentials SET revision=revision+1 WHERE job_id=?", job)
			case "job":
				_, err = s.writer.Exec("UPDATE provisioning_jobs SET revision=revision+1 WHERE id=?", job)
			case "provider":
				_, err = s.writer.Exec("UPDATE media_servers SET api_key='changed' WHERE id=?", server)
			case "grant":
				_, err = s.writer.Exec("UPDATE plex_library_verifications SET grant_digest='wrong' WHERE job_id=?", job)
			case "scope-revoked":
				_, err = s.writer.Exec("UPDATE invites SET is_active=0 WHERE id=(SELECT invite_id FROM provisioning_jobs WHERE id=?)", job)
			}
			if err != nil {
				t.Fatal(err)
			}
			if err := s.write(t.Context(), func(tx *sql.Tx) error {
				return validatePlexCompletionEvidence(t.Context(), tx, job, server, p.Revision)
			}); err == nil {
				t.Fatal("stale completion gate accepted")
			}
		})
	}
}
