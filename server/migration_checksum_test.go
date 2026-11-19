package main

import (
	"crypto/sha256"
	"fmt"
	"path/filepath"
	"strings"
	"testing"
)

// The fingerprint covers statements only: comments, blank lines and line
// endings don't change it; any change to the SQL does.
func TestMigrationChecksumCoversSQLOnly(t *testing.T) {
	base := migrationChecksum([]byte("-- A table.\nCREATE TABLE t(a INTEGER);\n"))
	same := []string{
		"-- A table, reworded.\n-- Over two lines.\nCREATE TABLE t(a INTEGER);\n",
		"CREATE TABLE t(a INTEGER);",
		"-- A table.\r\n\r\nCREATE TABLE t(a INTEGER);  \r\n",
		"  -- indented comment\nCREATE TABLE t(a INTEGER);\n",
	}
	for _, body := range same {
		if got := migrationChecksum([]byte(body)); got != base {
			t.Fatalf("%q: %s != %s", body, got, base)
		}
	}
	for _, body := range []string{"CREATE TABLE t(a TEXT);", "CREATE TABLE t(a INTEGER);\nDROP TABLE t;", "CREATE TABLE t(a INTEGER); -- trailing note"} {
		if migrationChecksum([]byte(body)) == base {
			t.Fatalf("%q matched", body)
		}
	}
	if !strings.HasPrefix(base, migrationChecksumPrefix) {
		t.Fatal(base)
	}
}

// Stored fingerprints: the current one, the earlier whole-file one with
// either line ending, and a reworded migration's earlier wording. Anything
// else, including another file's fingerprint, is refused.
func TestMigrationAppliedAcceptsEarlierFingerprints(t *testing.T) {
	body := []byte("-- note\r\nCREATE TABLE t(a INTEGER);\r\n")
	whole := func(b string) string { return fmt.Sprintf("%x", sha256.Sum256([]byte(b))) }
	for _, stored := range []string{migrationChecksum(body), whole(string(body)), whole(strings.ReplaceAll(string(body), "\r\n", "\n"))} {
		if !migrationApplied("900_test.sql", stored, body) {
			t.Fatal("refused", stored)
		}
	}
	for _, stored := range []string{"changed", migrationChecksumPrefix + whole("x"), whole("CREATE TABLE t(a TEXT);"), rewordedMigrations["074_purge.sql"][0]} {
		if migrationApplied("900_test.sql", stored, body) {
			t.Fatal("accepted", stored)
		}
	}
	// Every reworded migration's earlier fingerprints are accepted for that
	// migration, its SQL is unchanged, and they're refused for another one.
	for version, earlier := range rewordedMigrations {
		current, err := migrationFiles.ReadFile("go_migrations/" + version)
		if err != nil {
			t.Fatal(version, err)
		}
		for _, stored := range earlier {
			if !migrationApplied(version, stored, current) || migrationApplied("001_identity.sql", stored, current) {
				t.Fatal(version, stored)
			}
		}
	}
}

// A database holding earlier fingerprints (whole-file ones, and a reworded
// migration's earlier wording) opens, and its fingerprints are replaced by
// current ones; a changed statement is still refused.
func TestMigrationEarlierFingerprintsUpgradeOnOpen(t *testing.T) {
	path := filepath.Join(t.TempDir(), "app.sqlite")
	s, err := OpenStore(t.Context(), path)
	if err != nil {
		t.Fatal(err)
	}
	files, err := migrationFiles.ReadDir("go_migrations")
	if err != nil {
		t.Fatal(err)
	}
	for _, file := range files {
		body, err := migrationFiles.ReadFile("go_migrations/" + file.Name())
		if err != nil {
			t.Fatal(err)
		}
		stored := fmt.Sprintf("%x", sha256.Sum256(body))
		if earlier, ok := rewordedMigrations[file.Name()]; ok {
			stored = earlier[1]
		}
		if _, err = s.writer.Exec("UPDATE schema_migrations SET checksum=? WHERE version=?", stored, file.Name()); err != nil {
			t.Fatal(err)
		}
	}
	if err = s.Close(); err != nil {
		t.Fatal(err)
	}
	if s, err = OpenStore(t.Context(), path); err != nil {
		t.Fatal("refused earlier fingerprints:", err)
	}
	var earlier int
	if err = s.reader.QueryRow("SELECT count(*) FROM schema_migrations WHERE checksum NOT LIKE 'sql:%'").Scan(&earlier); err != nil || earlier != 0 {
		t.Fatal("earlier fingerprints left", earlier, err)
	}
	// Owner recovery reads the history too and accepts the current fingerprints.
	if err = s.verifyCurrentSchema(t.Context()); err != nil {
		t.Fatal(err)
	}
	if _, err = s.writer.Exec("UPDATE schema_migrations SET checksum=? WHERE version='074_purge.sql'", migrationChecksum([]byte("CREATE TABLE other(x);"))); err != nil {
		t.Fatal(err)
	}
	if err = s.Close(); err != nil {
		t.Fatal(err)
	}
	if s, err = OpenStore(t.Context(), path); err == nil {
		s.Close()
		t.Fatal("accepted a changed migration")
	}
}
