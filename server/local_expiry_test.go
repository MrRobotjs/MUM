package main

import (
	"context"
	"database/sql"
	"fmt"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/coder/websocket/wsjson"
)

func TestLocalExpiryRevokesOncePreservesIdentityAndPrivateNotice(t *testing.T) {
	f := activityReadFixture(t)
	a, s := f.app, f.store
	owner, _ := s.Authenticate(t.Context(), f.ownerToken)
	other, err := s.CreateAccount(t.Context(), owner.UUID, "expiry-observer", "fixture-hash", false)
	if err != nil {
		t.Fatal(err)
	}
	if err = s.AssignAdminRole(t.Context(), owner.UUID, other, "high"); err != nil {
		t.Fatal(err)
	}
	observer, err := s.issueSession(t.Context(), other, false)
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(a)
	defer server.Close()
	c, ctx := dialClient(t, server.URL, f.token)
	defer c.CloseNow()
	activityExec(t, s, `INSERT INTO plex_authorizations(id,owner_uuid,browser_hash,status,secret,expires_at,poll_after,created_at,updated_at) VALUES('local-expiry-proof',?,'fixture','verified',X'0102','2099-01-01T00:00:00Z','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')`, f.user)
	activityExec(t, s, "UPDATE user_accounts SET access_expires_at='2000-01-01T00:00:00Z' WHERE uuid=?", f.user)
	var before string
	if err = s.reader.QueryRow("SELECT json_array(uuid,kind,local_username,password_hash,is_active,profile_revision,updated_at) FROM user_accounts WHERE uuid=?", f.user).Scan(&before); err != nil {
		t.Fatal(err)
	}
	if err = a.reconcileLocalExpiry(t.Context()); err != nil {
		t.Fatal(err)
	}
	deadline, cancel := context.WithTimeout(ctx, time.Second)
	defer cancel()
	var message any
	if err = wsjson.Read(deadline, c, &message); err == nil {
		t.Fatal("expired socket survived committed cleanup")
	}
	var after string
	s.reader.QueryRow("SELECT json_array(uuid,kind,local_username,password_hash,is_active,profile_revision,updated_at) FROM user_accounts WHERE uuid=?", f.user).Scan(&after)
	if before != after {
		t.Fatal("expiry cleanup changed account identity/activation/credentials")
	}
	var sessions, roles, links, history, proof int
	s.reader.QueryRow("SELECT count(*) FROM app_sessions WHERE user_uuid=?", f.user).Scan(&sessions)
	s.reader.QueryRow("SELECT count(*) FROM admin_privileges WHERE user_uuid=?", f.user).Scan(&roles)
	s.reader.QueryRow("SELECT count(*) FROM service_links WHERE user_uuid=? AND service_uuid=?", f.user, f.service).Scan(&links)
	s.reader.QueryRow("SELECT count(*) FROM media_activity_history WHERE owner_uuid=?", f.user).Scan(&history)
	s.reader.QueryRow("SELECT count(*) FROM plex_authorizations WHERE id='local-expiry-proof' AND status='failed' AND secret IS NULL").Scan(&proof)
	if sessions != 0 || roles != 1 || links != 1 || history != 1 || proof != 1 {
		t.Fatal(sessions, roles, links, history, proof)
	}
	if _, err = s.Authenticate(t.Context(), f.ownerToken); err != nil {
		t.Fatal("owner session changed", err)
	}
	if own := inboxSnapshot(t, a, f.ownerToken); own["total"] != float64(1) || own["notifications"].([]any)[0].(map[string]any)["notification_type"] != "ACCOUNT_EXPIRED" {
		t.Fatal(own)
	}
	if other := inboxSnapshot(t, a, observer.Access); other["total"] != float64(0) {
		t.Fatal("expiry metadata exposed to another administrator")
	}
	if err = a.reconcileLocalExpiry(t.Context()); err != nil {
		t.Fatal(err)
	}
	var audits int
	s.reader.QueryRow("SELECT count(*) FROM audit_events WHERE action='account.expiry.reconcile'").Scan(&audits)
	if audits != 1 {
		t.Fatal("duplicate expiry audit", audits)
	}
	activityExec(t, s, "UPDATE user_accounts SET access_expires_at=NULL WHERE uuid=?", f.user)
	if err = a.reconcileLocalExpiry(t.Context()); err != nil {
		t.Fatal(err)
	}
	if _, err = s.Authenticate(t.Context(), f.token); err == nil {
		t.Fatal("clearing expiry revived a revoked session")
	}
	if own := inboxSnapshot(t, a, f.ownerToken); own["unread_count"] != float64(0) {
		t.Fatal("obsolete expiry notice not resolved", own)
	}
	activityExec(t, s, "UPDATE user_accounts SET access_expires_at='2000-01-01T00:00:00Z' WHERE uuid=?", f.user)
	if err = a.reconcileLocalExpiry(t.Context()); err != nil {
		t.Fatal(err)
	}
	if own := inboxSnapshot(t, a, f.ownerToken); own["total"] != float64(2) || own["unread_count"] != float64(1) {
		t.Fatal("new expiry epoch not notified", own)
	}
}

func TestLocalExpiryAuditFailureRollsBackCleanupAndSignals(t *testing.T) {
	a, s, owner, _, user := roleReadFixture(t)
	activityExec(t, s, "UPDATE user_accounts SET access_expires_at='2000-01-01T00:00:00Z' WHERE uuid=?", user)
	p, _ := s.Authenticate(t.Context(), owner)
	before, _ := s.notificationSignal(t.Context(), p.UUID)
	activityExec(t, s, "CREATE TRIGGER deny_local_expiry BEFORE INSERT ON audit_events WHEN NEW.action='account.expiry.reconcile' BEGIN SELECT RAISE(ABORT,'fixture'); END")
	if err := a.reconcileLocalExpiry(t.Context()); err == nil {
		t.Fatal("expiry audit failure ignored")
	}
	var sessions, notices int
	s.reader.QueryRow("SELECT count(*) FROM app_sessions WHERE user_uuid=?", user).Scan(&sessions)
	s.reader.QueryRow("SELECT count(*) FROM admin_notifications").Scan(&notices)
	after, _ := s.notificationSignal(t.Context(), p.UUID)
	if sessions != 1 || notices != 0 || before != after {
		t.Fatal("partial cleanup/notification committed")
	}
	activityExec(t, s, "DROP TRIGGER deny_local_expiry")
	if err := a.reconcileLocalExpiry(t.Context()); err != nil {
		t.Fatal(err)
	}
}

func TestLocalExpiryBoundedBatchAndCancellation(t *testing.T) {
	a, s := testApp(t)
	owner, _ := bootstrapOwner(t, a)
	if err := s.write(t.Context(), func(tx *sql.Tx) error {
		for i := 0; i < 105; i++ {
			id := newUUID()
			if _, err := tx.Exec("INSERT INTO identities(uuid,kind) VALUES(?,'local')", id); err != nil {
				return err
			}
			if _, err := tx.Exec("INSERT INTO user_accounts(uuid,kind,local_username,password_hash,access_expires_at,created_at,updated_at) VALUES(?,'local',?,'fixture','2000-01-01T00:00:00Z',?,?)", id, fmt.Sprintf("expiry-batch-%d", i), utcTimestamp(time.Now()), utcTimestamp(time.Now())); err != nil {
				return err
			}
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if err := a.reconcileLocalExpiry(ctx); err != nil {
		t.Fatal(err)
	}
	var count int
	s.reader.QueryRow("SELECT count(*) FROM admin_notifications").Scan(&count)
	if count != 0 {
		t.Fatal("cancelled batch committed")
	}
	if err := a.reconcileLocalExpiry(t.Context()); err != nil {
		t.Fatal(err)
	}
	s.reader.QueryRow("SELECT count(*) FROM admin_notifications").Scan(&count)
	if count != 100 {
		t.Fatal("batch limit violated", count)
	}
	if err := a.reconcileLocalExpiry(t.Context()); err != nil {
		t.Fatal(err)
	}
	s.reader.QueryRow("SELECT count(*) FROM admin_notifications").Scan(&count)
	if count != 105 {
		t.Fatal("batch remainder lost", count)
	}
	if _, err := s.Authenticate(t.Context(), owner); err != nil {
		t.Fatal("owner was expired", err)
	}
}
