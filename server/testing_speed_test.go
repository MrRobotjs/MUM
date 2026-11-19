package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"testing"
)

// Test-only speed-ups. Neither changes what the
// application does; both apply only inside the test binary.
//
//  1. Passwords are hashed with a low PBKDF2 cost. Tests check that hashing
//     and checking agree and that hashes are never exposed, not how slow they
//     are; the application keeps 600,000 iterations.
//  2. Each test database is a copy of one database migrated once per run,
//     instead of applying every migration again. OpenStore still opens the
//     copy and verifies every migration checksum. Tests of migrations
//     themselves build their own databases and are unaffected.

const testPasswordIterations = 1_000

func init() { passwordIterations = testPasswordIterations }

var migratedTemplateDB struct {
	once sync.Once
	dir  string
	body []byte
	err  error
}

func TestMain(m *testing.M) {
	code := m.Run()
	if migratedTemplateDB.dir != "" {
		_ = os.RemoveAll(migratedTemplateDB.dir)
	}
	os.Exit(code)
}

// copyMigratedTemplate writes a fully migrated, empty database to path.
func copyMigratedTemplate(path string) error {
	migratedTemplateDB.once.Do(func() {
		dir, err := os.MkdirTemp("", "mum-test-template-")
		if err != nil {
			migratedTemplateDB.err = err
			return
		}
		migratedTemplateDB.dir = dir
		source := filepath.Join(dir, "template.sqlite")
		s, err := OpenStore(context.Background(), source)
		if err != nil {
			migratedTemplateDB.err = err
			return
		}
		_, err = s.writer.Exec("PRAGMA wal_checkpoint(TRUNCATE)")
		if err = errors.Join(err, s.Close()); err != nil {
			migratedTemplateDB.err = err
			return
		}
		// Everything must be in the main file, or a copy of it alone would be incomplete.
		if info, err := os.Stat(source + "-wal"); err == nil && info.Size() > 0 {
			migratedTemplateDB.err = fmt.Errorf("template database left %d bytes in its write-ahead log", info.Size())
			return
		}
		migratedTemplateDB.body, migratedTemplateDB.err = os.ReadFile(source)
	})
	if migratedTemplateDB.err != nil {
		return migratedTemplateDB.err
	}
	return os.WriteFile(path, migratedTemplateDB.body, 0600)
}
