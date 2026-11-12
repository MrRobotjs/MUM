package main

import (
	"context"
	"database/sql"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestDataDirectoryLockExclusiveAcrossStoresAndRecovery(t *testing.T) {
	path := filepath.Join(t.TempDir(), "mum.sqlite")
	s, err := OpenStore(t.Context(), path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	for _, recovery := range []bool{false, true} {
		var other *Store
		if recovery {
			other, err = OpenRecoveryStore(t.Context(), path)
		} else {
			other, err = OpenStore(t.Context(), path)
		}
		if other != nil || !errors.Is(err, errDataDirectoryInUse) {
			if other != nil {
				other.Close()
			}
			t.Fatal(other, err)
		}
	}
	if other, err := OpenStore(t.Context(), filepath.Join(filepath.Dir(path), "different.sqlite")); other != nil || !errors.Is(err, errDataDirectoryInUse) {
		if other != nil {
			other.Close()
		}
		t.Fatal("same-directory alternate file bypassed lock", err)
	}
	if err = s.Close(); err != nil {
		t.Fatal(err)
	}
	recovered, err := OpenRecoveryStore(t.Context(), path)
	if err != nil {
		t.Fatal(err)
	}
	if err = recovered.Close(); err != nil {
		t.Fatal(err)
	}
	reopened, err := OpenStore(t.Context(), path)
	if err != nil {
		t.Fatal(err)
	}
	reopened.Close()
}
func TestRecoveryStoreRefusesMissingOrInvalidHistoryWithoutMigration(t *testing.T) {
	missing := filepath.Join(t.TempDir(), "missing", "mum.sqlite")
	if s, err := OpenRecoveryStore(t.Context(), missing); err == nil {
		if s != nil {
			s.Close()
		}
		t.Fatal("created missing recovery database")
	}
	if _, err := os.Stat(filepath.Dir(missing)); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("created missing directory", err)
	}
	for _, mode := range []string{"gap", "checksum", "future"} {
		t.Run(mode, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "mum.sqlite")
			s, err := OpenStore(t.Context(), path)
			if err != nil {
				t.Fatal(err)
			}
			query := map[string]string{"gap": "DELETE FROM schema_migrations WHERE version='039_human_credential_revision.sql'", "checksum": "UPDATE schema_migrations SET checksum='changed' WHERE version='001_identity.sql'", "future": "INSERT INTO schema_migrations VALUES('999_future.sql','future','now')"}[mode]
			if _, err = s.writer.Exec(query); err != nil {
				t.Fatal(err)
			}
			var before string
			s.writer.QueryRow("SELECT json_group_array(json_array(version,checksum)) FROM schema_migrations").Scan(&before)
			s.Close()
			recovered, err := OpenRecoveryStore(t.Context(), path)
			if err == nil {
				recovered.Close()
				t.Fatal("accepted invalid history")
			}
			// The failure must release its lock even though the schema cannot be opened.
			lock, err := lockDataDirectory(filepath.Dir(path))
			if err != nil {
				t.Fatal("failed open retained lock", err)
			}
			lock.Close()
			// A read-only direct observation verifies no migration was silently repaired.
			db, err := sql.Open("sqlite", sqliteDSN(path, true))
			if err != nil {
				t.Fatal(err)
			}
			defer db.Close()
			var after string
			if err = db.QueryRow("SELECT json_group_array(json_array(version,checksum)) FROM schema_migrations").Scan(&after); err != nil || after != before {
				t.Fatal(before, after, err)
			}
		})
	}
}
func TestOfflineOwnerRecoveryRevokesSessionsPreservesKeysAndOtherUsers(t *testing.T) {
	a, s := testApp(t)
	token, _ := bootstrapOwner(t, a)
	owner, _ := s.Authenticate(t.Context(), token)
	other, err := s.CreateAccount(t.Context(), owner.UUID, "recovery-other", "fixture-hash", false)
	if err != nil {
		t.Fatal(err)
	}
	otherSession, err := s.issueSession(t.Context(), other, false)
	if err != nil {
		t.Fatal(err)
	}
	keys := map[string][]byte{}
	for _, name := range []string{"invitation.key", "plex.key"} {
		path := filepath.Join(s.dataDir, name)
		content, e := os.ReadFile(path)
		if errors.Is(e, os.ErrNotExist) {
			content = []byte("01234567890123456789012345678901")
			if e = os.WriteFile(path, content, 0600); e != nil {
				t.Fatal(e)
			}
		} else if e != nil {
			t.Fatal(e)
		}
		keys[name] = content
	}
	expected, err := ownerRecoverySnapshot(t.Context(), s)
	if err != nil {
		t.Fatal(err)
	}
	replacement, err := hashPassword("recovered-owner-fixture-password")
	if err != nil {
		t.Fatal(err)
	}
	if err = commitOwnerRecovery(t.Context(), s, expected, replacement); err != nil {
		t.Fatal(err)
	}
	if _, err = s.Authenticate(t.Context(), token); err == nil {
		t.Fatal("old owner session survived")
	}
	if _, err = s.Authenticate(t.Context(), otherSession.Access); err != nil {
		t.Fatal("other local session revoked", err)
	}
	var hash, username string
	var active bool
	if err = s.reader.QueryRow("SELECT password_hash,local_username,is_active FROM user_accounts WHERE uuid=?", owner.UUID).Scan(&hash, &username, &active); err != nil || !verifyPassword(hash, "recovered-owner-fixture-password") || username != expected.username || !active {
		t.Fatal("owner identity/state changed", err)
	}
	var audit string
	if err = s.reader.QueryRow("SELECT details FROM audit_events WHERE action='account.owner.recover'").Scan(&audit); err != nil || strings.Contains(audit, "password") || strings.Contains(audit, "pbkdf2") {
		t.Fatal(audit, err)
	}
	for name, expected := range keys {
		actual, e := os.ReadFile(filepath.Join(s.dataDir, name))
		if e != nil || string(actual) != string(expected) {
			t.Fatal("recovery rewrote encryption key", name, e)
		}
	}
	if err = commitOwnerRecovery(t.Context(), s, expected, replacement); !errors.Is(err, ErrConflict) {
		t.Fatal("stale recovery proof replayed", err)
	}
}
func TestOfflineOwnerRecoveryRechecksStateAndRollsBackAuditFailure(t *testing.T) {
	for _, mode := range []string{"credential ABA", "profile", "audit rollback"} {
		t.Run(mode, func(t *testing.T) {
			a, s := testApp(t)
			token, _ := bootstrapOwner(t, a)
			owner, _ := s.Authenticate(t.Context(), token)
			p, err := ownerRecoverySnapshot(t.Context(), s)
			if err != nil {
				t.Fatal(err)
			}
			replacement, err := hashPassword("recovered-owner-fixture-password")
			if err != nil {
				t.Fatal(err)
			}
			switch mode {
			case "credential ABA":
				if _, err = s.writer.Exec("UPDATE user_accounts SET force_password_change=1 WHERE uuid=?; UPDATE user_accounts SET force_password_change=0 WHERE uuid=?", owner.UUID, owner.UUID); err != nil {
					t.Fatal(err)
				}
			case "profile":
				if _, err = s.writer.Exec("UPDATE user_accounts SET profile_revision=profile_revision+1 WHERE uuid=?", owner.UUID); err != nil {
					t.Fatal(err)
				}
			case "audit rollback":
				if _, err = s.writer.Exec("CREATE TRIGGER reject_owner_recovery BEFORE INSERT ON audit_events WHEN NEW.action='account.owner.recover' BEGIN SELECT RAISE(ABORT,'fixture'); END"); err != nil {
					t.Fatal(err)
				}
			}
			before := credentialState(t, s, owner.UUID)
			if err = commitOwnerRecovery(t.Context(), s, p, replacement); err == nil || credentialState(t, s, owner.UUID) != before {
				t.Fatal("recovery partially committed", err)
			}
		})
	}
}
func TestRecoveryTerminalInputIsBoundedAndCanceled(t *testing.T) {
	for _, tc := range []struct {
		name, input string
		limit       int
		want        string
		invalid     bool
	}{
		{"line", "secret-value\r", 32, "secret-value", false}, {"unicode", "é-secret-value\n", 32, "é-secret-value", false},
		{"backspace", "secret-x" + string(byte(127)) + "value\n", 32, "secret-value", false},
		{"cancel", string(byte(3)), 32, "", true}, {"eof", string(byte(4)), 32, "", true},
		{"overlong", strings.Repeat("x", 1025) + "\n", 1024, "", true}, {"control", "bad" + string(byte(27)) + "\n", 32, "", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			cr := false
			b, err := readRecoveryLine(context.Background(), strings.NewReader(tc.input), &cr, tc.limit)
			defer clear(b)
			if tc.invalid {
				if err == nil {
					t.Fatal("accepted invalid input")
				}
			} else if err != nil || string(b) != tc.want {
				t.Fatal("terminal decoding mismatch", err)
			}
		})
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	cr := false
	if _, err := readRecoveryLine(ctx, strings.NewReader("secret\n"), &cr, 32); err == nil {
		t.Fatal("canceled input accepted")
	}
	cr = false
	reader := strings.NewReader("RECOVER\r\nsecret-value\r\n")
	first, err := readRecoveryLine(context.Background(), reader, &cr, 32)
	if err != nil || string(first) != "RECOVER" {
		t.Fatal(err)
	}
	second, err := readRecoveryLine(context.Background(), reader, &cr, 32)
	if err != nil || string(second) != "secret-value" {
		t.Fatal(err)
	}
}

func TestRecoveryRefusesNonregularFilesAndUnconfiguredOwner(t *testing.T) {
	directory := t.TempDir()
	if err := os.Mkdir(filepath.Join(directory, ".mum.lock"), 0700); err != nil {
		t.Fatal(err)
	}
	if s, err := OpenStore(t.Context(), filepath.Join(directory, "mum.sqlite")); err == nil {
		if s != nil {
			s.Close()
		}
		t.Fatal("nonregular lock accepted")
	}
	path := filepath.Join(t.TempDir(), "mum.sqlite")
	s, err := OpenStore(t.Context(), path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = ownerRecoverySnapshot(t.Context(), s); err == nil {
		t.Fatal("recovery creates an owner")
	}
	s.Close()
	directoryPath := filepath.Join(t.TempDir(), "database-directory")
	if err = os.Mkdir(directoryPath, 0700); err != nil {
		t.Fatal(err)
	}
	if opened, err := OpenStore(t.Context(), directoryPath); err == nil {
		if opened != nil {
			opened.Close()
		}
		t.Fatal("directory accepted as database")
	}
}
