package main

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"embed"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	_ "modernc.org/sqlite"
)

//go:embed go_migrations/*.sql
var migrationFiles embed.FS

// Store owns the only writable connection pool. Callers must not open another
// writable handle to this file. Read queries use a separate query-only pool.
type Store struct {
	writer        *sql.DB
	reader        *sql.DB
	dataDir       string
	secretsMu     sync.Mutex
	directoryLock *dataDirectoryLock
}

func sqliteDSN(path string, readOnly bool) string {
	path = filepath.ToSlash(path)
	if !strings.HasPrefix(path, "/") {
		path = "/" + path // A Windows drive path in a file URI.
	}
	u := url.URL{Scheme: "file", Path: path}
	q := url.Values{}
	q.Set("mode", "rwc")
	for _, pragma := range []string{"busy_timeout(5000)", "foreign_keys(ON)", "synchronous(NORMAL)"} {
		q.Add("_pragma", pragma)
	}
	if readOnly {
		q.Set("mode", "ro")
		q.Add("_pragma", "query_only(ON)")
		// Each reader has its own cache; keep four readers within 64 MiB.
		q.Add("_pragma", "cache_size(-16000)")
	} else {
		q.Add("_pragma", "cache_size(-64000)")
	}
	u.RawQuery = q.Encode()
	return u.String()
}

// OpenStore opens a disk-backed database and verifies/applies embedded migrations.
// Existing Flask databases are rejected, never upgraded implicitly in place.
func OpenStore(ctx context.Context, path string) (*Store, error) { return openStore(ctx, path, false) }

// Recovery requires an existing fully current Go schema; it never creates or migrates a database.
func OpenRecoveryStore(ctx context.Context, path string) (*Store, error) {
	return openStore(ctx, path, true)
}
func openStore(ctx context.Context, path string, recovery bool) (_ *Store, err error) {
	if path == "" || path == ":memory:" {
		return nil, errors.New("a disk-backed database path is required")
	}
	absolute, err := filepath.Abs(path)
	if err != nil {
		return nil, err
	}
	info, e := os.Lstat(absolute)
	if e == nil && !info.Mode().IsRegular() {
		return nil, errors.New("database must be a regular file, not a link")
	}
	if e != nil && !errors.Is(e, os.ErrNotExist) {
		return nil, e
	}
	if recovery && e != nil {
		return nil, e
	}
	if !recovery {
		if err = os.MkdirAll(filepath.Dir(absolute), 0700); err != nil {
			return nil, err
		}
	}

	directory, err := filepath.EvalSymlinks(filepath.Dir(absolute))
	if err != nil {
		return nil, err
	}
	absolute = filepath.Join(directory, filepath.Base(absolute))
	lock, err := lockDataDirectory(directory)
	if err != nil {
		return nil, err
	}
	dsn := sqliteDSN(absolute, false)
	if recovery {
		dsn = strings.Replace(dsn, "mode=rwc", "mode=rw", 1)
	}
	writer, err := sql.Open("sqlite", dsn)
	if err != nil {
		lock.Close()
		return nil, err
	}
	s := &Store{writer: writer, dataDir: filepath.Dir(absolute), directoryLock: lock}
	defer func() {
		if err != nil {
			_ = s.Close()
		}
	}()
	writer.SetMaxOpenConns(1)
	writer.SetMaxIdleConns(1)
	if err = writer.PingContext(ctx); err != nil {
		return nil, fmt.Errorf("open writer: %w", err)
	}
	// Check before setting persistent WAL mode so legacy source databases are not changed.
	var count, versioned int
	if err = writer.QueryRowContext(ctx, `SELECT count(*), count(CASE WHEN name='schema_migrations' THEN 1 END)
		FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'`).Scan(&count, &versioned); err != nil {
		return nil, err
	}
	if count > 0 && versioned == 0 {
		return nil, errors.New("unrecognized database: select a new Go application data directory")
	}
	if recovery {
		if err = s.verifyCurrentSchema(ctx); err != nil {
			return nil, err
		}
	}
	var journal string
	journalQuery := "PRAGMA journal_mode=WAL"
	if recovery {
		journalQuery = "PRAGMA journal_mode"
	}
	if err = writer.QueryRowContext(ctx, journalQuery).Scan(&journal); err != nil {
		return nil, err
	}
	if !strings.EqualFold(journal, "wal") {
		return nil, fmt.Errorf("SQLite refused WAL mode: %s", journal)
	}
	if !recovery {
		if err = s.migrate(ctx); err != nil {
			return nil, err
		}
	}
	s.reader, err = sql.Open("sqlite", sqliteDSN(absolute, true))
	if err != nil {
		return nil, err
	}
	s.reader.SetMaxOpenConns(4)
	s.reader.SetMaxIdleConns(4)
	if err = s.reader.PingContext(ctx); err != nil {
		return nil, fmt.Errorf("open reader: %w", err)
	}
	return s, nil
}

func (s *Store) Close() error {
	var readErr, writeErr error
	if s.reader != nil {
		readErr = s.reader.Close()
	}
	if s.writer != nil {
		writeErr = s.writer.Close()
	}
	return errors.Join(readErr, writeErr, s.directoryLock.Close())
}

func (s *Store) write(ctx context.Context, action func(*sql.Tx) error) error {
	tx, err := s.writer.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := action(tx); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Store) migrate(ctx context.Context) error {
	files, err := migrationFiles.ReadDir("go_migrations")
	if err != nil {
		return err
	}
	return s.write(ctx, func(tx *sql.Tx) error {
		if _, err := tx.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS schema_migrations (
			version TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)`); err != nil {
			return err
		}
		rows, err := tx.QueryContext(ctx, "SELECT version, checksum FROM schema_migrations ORDER BY version")
		if err != nil {
			return err
		}
		applied := make(map[string]string)
		for rows.Next() {
			var version, checksum string
			if err := rows.Scan(&version, &checksum); err != nil {
				rows.Close()
				return err
			}
			applied[version] = checksum
		}
		err = errors.Join(rows.Err(), rows.Close())
		if err != nil {
			return err
		}
		known := make(map[string]bool)
		for _, file := range files {
			known[file.Name()] = true
		}
		for version := range applied {
			if !known[version] {
				return fmt.Errorf("database has unsupported migration %q", version)
			}
		}
		missing := false
		for _, file := range files {
			body, err := migrationFiles.ReadFile("go_migrations/" + file.Name())
			if err != nil {
				return err
			}
			checksum := fmt.Sprintf("%x", sha256.Sum256(body))
			if previous, ok := applied[file.Name()]; ok {
				if previous != checksum || missing {
					return fmt.Errorf("migration %s has changed or its history has a gap", file.Name())
				}
				continue
			}
			missing = true
			if _, err := tx.ExecContext(ctx, string(body)); err != nil {
				return fmt.Errorf("migration %s: %w", file.Name(), err)
			}
			if _, err := tx.ExecContext(ctx, "INSERT INTO schema_migrations VALUES (?, ?, ?)", file.Name(), checksum, utcTimestamp(time.Now())); err != nil {
				return err
			}
		}
		return nil
	})
}

// Fixed fractional width preserves lexical ordering for newly stored UTC times.
func utcTimestamp(t time.Time) string { return t.UTC().Format("2006-01-02T15:04:05.000000000Z") }

// CheckIntegrity checks both structural integrity and referential integrity.
func (s *Store) CheckIntegrity(ctx context.Context) error {
	rows, err := s.reader.QueryContext(ctx, "PRAGMA integrity_check")
	if err != nil {
		return err
	}
	for rows.Next() {
		var result string
		if err := rows.Scan(&result); err != nil {
			rows.Close()
			return err
		}
		if result != "ok" {
			rows.Close()
			return fmt.Errorf("integrity check: %s", result)
		}
	}
	if err := errors.Join(rows.Err(), rows.Close()); err != nil {
		return err
	}
	rows, err = s.reader.QueryContext(ctx, "PRAGMA foreign_key_check")
	if err != nil {
		return err
	}
	defer rows.Close()
	if rows.Next() {
		return errors.New("foreign key check failed")
	}
	return rows.Err()
}

func (s *Store) verifyCurrentSchema(ctx context.Context) error {
	files, err := migrationFiles.ReadDir("go_migrations")
	if err != nil {
		return err
	}
	rows, err := s.writer.QueryContext(ctx, "SELECT version,checksum FROM schema_migrations ORDER BY version")
	if err != nil {
		return errors.New("recovery requires an existing current Go database")
	}
	defer rows.Close()
	i := 0
	for rows.Next() {
		var version, checksum string
		if err = rows.Scan(&version, &checksum); err != nil {
			return err
		}
		if i >= len(files) || version != files[i].Name() {
			return errors.New("recovery requires the fully current migration history")
		}
		body, e := migrationFiles.ReadFile("go_migrations/" + version)
		if e != nil {
			return e
		}
		if checksum != fmt.Sprintf("%x", sha256.Sum256(body)) {
			return errors.New("recovery refuses a changed migration checksum")
		}
		i++
	}
	if err = rows.Err(); err != nil {
		return err
	}
	if i != len(files) {
		return errors.New("start the normal runtime to apply current migrations before owner recovery")
	}
	return nil
}
