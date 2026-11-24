package main

import (
	"crypto/sha256"
	"database/sql"
	"fmt"
	"path/filepath"
	"sort"
	"strings"
	"testing"
)

func TestFreshMigrationBaselineAndWholeFileChecksum(t *testing.T) {
	files, err := migrationFiles.ReadDir("go_migrations")
	if err != nil {
		t.Fatal(err)
	}
	if len(files) < 1 || files[0].Name() != "001_baseline.sql" {
		t.Fatalf("expected a fresh baseline first, got %v", files)
	}
	body, err := migrationFiles.ReadFile("go_migrations/001_baseline.sql")
	if err != nil {
		t.Fatal(err)
	}
	want := fmt.Sprintf("%x", sha256.Sum256(body))
	if got := migrationChecksum(body); got != want {
		t.Fatalf("checksum = %q, want %q", got, want)
	}
	for _, changed := range [][]byte{append([]byte("-- changed comment\n"), body...), append(append([]byte(nil), body...), '\n'), []byte(strings.ReplaceAll(string(body), "\n", "\r\n"))} {
		if migrationChecksum(changed) == want {
			t.Fatal("different migration bytes must change checksum")
		}
	}
}

func TestFreshBaselinePreservesSchemaAndDefaults(t *testing.T) {
	s, err := OpenStore(t.Context(), filepath.Join(t.TempDir(), "app.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	baseline, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer baseline.Close()
	body, err := migrationFiles.ReadFile("go_migrations/001_baseline.sql")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = baseline.Exec(string(body)); err != nil {
		t.Fatal(err)
	}
	rows, err := baseline.Query(`SELECT type,name,sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name != 'schema_migrations'`)
	if err != nil {
		t.Fatal(err)
	}
	var schema []string
	for rows.Next() {
		var typ, name, sql string
		if err := rows.Scan(&typ, &name, &sql); err != nil {
			t.Fatal(err)
		}
		schema = append(schema, typ+"\x00"+name+"\x00"+sql)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	rows.Close()
	sort.Strings(schema)
	got := fmt.Sprintf("%x", sha256.Sum256([]byte(strings.Join(schema, "\x00"))))
	// Captured from the pre-reset migrations after replaying their schema in SQLite.
	const beforeReset = "2fc3604ac0a5c571a43a7314be1af2f0f243434a1542fbae78ffdfe3b8256d71"
	if got != beforeReset {
		t.Fatalf("baseline schema differs from captured pre-reset schema: %s", got)
	}
	if err := s.CheckIntegrity(t.Context()); err != nil {
		t.Fatal(err)
	}
	var roles, providers int
	if err := s.reader.QueryRow(`SELECT count(*) FROM user_roles WHERE is_auto_managed=1`).Scan(&roles); err != nil || roles != 4 {
		t.Fatalf("automatic roles=%d: %v", roles, err)
	}
	if err := s.reader.QueryRow(`SELECT count(*) FROM provider_settings`).Scan(&providers); err != nil || providers != 7 {
		t.Fatalf("providers=%d: %v", providers, err)
	}
	if err := s.verifyCurrentSchema(t.Context()); err != nil {
		t.Fatal(err)
	}
	var firstID string
	if err := s.reader.QueryRow(`SELECT id FROM user_roles WHERE name='Downloads'`).Scan(&firstID); err != nil {
		t.Fatal(err)
	}
	other, err := OpenStore(t.Context(), filepath.Join(t.TempDir(), "other.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer other.Close()
	var secondID string
	if err := other.reader.QueryRow(`SELECT id FROM user_roles WHERE name='Downloads'`).Scan(&secondID); err != nil || firstID == secondID {
		t.Fatalf("role IDs must be independent: %v", err)
	}
}

func TestBaselineRejectsOldHistoryWithoutChangingIt(t *testing.T) {
	path := filepath.Join(t.TempDir(), "app.sqlite")
	s, err := OpenStore(t.Context(), path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.writer.Exec(`UPDATE schema_migrations SET version='001_identity.sql', checksum='sql:legacy' WHERE version='001_baseline.sql'`); err != nil {
		t.Fatal(err)
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	if reopened, err := OpenStore(t.Context(), path); err == nil {
		reopened.Close()
		t.Fatal("accepted old migration history")
	}
	// Reopen the disposable database directly to confirm the rejected history remains intact.
	db, err := sql.Open("sqlite", sqliteDSN(path, true))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	var version, checksum string
	if err := db.QueryRow(`SELECT version,checksum FROM schema_migrations WHERE version='001_identity.sql'`).Scan(&version, &checksum); err != nil || version != "001_identity.sql" || checksum != "sql:legacy" {
		t.Fatalf("history changed: %q %q %v", version, checksum, err)
	}
}

func TestBaselineRejectsAlteredCommentAndLegacyFingerprint(t *testing.T) {
	body, err := migrationFiles.ReadFile("go_migrations/001_baseline.sql")
	if err != nil {
		t.Fatal(err)
	}
	for name, fingerprint := range map[string]string{
		"changed comment": migrationChecksum(append([]byte("-- changed comment\n"), body...)),
		"legacy prefix":   "sql:" + migrationChecksum(body),
	} {
		t.Run(name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "app.sqlite")
			s, err := OpenStore(t.Context(), path)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := s.writer.Exec(`UPDATE schema_migrations SET checksum=?`, fingerprint); err != nil {
				t.Fatal(err)
			}
			if err := s.Close(); err != nil {
				t.Fatal(err)
			}
			if s, err := OpenStore(t.Context(), path); err == nil {
				s.Close()
				t.Fatal("accepted an invalid fingerprint")
			}
			if s, err := OpenRecoveryStore(t.Context(), path); err == nil {
				s.Close()
				t.Fatal("recovery accepted an invalid fingerprint")
			}
		})
	}
}

func TestBaselineRejectsOldHistoryBeforeChangingJournalMode(t *testing.T) {
	path := filepath.Join(t.TempDir(), "old.sqlite")
	db, err := sql.Open("sqlite", sqliteDSN(path, false))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`CREATE TABLE schema_migrations(version TEXT PRIMARY KEY,checksum TEXT NOT NULL,applied_at TEXT NOT NULL);
		INSERT INTO schema_migrations VALUES ('001_identity.sql','sql:old','now');
		CREATE TABLE sentinel(value TEXT); INSERT INTO sentinel VALUES ('preserve');`); err != nil {
		t.Fatal(err)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	if s, err := OpenStore(t.Context(), path); err == nil {
		s.Close()
		t.Fatal("accepted unsupported history")
	}
	db, err = sql.Open("sqlite", sqliteDSN(path, true))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	var mode, value string
	if err := db.QueryRow(`PRAGMA journal_mode`).Scan(&mode); err != nil || mode != "delete" {
		t.Fatalf("journal mode changed: %s %v", mode, err)
	}
	if err := db.QueryRow(`SELECT value FROM sentinel`).Scan(&value); err != nil || value != "preserve" {
		t.Fatalf("data changed: %s %v", value, err)
	}
}
