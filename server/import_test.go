//go:build legacyimport

package main

import (
	"bytes"
	"encoding/json"
	"testing"
)

func fixtureSnapshot(engine string) Snapshot {
	return Snapshot{Version: 1, SourceEngine: engine, SourceRevision: "fixture", Tables: map[string][]map[string]any{
		"users": {
			{"id": 1, "uuid": "owner", "userType": "OWNER", "localUsername": "Owner", "password_hash": "pbkdf2:sha256:600000$salt$hash", "unknown_future_column": "preserve-me", "created_at": "2026-01-01T10:00:00+02:00"},
			{"id": 2, "uuid": "service", "userType": "SERVICE", "server_id": 7, "external_user_id": "42", "linkedUserId": "owner", "allowed_library_ids": []any{"7::movies"}},
		},
		"media_servers":                {{"id": 7, "server_nickname": "Fixture", "service_type": "JELLYFIN", "url": "http://example.invalid"}},
		"admins_roles":                 {{"id": "role", "name": "Custom admin", "position": 10}},
		"admin_permissions":            {{"id": "perm", "name": "administrator"}},
		"admin_role_permissions":       {{"role_id": "role", "permission_id": "perm"}},
		"admin_user_roles_assignments": {{"user_id": "owner", "role_id": "role"}},
		"plugins":                      {{"id": 1, "plugin_id": "jellyfin", "name": "Jellyfin", "version": "1", "plugin_type": "CORE", "status": "ENABLED", "module_path": "legacy.module", "service_class": "LegacyClass", "supported_features": []any{"users"}}},
		"history_logs":                 {{"id": 1, "message": "retained historical audit record"}},
	}}
}

func encodeSnapshot(t *testing.T, snapshot Snapshot) []byte {
	t.Helper()
	body, err := json.Marshal(snapshot)
	if err != nil {
		t.Fatal(err)
	}
	return body
}

func TestImportPreservesIdentityMetadataRolesAndLinks(t *testing.T) {
	for _, engine := range []string{"sqlite", "postgresql"} {
		t.Run(engine, func(t *testing.T) {
			s := testStore(t)
			snapshot := fixtureSnapshot(engine)
			body := encodeSnapshot(t, snapshot)
			report, err := s.ImportSnapshot(t.Context(), bytes.NewReader(body))
			if err != nil {
				t.Fatal(err)
			}
			if report.SourceRows["users"] != 2 || report.ArchivedRows != 9 {
				t.Fatal(report)
			}
			if report.TargetRows["identities"] != 2 || report.TargetRows["user_accounts"] != 1 || report.TargetRows["service_accounts"] != 1 {
				t.Fatal(report.TargetRows)
			}
			var id int
			var password, metadata string
			if err := s.reader.QueryRow("SELECT i.id,u.password_hash,u.legacy_metadata FROM identities i JOIN user_accounts u ON u.uuid=i.uuid WHERE i.uuid='owner'").Scan(&id, &password, &metadata); err != nil {
				t.Fatal(err)
			}
			if id != 1 || password != "pbkdf2:sha256:600000$salt$hash" {
				t.Fatal("identity/credential changed")
			}
			var created string
			if err := s.reader.QueryRow("SELECT created_at FROM user_accounts WHERE uuid='owner'").Scan(&created); err != nil || created != "2026-01-01T08:00:00.000000000Z" {
				t.Fatal("UTC timestamp normalization", created, err)
			}
			var original map[string]any
			if err := json.Unmarshal([]byte(metadata), &original); err != nil || original["unknown_future_column"] != "preserve-me" {
				t.Fatal("metadata lost", err)
			}
			var parent string
			if err := s.reader.QueryRow("SELECT user_uuid FROM service_links WHERE service_uuid='service'").Scan(&parent); err != nil || parent != "owner" {
				t.Fatal(parent, err)
			}
			var entry string
			var enabled bool
			if err := s.reader.QueryRow("SELECT entry_class,enabled_by_user FROM plugins").Scan(&entry, &enabled); err != nil || entry != "LegacyClass" || !enabled {
				t.Fatal(entry, enabled, err)
			}
			if err := s.CheckIntegrity(t.Context()); err != nil {
				t.Fatal(err)
			}
			if _, err := s.ImportSnapshot(t.Context(), bytes.NewReader(body)); err == nil {
				t.Fatal("reimport into populated destination was accepted")
			}
			// The shared identity allocator must continue above imported service IDs.
			uuid, err := s.CreateAccount(t.Context(), "owner", "new", "encoded", false)
			if err != nil {
				t.Fatal(err)
			}
			if err := s.reader.QueryRow("SELECT id FROM identities WHERE uuid=?", uuid).Scan(&id); err != nil || id <= 2 {
				t.Fatal(id, err)
			}
		})
	}
}

func TestImportFailureRollsBackWholeSnapshot(t *testing.T) {
	for _, failure := range []string{"dangling_link", "duplicate_login", "unknown_table", "duplicate_owner", "invalid_json_column", "missing_id"} {
		t.Run(failure, func(t *testing.T) {
			s := testStore(t)
			snapshot := fixtureSnapshot("sqlite")
			switch failure {
			case "dangling_link":
				snapshot.Tables["users"][1]["linkedUserId"] = "missing"
			case "duplicate_login":
				snapshot.Tables["users"] = append(snapshot.Tables["users"], map[string]any{"id": 3, "uuid": "other", "userType": "LOCAL", "localUsername": "owner"})
			case "unknown_table":
				snapshot.Tables["unrecognized"] = []map[string]any{{"key": "value"}}
			case "duplicate_owner":
				snapshot.Tables["users"] = append(snapshot.Tables["users"], map[string]any{"id": 3, "uuid": "other", "userType": "OWNER", "localUsername": "other"})
			case "invalid_json_column":
				snapshot.Tables["users"][1]["allowed_library_ids"] = "bad JSON"
			case "missing_id":
				delete(snapshot.Tables["users"][0], "id")
			}
			if _, err := s.ImportSnapshot(t.Context(), bytes.NewReader(encodeSnapshot(t, snapshot))); err == nil {
				t.Fatal("invalid snapshot accepted")
			}
			for _, table := range []string{"identities", "media_servers", "admin_roles", "legacy_records", "import_runs"} {
				var count int
				if err := s.reader.QueryRow("SELECT count(*) FROM " + table).Scan(&count); err != nil || count != 0 {
					t.Fatal("partial import", table, count, err)
				}
			}
		})
	}
}
