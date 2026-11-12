package main

import (
	"database/sql"
	"sync"
	"testing"
	"testing/fstest"
)

func plexCheckpointFixture(t *testing.T) (*App, *Store, string, int64, *plexAuthFixture) {
	t.Helper()
	a, s := testApp(t)
	admin, _ := bootstrapOwner(t, a)
	f := newPlexAuthFixture(t, "")
	a.ProviderHTTP = f.client
	token, _, server := seedPlexProofInvitation(t, a, admin)
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
func readPlexCheckpoint(t *testing.T, s *Store, job string, server int64) plexShareCheckpoint {
	t.Helper()
	var p plexShareCheckpoint
	err := s.write(t.Context(), func(tx *sql.Tx) error {
		var err error
		p, err = loadPlexShareCheckpoint(t.Context(), tx, job, server)
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	return p
}
func checkpointPlan() plexSharePreflight {
	return plexSharePreflight{Machine: "fixture-machine", Account: "2", State: "unobserved", Sections: []plexShareSection{{"1", "1001"}}}
}
func claimCheckpoint(t *testing.T, s *Store, p plexShareCheckpoint, action string) plexShareCheckpoint {
	t.Helper()
	claim, err := s.claimPlexShare(t.Context(), p.Job, p.Server, p.Revision, action, checkpointPlan())
	if err != nil {
		t.Fatal(err)
	}
	return claim
}
func TestPlexCheckpointIntentPendingObservationAndCancellation(t *testing.T) {
	_, s, job, server, f := plexCheckpointFixture(t)
	p := readPlexCheckpoint(t, s, job, server)
	if p.State != "prepared" || p.Revision != 1 || p.token != "" {
		t.Fatal(p)
	}
	claim := claimCheckpoint(t, s, p, "send")
	if claim.State != "send_uncertain" || claim.token == "" {
		t.Fatal(claim)
	}
	if _, err := s.claimPlexShare(t.Context(), job, server, claim.Revision, "send", checkpointPlan()); err == nil {
		t.Fatal("duplicate send claimed")
	}
	observed := checkpointPlan()
	observed.State = "pending"
	observed.ShareID = "700"
	if err := s.recordPlexShareObservation(t.Context(), claim, observed); err != nil {
		t.Fatal(err)
	}
	p = readPlexCheckpoint(t, s, job, server)
	if p.State != "awaiting_acceptance" || p.token != "" {
		t.Fatal(p)
	}
	if _, err := s.claimPlexShare(t.Context(), job, server, p.Revision, "send", checkpointPlan()); err == nil {
		t.Fatal("pending send replayed")
	}
	claim = claimCheckpoint(t, s, p, "inspect")
	observed.State = "accepted"
	observed.AllLibraries = true
	observed.DownloadsKnown = true
	if err := s.recordPlexShareObservation(t.Context(), claim, observed); err != nil {
		t.Fatal(err)
	}
	p = readPlexCheckpoint(t, s, job, server)
	if p.State != "access_observed" {
		t.Fatal(p)
	}
	var active, held, uses int
	var status string
	if err := s.reader.QueryRow(`SELECT u.is_active,j.reservation_held,i.current_uses,j.status FROM provisioning_jobs j JOIN user_accounts u ON u.uuid=j.user_uuid JOIN invites i ON i.id=j.invite_id WHERE j.id=?`, job).Scan(&active, &held, &uses, &status); err != nil {
		t.Fatal(err)
	}
	if active != 0 || held != 1 || uses != 0 || status != "running" {
		t.Fatal("observation completed provisioning")
	}
	claim = claimCheckpoint(t, s, p, "cancel")
	if claim.State != "cancel_uncertain" {
		t.Fatal(claim)
	}
	observed.State = "unobserved"
	observed.ShareID = ""
	if err := s.recordPlexShareObservation(t.Context(), claim, observed); err != nil {
		t.Fatal(err)
	}
	p = readPlexCheckpoint(t, s, job, server)
	if p.State != "cancel_uncertain" {
		t.Fatal("unobserved proved absence")
	}
	var retained bool
	if err := s.reader.QueryRow("SELECT status='active' AND secret IS NOT NULL FROM plex_invitation_credentials WHERE job_id=?", job).Scan(&retained); err != nil || !retained {
		t.Fatal("uncertain cancellation released credential", err)
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.creates != 1 {
		t.Fatal("checkpoint sent remote request")
	}
}
func TestPlexCheckpointRestartInvalidatesLeaseWithoutReplay(t *testing.T) {
	a, s, job, server, f := plexCheckpointFixture(t)
	claim := claimCheckpoint(t, s, readPlexCheckpoint(t, s, job, server), "send")
	restored, err := NewApp(s, a.queue, fstest.MapFS{"index.html": {Data: []byte("dashboard")}})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { restored.CloseProvisioning(); restored.CloseRealtime() })
	p := readPlexCheckpoint(t, s, job, server)
	if p.State != "send_uncertain" || p.token != "" || p.Revision <= claim.Revision {
		t.Fatal(p)
	}
	if err := s.recordPlexShareObservation(t.Context(), claim, checkpointPlan()); err == nil {
		t.Fatal("pre-restart operation committed")
	}
	if _, err := s.claimPlexShare(t.Context(), job, server, p.Revision, "send", checkpointPlan()); err == nil {
		t.Fatal("uncertain send replayed")
	}
	claimCheckpoint(t, s, p, "inspect")
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.creates != 1 {
		t.Fatal("restart replayed provider operation")
	}
}
func TestPlexCheckpointLeaseExpiryAndConcurrentClaims(t *testing.T) {
	_, s, job, server, _ := plexCheckpointFixture(t)
	p := readPlexCheckpoint(t, s, job, server)
	var wg sync.WaitGroup
	results := make(chan error, 2)
	for range 2 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, err := s.claimPlexShare(t.Context(), job, server, p.Revision, "send", checkpointPlan())
			results <- err
		}()
	}
	wg.Wait()
	close(results)
	success := 0
	for err := range results {
		if err == nil {
			success++
		}
	}
	if success != 1 {
		t.Fatal("multiple operations claimed", success)
	}
	old := readPlexCheckpoint(t, s, job, server)
	if _, err := s.writer.Exec("UPDATE plex_share_checkpoints SET operation_expires_at='2000-01-01T00:00:00.000Z' WHERE job_id=?", job); err != nil {
		t.Fatal(err)
	}
	if err := s.recordPlexShareObservation(t.Context(), old, checkpointPlan()); err == nil {
		t.Fatal("expired lease committed")
	}
	if err := s.expirePlexShareLeases(t.Context()); err != nil {
		t.Fatal(err)
	}
	p = readPlexCheckpoint(t, s, job, server)
	if p.token != "" || p.State != "send_uncertain" {
		t.Fatal(p)
	}
	claimCheckpoint(t, s, p, "inspect")
}
func TestPlexCheckpointLocalCancellationRetainsReservation(t *testing.T) {
	_, s, job, server, _ := plexCheckpointFixture(t)
	// No send was attempted, so local cancellation needs no remote/key authority.
	if _, err := s.writer.Exec("UPDATE media_servers SET api_key='changed' WHERE id=?", server); err != nil {
		t.Fatal(err)
	}
	p := claimCheckpoint(t, s, readPlexCheckpoint(t, s, job, server), "cancel")
	if p.State != "cancelled" || p.token != "" {
		t.Fatal(p)
	}
	var released, held bool
	if err := s.reader.QueryRow("SELECT c.status='released' AND c.secret IS NULL,j.reservation_held FROM plex_invitation_credentials c JOIN provisioning_jobs j ON j.id=c.job_id WHERE j.id=?", job).Scan(&released, &held); err != nil || !released || !held {
		t.Fatal("local cancellation released job capacity or retained secret", err)
	}
	if _, err := s.claimPlexShare(t.Context(), job, server, p.Revision, "send", checkpointPlan()); err == nil {
		t.Fatal("cancelled job sent")
	}
}
func TestPlexCheckpointRevalidatesAuthorityAfterWork(t *testing.T) {
	for _, change := range []string{"provider-key", "server-revision", "profile-active", "reservation", "credential-release", "identity", "machine", "mapping", "share-id", "unknown-state", "extra-downloads"} {
		t.Run(change, func(t *testing.T) {
			_, s, job, server, _ := plexCheckpointFixture(t)
			claim := claimCheckpoint(t, s, readPlexCheckpoint(t, s, job, server), "send")
			observed := checkpointPlan()
			observed.State = "accepted"
			observed.ShareID = "700"
			observed.AllLibraries = true
			observed.DownloadsKnown = true
			var err error
			switch change {
			case "provider-key":
				_, err = s.writer.Exec("UPDATE media_servers SET api_key='changed' WHERE id=?", server)
			case "server-revision":
				_, err = s.writer.Exec("UPDATE media_servers SET revision=revision+1 WHERE id=?", server)
			case "profile-active":
				_, err = s.writer.Exec("UPDATE user_accounts SET is_active=1 WHERE uuid=(SELECT user_uuid FROM provisioning_jobs WHERE id=?)", job)
			case "reservation":
				_, err = s.writer.Exec("UPDATE provisioning_jobs SET reservation_held=0 WHERE id=?", job)
			case "credential-release":
				_, err = s.writer.Exec("UPDATE plex_invitation_credentials SET status='released',secret=NULL WHERE job_id=?", job)
			case "identity":
				observed.Account = "99"
			case "machine":
				observed.Machine = "other"
			case "mapping":
				observed.Sections = []plexShareSection{{"1", "9999"}}
			case "share-id":
				observed.ShareID = "../2"
			case "unknown-state":
				observed.State = "absent"
			case "extra-downloads":
				observed.AllowDownloads = true
			}
			if err != nil {
				t.Fatal(err)
			}
			if err := s.recordPlexShareObservation(t.Context(), claim, observed); err == nil {
				t.Fatal("stale/ambiguous observation committed")
			}
			p := readPlexCheckpoint(t, s, job, server)
			if p.State != "send_uncertain" {
				t.Fatal(p)
			}
		})
	}
}
func TestPlexCheckpointSendRechecksRevokedInvitation(t *testing.T) {
	_, s, job, server, _ := plexCheckpointFixture(t)
	if _, err := s.writer.Exec("UPDATE invites SET is_active=0 WHERE id=(SELECT invite_id FROM provisioning_jobs WHERE id=?)", job); err != nil {
		t.Fatal(err)
	}
	if _, err := s.claimPlexShare(t.Context(), job, server, 1, "send", checkpointPlan()); err == nil {
		t.Fatal("revoked invitation sent")
	}
	p := readPlexCheckpoint(t, s, job, server)
	if p.State != "prepared" || p.token != "" {
		t.Fatal("failed claim persisted intent")
	}
	claimCheckpoint(t, s, p, "cancel")
}

func TestPlexCheckpointBlocksGenericCompletionEvenWithCompletedSteps(t *testing.T) {
	a, s, job, server, _ := plexCheckpointFixture(t)
	claim := claimCheckpoint(t, s, readPlexCheckpoint(t, s, job, server), "send")
	observed := checkpointPlan()
	observed.State = "accepted"
	observed.ShareID = "700"
	observed.AllLibraries = true
	observed.DownloadsKnown = true
	if err := s.recordPlexShareObservation(t.Context(), claim, observed); err != nil {
		t.Fatal(err)
	}
	if _, err := s.writer.Exec("UPDATE provisioning_steps SET status='completed',stage='completed' WHERE job_id=?", job); err != nil {
		t.Fatal(err)
	}
	var user string
	var invite int64
	if err := s.reader.QueryRow("SELECT user_uuid,invite_id FROM provisioning_jobs WHERE id=?", job).Scan(&user, &invite); err != nil {
		t.Fatal(err)
	}
	if err := a.completeRedemption(t.Context(), job, user, invite, map[int64]ManagedServer{}); err == nil {
		t.Fatal("cloud observation bypassed effective-access gate")
	}
	var active, held bool
	if err := s.reader.QueryRow("SELECT u.is_active,j.reservation_held FROM provisioning_jobs j JOIN user_accounts u ON u.uuid=j.user_uuid WHERE j.id=?", job).Scan(&active, &held); err != nil || active || !held {
		t.Fatal("blocked completion mutated profile or reservation", err)
	}
}

func TestPlexCheckpointUpgradeNeverAssumesExistingCredentialsWereUnsent(t *testing.T) {
	_, s, job, server, _ := plexCheckpointFixture(t)
	migration, err := migrationFiles.ReadFile("go_migrations/014_plex_share_checkpoints.sql")
	if err != nil {
		t.Fatal(err)
	}
	// Recreate the pre-014 table boundary in this disposable store, preserving the
	// already-consumed proof/job credential that an upgrade must not replay.
	if err := s.write(t.Context(), func(tx *sql.Tx) error {
		if _, err := tx.Exec("DROP TABLE plex_share_checkpoints"); err != nil {
			return err
		}
		_, err := tx.Exec(string(migration))
		return err
	}); err != nil {
		t.Fatal(err)
	}
	p := readPlexCheckpoint(t, s, job, server)
	if p.State != "send_uncertain" || p.Machine != "" || p.Share != "" || p.token != "" {
		t.Fatal("upgrade inferred remote state", p)
	}
	if _, err := s.claimPlexShare(t.Context(), job, server, p.Revision, "send", checkpointPlan()); err == nil {
		t.Fatal("upgrade allowed mutation replay")
	}
}
func TestPlexCheckpointCredentialIsRetainedUntilEveryUnsentShareIsCancelled(t *testing.T) {
	_, s, job, first, _ := plexCheckpointFixture(t)
	r, err := s.writer.Exec(`INSERT INTO media_servers(server_nickname,service_type,url) VALUES('second-checkpoint','plex','http://fixture.invalid')`)
	if err != nil {
		t.Fatal(err)
	}
	second, err := r.LastInsertId()
	if err != nil {
		t.Fatal(err)
	}
	grant := InvitationGrant{ServerID: second, AllLibraries: true}
	if _, err := s.writer.Exec("INSERT INTO provisioning_steps(job_id,server_id,status,grant_snapshot,provider_fingerprint) VALUES(?,?,'pending',?,'unused')", job, second, canonicalPlexInvitationGrant(grant)); err != nil {
		t.Fatal(err)
	}
	if _, err := s.writer.Exec("INSERT INTO plex_share_checkpoints(job_id,server_id,updated_at) VALUES(?,?,'fixture')", job, second); err != nil {
		t.Fatal(err)
	}
	claimCheckpoint(t, s, readPlexCheckpoint(t, s, job, first), "cancel")
	var retained bool
	if err := s.reader.QueryRow("SELECT status='active' AND secret IS NOT NULL FROM plex_invitation_credentials WHERE job_id=?", job).Scan(&retained); err != nil || !retained {
		t.Fatal("first cancellation discarded another pending share's credential", err)
	}
	claimCheckpoint(t, s, readPlexCheckpoint(t, s, job, second), "cancel")
	if err := s.reader.QueryRow("SELECT status='released' AND secret IS NULL FROM plex_invitation_credentials WHERE job_id=?", job).Scan(&retained); err != nil || !retained {
		t.Fatal("final unsent cancellation retained credential", err)
	}
}
