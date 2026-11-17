package main

import (
	"crypto/sha256"
	"database/sql"
	"fmt"
	"path/filepath"
	"testing"
	"time"
)

// Plays and run status imported from Plex before the shared store existed
// move into it unchanged, posters included, and the Plex tables are gone.
func TestHistoryImportsMigrationKeepsPlexRows(t *testing.T) {
	path := filepath.Join(t.TempDir(), "mum.db")
	db, err := sql.Open("sqlite", sqliteDSN(path, false))
	if err != nil {
		t.Fatal(err)
	}
	db.SetMaxOpenConns(1)
	if _, err = db.Exec("PRAGMA foreign_keys=ON"); err != nil {
		t.Fatal(err)
	}
	if _, err = db.Exec("CREATE TABLE schema_migrations (version TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)"); err != nil {
		t.Fatal(err)
	}
	files, err := migrationFiles.ReadDir("go_migrations")
	if err != nil {
		t.Fatal(err)
	}
	for _, file := range files {
		if file.Name() >= "076" {
			break
		}
		body, err := migrationFiles.ReadFile("go_migrations/" + file.Name())
		if err != nil {
			t.Fatal(err)
		}
		if _, err = db.Exec(string(body)); err != nil {
			t.Fatal(file.Name(), err)
		}
		if _, err = db.Exec("INSERT INTO schema_migrations VALUES(?,?,?)", file.Name(), fmt.Sprintf("%x", sha256.Sum256(body)), utcTimestamp(time.Now())); err != nil {
			t.Fatal(err)
		}
	}
	for _, statement := range []string{
		"INSERT INTO media_servers(id,server_nickname,service_type,url) VALUES(1,'Plex','plex','http://plex.invalid')",
		`INSERT INTO plex_history_imports(server_id,history_key,account_id,viewed_at,media_type,rating_key,library_section_id,title,parent_title,grandparent_title,imported_at,poster_item,poster_path)
		 VALUES(1,'/h/1','42','2024-04-30T18:00:00.000000000Z','episode','7','3','Pilot','Season 1','A Show','2026-11-16T00:00:00.000000000Z','5','/library/metadata/5/thumb/1')`,
		"INSERT INTO plex_history_import_runs(server_id,state,started_at,finished_at,total,read_count,added,already_stored,already_recorded,unknown_accounts) VALUES(1,'completed','2026-11-16T00:00:00.000000000Z','2026-11-16T00:01:00.000000000Z',9,9,5,2,1,1)",
	} {
		if _, err = db.Exec(statement); err != nil {
			t.Fatal(statement, err)
		}
	}
	if err = db.Close(); err != nil {
		t.Fatal(err)
	}
	s, err := OpenStore(t.Context(), path)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	var key, account, viewed, kind, item, library, title, parent, grandparent, posterItem, posterPath string
	if err := s.reader.QueryRow(`SELECT entry_key,account_id,viewed_at,media_type,item_id,library_id,title,parent_title,grandparent_title,poster_item,poster_path FROM history_imports WHERE server_id=1`).
		Scan(&key, &account, &viewed, &kind, &item, &library, &title, &parent, &grandparent, &posterItem, &posterPath); err != nil {
		t.Fatal(err)
	}
	if key != "/h/1" || account != "42" || viewed != "2024-04-30T18:00:00.000000000Z" || kind != "episode" || item != "7" || library != "3" || title != "Pilot" ||
		parent != "Season 1" || grandparent != "A Show" || posterItem != "5" || posterPath != "/library/metadata/5/thumb/1" {
		t.Fatal("moved play", key, account, viewed, kind, item, library, title, parent, grandparent, posterItem, posterPath)
	}
	var state string
	var total, read, added, stored, recorded, unknown int
	if err := s.reader.QueryRow("SELECT state,total,read_count,added,already_stored,already_recorded,unknown_accounts FROM history_import_runs WHERE server_id=1").
		Scan(&state, &total, &read, &added, &stored, &recorded, &unknown); err != nil {
		t.Fatal(err)
	}
	if state != "completed" || total != 9 || read != 9 || added != 5 || stored != 2 || recorded != 1 || unknown != 1 {
		t.Fatal("moved run", state, total, read, added, stored, recorded, unknown)
	}
	var left int
	if err := s.reader.QueryRow("SELECT count(*) FROM sqlite_master WHERE name IN ('plex_history_imports','plex_history_import_runs')").Scan(&left); err != nil || left != 0 {
		t.Fatal("Plex tables left", left, err)
	}
}
