package main

import (
	"database/sql"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

func verifiedPlexFinalizationFixture(t *testing.T) (*App, *Store, string, int64, int64) {
	t.Helper()
	a, s, job, server := plexVerificationFixture(t, nil)
	hash, err := hashPassword(invitationPassword)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.writer.Exec("UPDATE user_accounts SET local_username='finalized-recipient',password_hash=? WHERE uuid=(SELECT user_uuid FROM provisioning_jobs WHERE id=?)", hash, job); err != nil {
		t.Fatal(err)
	}
	checkpoint := readPlexCheckpoint(t, s, job, server)
	if err := a.verifyPlexLibraryCompletion(t.Context(), job, server, checkpoint.Revision); err != nil {
		t.Fatal(err)
	}
	return a, s, job, server, readPlexCheckpoint(t, s, job, server).Revision
}
func TestPlexFinalizationAtomicallyPromotesCredentialAndIdentity(t *testing.T) {
	a, s, job, server, revision := verifiedPlexFinalizationFixture(t)
	var beforeHash string
	var beforeServer int64
	if err := s.reader.QueryRow("SELECT u.password_hash,m.revision FROM provisioning_jobs j JOIN user_accounts u ON u.uuid=j.user_uuid JOIN media_servers m ON m.id=? WHERE j.id=?", server, job).Scan(&beforeHash, &beforeServer); err != nil {
		t.Fatal(err)
	}
	if err := a.completeVerifiedPlexJob(t.Context(), job, server, revision); err != nil {
		t.Fatal(err)
	}
	var active, held, released bool
	var uses int
	var hash, external, username, link, status, connection, user string
	var encrypted []byte
	var serverRevision int64
	if err := s.reader.QueryRow(`SELECT u.is_active,j.reservation_held,i.current_uses,u.password_hash,a.external_user_id,a.external_username,l.link_kind,j.status,c.id,c.owner_uuid,c.secret,k.status='released' AND k.secret IS NULL,m.revision FROM plex_job_completions f JOIN provisioning_jobs j ON j.id=f.job_id JOIN user_accounts u ON u.uuid=j.user_uuid JOIN invites i ON i.id=j.invite_id JOIN service_accounts a ON a.uuid=f.service_uuid JOIN service_links l ON l.service_uuid=a.uuid AND l.user_uuid=u.uuid JOIN plex_connections c ON c.id=f.connection_id JOIN plex_invitation_credentials k ON k.job_id=j.id JOIN media_servers m ON m.id=f.server_id WHERE j.id=?`, job).Scan(&active, &held, &uses, &hash, &external, &username, &link, &status, &connection, &user, &encrypted, &released, &serverRevision); err != nil {
		t.Fatal(err)
	}
	if !active || held || uses != 1 || hash != beforeHash || external != "2" || username != "reader" || link != "owner" || status != "completed" || !released || serverRevision != beforeServer+1 {
		t.Fatal("incomplete or incorrect atomic finalization")
	}
	secret, err := s.openPlexCredential(t.Context(), plexConnectionPurpose(connection, user, "2"), encrypted)
	if err != nil || secret.AccountID != "2" || secret.Token != plexFixtureToken {
		t.Fatal("promoted credential unusable", err)
	}
	if _, err := s.openPlexCredential(t.Context(), "wrong-purpose", encrypted); err == nil {
		t.Fatal("credential lost purpose binding")
	}
	receipt, err := a.loadRedemption(t.Context(), job)
	if err != nil {
		t.Fatal(err)
	}
	if receipt.Plex.Phase != "completed" || receipt.Plex.RequiresReview || receipt.Plex.CompletionAvailable || !receipt.Steps[0].Plex.CompletionRecorded || receipt.Steps[0].Plex.AccessVerified || receipt.Steps[0].Plex.VerificationScope != plexLibraryVerificationScope {
		t.Fatal("incorrect completion provenance", receipt.Plex)
	}
	encoded, _ := json.Marshal(publicRedemption(receipt))
	for _, bad := range []string{user, connection, plexFixtureToken, "account_id", "service_uuid", "connection_id"} {
		if strings.Contains(string(encoded), bad) {
			t.Fatal("completion receipt leaked", bad)
		}
	}
	login := apiRequest(a, "POST", "/api/auth/login", "", map[string]any{"username": "finalized-recipient", "password": invitationPassword}, nil)
	if login.Code != 200 {
		t.Fatal("original local credentials no longer work", login.Code)
	}
	token := responseData(t, login)["access_token"].(string)
	if w := apiRequest(a, "GET", "/api/plex/connection", token, nil, nil); w.Code != 200 || !strings.Contains(w.Body.String(), "reader") {
		t.Fatal("recipient lacks personal connection", w.Code, w.Body.String())
	}
	if err := a.completeVerifiedPlexJob(t.Context(), job, server, revision); err == nil {
		t.Fatal("completed job reused")
	}
}
func TestPlexFinalizationRollbackRetainsReservationAndCredential(t *testing.T) {
	a, s, job, server, revision := verifiedPlexFinalizationFixture(t)
	prepared, err := a.preparePlexCompletion(t.Context(), job, server, revision)
	if err != nil {
		t.Fatal(err)
	}
	rollback := errors.New("simulated failure after all finalization writes")
	err = s.write(t.Context(), func(tx *sql.Tx) error {
		if err := commitPlexCompletion(t.Context(), tx, prepared); err != nil {
			return err
		}
		return rollback
	})
	if !errors.Is(err, rollback) {
		t.Fatal(err)
	}
	var retained bool
	var records, connections, links int
	if err := s.reader.QueryRow("SELECT j.reservation_held=1 AND u.is_active=0 AND c.status='active' AND c.secret IS NOT NULL FROM provisioning_jobs j JOIN user_accounts u ON u.uuid=j.user_uuid JOIN plex_invitation_credentials c ON c.job_id=j.id WHERE j.id=?", job).Scan(&retained); err != nil || !retained {
		t.Fatal("rollback lost reservation or secret", err)
	}
	s.reader.QueryRow("SELECT count(*) FROM plex_job_completions").Scan(&records)
	s.reader.QueryRow("SELECT count(*) FROM plex_connections").Scan(&connections)
	s.reader.QueryRow("SELECT count(*) FROM service_links").Scan(&links)
	if records != 0 || connections != 0 || links != 0 {
		t.Fatal("rollback left partial identities/connections")
	}
	if err := s.write(t.Context(), func(tx *sql.Tx) error { return commitPlexCompletion(t.Context(), tx, prepared) }); err != nil {
		t.Fatal("rolled back finalization could not complete", err)
	}
}
func TestPlexFinalizationConcurrentPreparedResultsCommitOnce(t *testing.T) {
	a, s, job, server, revision := verifiedPlexFinalizationFixture(t)
	first, err := a.preparePlexCompletion(t.Context(), job, server, revision)
	if err != nil {
		t.Fatal(err)
	}
	second, err := a.preparePlexCompletion(t.Context(), job, server, revision)
	if err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	results := make(chan error, 2)
	for _, p := range []preparedPlexCompletion{first, second} {
		wg.Add(1)
		go func(p preparedPlexCompletion) {
			defer wg.Done()
			results <- s.write(t.Context(), func(tx *sql.Tx) error { return commitPlexCompletion(t.Context(), tx, p) })
		}(p)
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
		t.Fatal("multiple finalizations committed", success)
	}
	var uses, records int
	s.reader.QueryRow("SELECT sum(current_uses) FROM invites").Scan(&uses)
	s.reader.QueryRow("SELECT count(*) FROM plex_job_completions").Scan(&records)
	if uses != 1 || records != 1 {
		t.Fatal(uses, records)
	}
}
func TestPlexFinalizationRejectsStalePreparedStateAndMissingKeys(t *testing.T) {
	for _, mode := range []string{"invitation", "checkpoint", "credential", "profile", "key-loss", "step"} {
		t.Run(mode, func(t *testing.T) {
			a, s, job, server, revision := verifiedPlexFinalizationFixture(t)
			if mode == "key-loss" {
				if err := os.Remove(filepath.Join(s.dataDir, "plex.key")); err != nil {
					t.Fatal(err)
				}
				if err := a.completeVerifiedPlexJob(t.Context(), job, server, revision); err == nil {
					t.Fatal("lost key permitted promotion")
				}
				return
			}
			prepared, err := a.preparePlexCompletion(t.Context(), job, server, revision)
			if err != nil {
				t.Fatal(err)
			}
			switch mode {
			case "invitation":
				_, err = s.writer.Exec("UPDATE invites SET is_active=0 WHERE id=(SELECT invite_id FROM provisioning_jobs WHERE id=?)", job)
			case "checkpoint":
				_, err = s.writer.Exec("UPDATE plex_share_checkpoints SET revision=revision+1 WHERE job_id=?", job)
			case "credential":
				_, err = s.writer.Exec("UPDATE plex_invitation_credentials SET revision=revision+1 WHERE job_id=?", job)
			case "profile":
				_, err = s.writer.Exec("UPDATE user_accounts SET is_active=1 WHERE uuid=(SELECT user_uuid FROM provisioning_jobs WHERE id=?)", job)
			case "step":
				_, err = s.writer.Exec("UPDATE provisioning_steps SET status='failed' WHERE job_id=?", job)
			}
			if err != nil {
				t.Fatal(err)
			}
			if err := s.write(t.Context(), func(tx *sql.Tx) error { return commitPlexCompletion(t.Context(), tx, prepared) }); err == nil {
				t.Fatal("stale prepared finalization committed")
			}
			var records int
			s.reader.QueryRow("SELECT count(*) FROM plex_job_completions").Scan(&records)
			if records != 0 {
				t.Fatal("partial completion persisted")
			}
		})
	}
}

func TestPlexFinalizationRecoveryDoesNotReplayOrActivatePreparedWork(t *testing.T) {
	for _, completed := range []bool{false, true} {
		t.Run(map[bool]string{false: "prepared", true: "completed"}[completed], func(t *testing.T) {
			a, s, job, server, revision := verifiedPlexFinalizationFixture(t)
			if _, err := s.writer.Exec("UPDATE provisioning_jobs SET request_hash=? WHERE id=?", tokenHash(randomToken()), job); err != nil {
				t.Fatal(err)
			}
			prepared, err := a.preparePlexCompletion(t.Context(), job, server, revision)
			if err != nil {
				t.Fatal(err)
			}
			if completed {
				if err := s.write(t.Context(), func(tx *sql.Tx) error { return commitPlexCompletion(t.Context(), tx, prepared) }); err != nil {
					t.Fatal(err)
				}
			}
			if err := a.recoverProvisioning(t.Context()); err != nil {
				t.Fatal(err)
			}
			if err := s.write(t.Context(), func(tx *sql.Tx) error { return commitPlexCompletion(t.Context(), tx, prepared) }); err == nil {
				t.Fatal("recovery permitted completion replay")
			}
			receipt, err := a.loadRedemption(t.Context(), job)
			if err != nil {
				t.Fatal(err)
			}
			if completed {
				if receipt.Status != "completed" || receipt.Plex.Phase != "completed" {
					t.Fatal(receipt)
				}
			} else if receipt.Status != "failed" || !receipt.Reserved {
				t.Fatal("prepared work activated or lost capacity", receipt)
			}
			var active bool
			if err := s.reader.QueryRow("SELECT is_active FROM user_accounts WHERE uuid=(SELECT user_uuid FROM provisioning_jobs WHERE id=?)", job).Scan(&active); err != nil || active != completed {
				t.Fatal("restart changed profile outcome", err)
			}
		})
	}
}
func TestPlexFinalizationRejectsLateIdentityOwnershipConflicts(t *testing.T) {
	for _, mode := range []string{"personal-connection", "existing-service"} {
		t.Run(mode, func(t *testing.T) {
			a, s, job, server, revision := verifiedPlexFinalizationFixture(t)
			p, err := a.preparePlexCompletion(t.Context(), job, server, revision)
			if err != nil {
				t.Fatal(err)
			}
			if mode == "personal-connection" {
				_, err = s.writer.Exec(`INSERT INTO plex_connections(id,owner_uuid,account_id,username,status,created_at,verified_at) VALUES(?,?,?,'conflict','active','fixture','fixture')`, newUUID(), p.user, p.account)
			} else {
				id := newUUID()
				_, err = s.writer.Exec("INSERT INTO identities(uuid,kind) VALUES(?,'service')", id)
				if err == nil {
					_, err = s.writer.Exec(`INSERT INTO service_accounts(uuid,server_id,external_user_id,external_username,is_active,created_at,updated_at) VALUES(?,?,?,'existing',1,'fixture','fixture')`, id, server, p.account)
				}
			}
			if err != nil {
				t.Fatal(err)
			}
			if err := s.write(t.Context(), func(tx *sql.Tx) error { return commitPlexCompletion(t.Context(), tx, p) }); err == nil {
				t.Fatal("conflicting identity adopted")
			}
			var count int
			s.reader.QueryRow("SELECT count(*) FROM plex_job_completions").Scan(&count)
			if count != 0 {
				t.Fatal("partial finalization after ownership conflict")
			}
		})
	}
}
