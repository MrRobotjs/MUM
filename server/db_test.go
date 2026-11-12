package main

import (
	"context"
	"database/sql"
	"errors"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func testStore(t *testing.T) *Store {
	t.Helper()
	s, err := OpenStore(t.Context(), filepath.Join(t.TempDir(), "data #1 & unicode é.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := s.Close(); err != nil {
			t.Error(err)
		}
	})
	return s
}

func seedServer(t *testing.T, s *Store) int64 {
	t.Helper()
	r, err := s.writer.ExecContext(t.Context(), `INSERT INTO media_servers(server_nickname,service_type,url) VALUES('test','jellyfin','http://example.invalid')`)
	if err != nil {
		t.Fatal(err)
	}
	id, err := r.LastInsertId()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.writer.Exec("UPDATE provider_settings SET enabled=1 WHERE provider_id='jellyfin'"); err != nil {
		t.Fatal(err)
	}
	return id
}

func seedService(t *testing.T, s *Store, server int64) string {
	t.Helper()
	id := newUUID()
	err := s.write(t.Context(), func(tx *sql.Tx) error {
		if _, err := tx.Exec(`INSERT INTO identities(uuid,kind) VALUES(?,'service')`, id); err != nil {
			return err
		}
		_, err := tx.Exec(`INSERT INTO service_accounts(uuid,server_id,external_user_id,created_at,updated_at) VALUES(?,?,?,?,?)`, id, server, id, utcTimestamp(time.Now()), utcTimestamp(time.Now()))
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	return id
}

func TestStorePragmasAndIntegrity(t *testing.T) {
	s := testStore(t)
	// Force replacement writer connections: connection-local PRAGMAs must survive.
	s.writer.SetMaxIdleConns(0)
	for _, db := range []*sql.DB{s.writer, s.reader} {
		for name, want := range map[string]int{"busy_timeout": 5000, "foreign_keys": 1, "synchronous": 1} {
			var got int
			if err := db.QueryRow("PRAGMA " + name).Scan(&got); err != nil {
				t.Fatal(err)
			}
			if got != want {
				t.Fatalf("%s=%d, want %d", name, got, want)
			}
		}
		var journal string
		if err := db.QueryRow("PRAGMA journal_mode").Scan(&journal); err != nil {
			t.Fatal(err)
		}
		if journal != "wal" {
			t.Fatal(journal)
		}
	}
	var cache int
	if err := s.writer.QueryRow("PRAGMA cache_size").Scan(&cache); err != nil || cache != -64000 {
		t.Fatalf("writer cache %d: %v", cache, err)
	}
	if err := s.reader.QueryRow("PRAGMA cache_size").Scan(&cache); err != nil || cache != -16000 {
		t.Fatalf("reader cache %d: %v", cache, err)
	}
	if _, err := s.reader.Exec("INSERT INTO settings(key,value_type) VALUES('bad','string')"); err == nil {
		t.Fatal("reader allowed a write")
	}
	if s.writer.Stats().MaxOpenConnections != 1 {
		t.Fatal("writer pool not serialized")
	}
	if err := s.CheckIntegrity(t.Context()); err != nil {
		t.Fatal(err)
	}
}

func TestMigrationReopenAndRejectTampering(t *testing.T) {
	for _, mode := range []string{"reopen", "checksum", "future", "gap"} {
		t.Run(mode, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "app.sqlite")
			s, err := OpenStore(t.Context(), path)
			if err != nil {
				t.Fatal(err)
			}
			switch mode {
			case "checksum":
				_, err = s.writer.Exec("UPDATE schema_migrations SET checksum='changed' WHERE version='001_identity.sql'")
			case "future":
				_, err = s.writer.Exec("INSERT INTO schema_migrations VALUES('999_future.sql','unknown','now')")
			case "gap":
				_, err = s.writer.Exec("DELETE FROM schema_migrations WHERE version='001_identity.sql'")
			}
			if err != nil {
				t.Fatal(err)
			}
			if err = s.Close(); err != nil {
				t.Fatal(err)
			}
			s, err = OpenStore(t.Context(), path)
			if mode == "reopen" {
				if err != nil {
					t.Fatal(err)
				}
				s.Close()
			} else {
				if err == nil {
					s.Close()
					t.Fatal("accepted invalid migration history")
				}
			}
		})
	}
}

func TestLegacyDatabaseIsNotMigratedInPlace(t *testing.T) {
	path := filepath.Join(t.TempDir(), "legacy.sqlite")
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = db.Exec("CREATE TABLE users(id INTEGER PRIMARY KEY); INSERT INTO users VALUES(42)"); err != nil {
		t.Fatal(err)
	}
	db.Close()
	if s, err := OpenStore(t.Context(), path); err == nil {
		s.Close()
		t.Fatal("accepted legacy source")
	}
	db, err = sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	var id int
	if err := db.QueryRow("SELECT id FROM users").Scan(&id); err != nil || id != 42 {
		t.Fatal("source changed", id, err)
	}
	var journal string
	if err := db.QueryRow("PRAGMA journal_mode").Scan(&journal); err != nil || journal != "delete" {
		t.Fatal("source journal changed", journal, err)
	}
}

func TestLinksRolesAndRefreshAreSerialized(t *testing.T) {
	s := testStore(t)
	ctx := t.Context()
	owner, err := s.CreateAccount(ctx, "", "owner", "encoded-password", true)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.CreateAccount(ctx, "", "owner2", "encoded", true); !errors.Is(err, ErrConflict) {
		t.Fatal(err)
	}
	first, err := s.CreateAccount(ctx, owner, "first", "encoded", false)
	if err != nil {
		t.Fatal(err)
	}
	second, err := s.CreateAccount(ctx, owner, "second", "encoded", false)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.CreateAccount(ctx, first, "unauthorized", "encoded", false); !errors.Is(err, ErrForbidden) {
		t.Fatal(err)
	}
	server := seedServer(t, s)
	service := seedService(t, s, server)
	var winners atomic.Int64
	var wg sync.WaitGroup
	for _, target := range []string{first, second} {
		wg.Add(1)
		go func() {
			defer wg.Done()
			err := s.LinkServiceAccounts(ctx, owner, target, []string{service})
			if err == nil {
				winners.Add(1)
			} else if !errors.Is(err, ErrConflict) {
				t.Error(err)
			}
		}()
	}
	wg.Wait()
	if winners.Load() != 1 {
		t.Fatal("link race winners", winners.Load())
	}
	if err := s.LinkServiceAccounts(ctx, first, first, []string{service}); !errors.Is(err, ErrForbidden) {
		t.Fatal(err)
	}
	for _, sql := range []string{
		`INSERT OR IGNORE INTO admin_permissions VALUES('admin','administrator',NULL)`,
		`INSERT INTO admin_roles(id,name,position) VALUES('high','Custom admin name',50),('low','Helper',10),('equal','Other admin',50)`,
		`INSERT INTO admin_role_permissions VALUES('high','admin')`,
	} {
		if _, err := s.writer.Exec(sql); err != nil {
			t.Fatal(err)
		}
	}
	if err := s.AssignAdminRole(ctx, owner, first, "high"); err != nil {
		t.Fatal(err)
	}
	if err := s.AssignAdminRole(ctx, first, second, "low"); err != nil {
		t.Fatal("permission must work regardless of role name", err)
	}
	if err := s.AssignAdminRole(ctx, first, second, "equal"); !errors.Is(err, ErrForbidden) {
		t.Fatal(err)
	}
	if err := s.AssignAdminRole(ctx, first, first, "low"); !errors.Is(err, ErrForbidden) {
		t.Fatal(err)
	}
	if err := s.RemoveAdminRole(ctx, owner, first, "high"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.CreateAccount(ctx, first, "after-revocation", "encoded", false); !errors.Is(err, ErrForbidden) {
		t.Fatal("revoked permission still allowed mutation", err)
	}
	if _, err := s.writer.Exec("UPDATE user_accounts SET is_active=0 WHERE uuid=?", owner); err == nil {
		t.Fatal("disabled owner")
	}
	if _, err := s.writer.Exec("DELETE FROM identities WHERE uuid=?", owner); err == nil {
		t.Fatal("deleted owner")
	}
	winners.Store(0)
	for range 12 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			err := s.ConsumeRefreshJTI(ctx, second, "once-only", time.Now().Add(time.Hour))
			if err == nil {
				winners.Add(1)
			} else if !errors.Is(err, ErrConflict) {
				t.Error(err)
			}
		}()
	}
	wg.Wait()
	if winners.Load() != 1 {
		t.Fatal("refresh replay winners", winners.Load())
	}
	if err := s.CheckIntegrity(ctx); err != nil {
		t.Fatal(err)
	}
}

func TestBatchRollbackAndDeduplication(t *testing.T) {
	s := testStore(t)
	bad := int64(999)
	valid := LogEntry{Source: "test", Type: "event", EventKey: "stable", Payload: []byte(`{"ok":true}`)}
	invalid := valid
	invalid.ServerID = &bad
	if _, err := s.WriteLogBatch(t.Context(), []LogEntry{valid, invalid}); err == nil {
		t.Fatal("expected foreign key failure")
	}
	var count int
	if err := s.reader.QueryRow("SELECT count(*) FROM log_entries").Scan(&count); err != nil || count != 0 {
		t.Fatal("partial batch persisted", count, err)
	}
	if n, err := s.WriteLogBatch(t.Context(), []LogEntry{valid, valid}); err != nil || n != 1 {
		t.Fatal(n, err)
	}
}

func TestMergeRollback(t *testing.T) {
	s := testStore(t)
	owner, err := s.CreateAccount(t.Context(), "", "owner", "encoded", true)
	if err != nil {
		t.Fatal(err)
	}
	service := seedService(t, s, seedServer(t, s))
	if err := s.LinkServiceAccounts(t.Context(), owner, owner, []string{service, "missing"}); !errors.Is(err, ErrNotFound) {
		t.Fatal(err)
	}
	var count int
	if err := s.reader.QueryRow("SELECT count(*) FROM service_links").Scan(&count); err != nil || count != 0 {
		t.Fatal("merge partially persisted", count, err)
	}
}

func TestCancelledWrite(t *testing.T) {
	s := testStore(t)
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	_, err := s.CreateAccount(ctx, "", "owner", "encoded", true)
	if err == nil || !strings.Contains(err.Error(), "canceled") {
		t.Fatal(err)
	}
}

func TestCreateAndLinkIsAtomicAndUnlinkPreservesHistoryIdentity(t *testing.T) {
	s := testStore(t)
	ctx := t.Context()
	owner, err := s.CreateAccount(ctx, "", "owner", "encoded", true)
	if err != nil {
		t.Fatal(err)
	}
	server := seedServer(t, s)
	first := seedService(t, s, server)
	second := seedService(t, s, server)
	if _, err := s.CreateAndLinkAccount(ctx, owner, "rolled-back", "encoded", []string{first, "missing"}); !errors.Is(err, ErrNotFound) {
		t.Fatal(err)
	}
	var count int
	if err := s.reader.QueryRow("SELECT count(*) FROM user_accounts WHERE local_username='rolled-back'").Scan(&count); err != nil || count != 0 {
		t.Fatal("new principal survived rollback", count, err)
	}
	profile, err := s.CreateAndLinkAccount(ctx, owner, "linked", "encoded", []string{first, second})
	if err != nil {
		t.Fatal(err)
	}
	if err := s.UnlinkServiceAccount(ctx, profile, profile, first); !errors.Is(err, ErrForbidden) {
		t.Fatal(err)
	}
	if err := s.UnlinkServiceAccount(ctx, owner, profile, first); err != nil {
		t.Fatal(err)
	}
	if err := s.reader.QueryRow("SELECT count(*) FROM service_accounts WHERE uuid=?", first).Scan(&count); err != nil || count != 1 {
		t.Fatal("unlink deleted identity", count, err)
	}
	if err := s.UnlinkServiceAccount(ctx, owner, profile, first); !errors.Is(err, ErrNotFound) {
		t.Fatal(err)
	}
}
