//go:build legacyimport

package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"sort"
	"strings"
	"time"
)

// Snapshot is an offline export format, not an API payload. It contains secrets
// from the source database and must be handled like a complete database backup.
type Snapshot struct {
	Version        int                         `json:"version"`
	SourceEngine   string                      `json:"source_engine"`
	SourceRevision string                      `json:"source_revision"`
	Tables         map[string][]map[string]any `json:"tables"`
}

type ImportReport struct {
	RunID          string         `json:"run_id"`
	SourceChecksum string         `json:"source_checksum"`
	SourceRows     map[string]int `json:"source_rows"`
	TargetRows     map[string]int `json:"target_rows"`
	ArchivedRows   int            `json:"archived_rows"`
}

var importTables = map[string]string{
	"users": "", "admins_roles": "admin_roles", "admin_permissions": "admin_permissions",
	"admin_role_permissions": "admin_role_permissions", "admin_user_roles_assignments": "admin_privileges",
	"users_roles": "user_roles", "users_roles_assignments": "identity_user_roles",
	"media_servers": "media_servers", "media_libraries": "media_libraries", "media_items": "media_items",
	"media_stream_history": "media_stream_history", "invites": "invites", "invite_servers": "invite_servers",
	"invite_usages": "invite_usages", "invite_server_features": "invite_server_features", "settings": "settings",
	"notifications": "notifications", "user_preferences": "user_preferences", "plugins": "plugins",
	"plugin_repositories": "plugin_repositories", "overseerr_user_links": "overseerr_user_links",
	"token_blocklist": "token_blocklist", "history_logs": "", "alembic_version": "",
}

func quoteIdentifier(s string) string { return `"` + strings.ReplaceAll(s, `"`, `""`) + `"` }

func sourceString(row map[string]any, key string) string { v, _ := row[key].(string); return v }

// ImportSnapshot requires an empty, newly migrated destination. It never opens
// the source database. All rows and their original representations commit in a
// single transaction after FK checks. No report includes credential values.
func (s *Store) ImportSnapshot(ctx context.Context, r io.Reader) (*ImportReport, error) {
	const maximum = 256 << 20
	body, err := io.ReadAll(io.LimitReader(r, maximum+1))
	if err != nil {
		return nil, err
	}
	if len(body) > maximum {
		return nil, errors.New("snapshot exceeds 256 MiB limit")
	}
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.UseNumber()
	decoder.DisallowUnknownFields()
	var snapshot Snapshot
	if err := decoder.Decode(&snapshot); err != nil {
		return nil, fmt.Errorf("decode snapshot: %w", err)
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		return nil, errors.New("snapshot must contain exactly one JSON document")
	}
	if snapshot.Version != 1 || (snapshot.SourceEngine != "sqlite" && snapshot.SourceEngine != "postgresql") || len(snapshot.Tables) == 0 {
		return nil, errors.New("unsupported or empty snapshot")
	}
	for table := range snapshot.Tables {
		if _, ok := importTables[table]; !ok {
			return nil, fmt.Errorf("unsupported source table %q", table)
		}
	}
	report := &ImportReport{RunID: newUUID(), SourceChecksum: fmt.Sprintf("%x", sha256.Sum256(body)), SourceRows: make(map[string]int), TargetRows: make(map[string]int)}
	err = s.write(ctx, func(tx *sql.Tx) error {
		// Deferred FK checks allow source cycles (users <-> invites) and table order.
		if _, err := tx.ExecContext(ctx, "PRAGMA defer_foreign_keys=ON"); err != nil {
			return err
		}
		rows, err := tx.QueryContext(ctx, "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name!='schema_migrations'")
		if err != nil {
			return err
		}
		var destinationTables []string
		for rows.Next() {
			var name string
			if err := rows.Scan(&name); err != nil {
				rows.Close()
				return err
			}
			destinationTables = append(destinationTables, name)
		}
		if err := errors.Join(rows.Err(), rows.Close()); err != nil {
			return err
		}
		for _, name := range destinationTables {
			var count int
			if err := tx.QueryRowContext(ctx, "SELECT count(*) FROM "+quoteIdentifier(name)).Scan(&count); err != nil {
				return err
			}
			if count != 0 {
				return errors.New("import requires an empty destination")
			}
		}
		columns := make(map[string]map[string]bool)
		for _, table := range destinationTables {
			info, err := tx.QueryContext(ctx, "PRAGMA table_info("+quoteIdentifier(table)+")")
			if err != nil {
				return err
			}
			columns[table] = make(map[string]bool)
			for info.Next() {
				var cid, notnull, pk int
				var name, typ string
				var dflt any
				if err := info.Scan(&cid, &name, &typ, &notnull, &dflt, &pk); err != nil {
					info.Close()
					return err
				}
				columns[table][name] = true
			}
			if err := errors.Join(info.Err(), info.Close()); err != nil {
				return err
			}
		}
		tables := make([]string, 0, len(snapshot.Tables))
		for table := range snapshot.Tables {
			tables = append(tables, table)
		}
		sort.Strings(tables)
		for _, table := range tables {
			records := snapshot.Tables[table]
			report.SourceRows[table] = len(records)
			for ordinal, row := range records {
				original, err := json.Marshal(row)
				if err != nil {
					return fmt.Errorf("source %s row %d cannot be encoded", table, ordinal)
				}
				if _, err := tx.ExecContext(ctx, "INSERT INTO legacy_records VALUES(?,?,?)", table, ordinal, string(original)); err != nil {
					return err
				}
				report.ArchivedRows++
				target := importTables[table]
				if table == "users" {
					if err := importIdentity(ctx, tx, row, original, columns); err != nil {
						return fmt.Errorf("source users row %d: %w", ordinal, err)
					}
					continue
				}
				if target == "" {
					continue
				}
				mapped := make(map[string]any, len(row))
				for k, v := range row {
					mapped[k] = v
				}
				switch table {
				case "plugins":
					if _, exists := mapped["entry_class"]; !exists {
						mapped["entry_class"] = mapped["service_class"]
					}
					if _, exists := mapped["enabled_by_user"]; !exists {
						mapped["enabled_by_user"] = strings.EqualFold(sourceString(row, "status"), "enabled")
					}
				case "admin_user_roles_assignments":
					mapped["user_uuid"] = mapped["user_id"]
					delete(mapped, "user_id")
				case "users_roles_assignments":
					mapped["user_uuid"] = mapped["user_id"]
					mapped["role_id"] = mapped["visual_role_id"]
					delete(mapped, "user_id")
					delete(mapped, "visual_role_id")
				}
				for _, key := range []string{"service_type", "plugin_type", "status", "value_type"} {
					if v, ok := mapped[key].(string); ok {
						mapped[key] = strings.ToLower(v)
					}
				}
				if err := insertRecord(ctx, tx, target, mapped, columns[target]); err != nil {
					return fmt.Errorf("source %s row %d: %w", table, ordinal, err)
				}
			}
		}
		violations, err := tx.QueryContext(ctx, "PRAGMA foreign_key_check")
		if err != nil {
			return err
		}
		hasViolation := violations.Next()
		err = errors.Join(violations.Err(), violations.Close())
		if err != nil {
			return err
		}
		if hasViolation {
			return errors.New("snapshot contains dangling references")
		}
		for _, table := range destinationTables {
			var count int
			if err := tx.QueryRowContext(ctx, "SELECT count(*) FROM "+quoteIdentifier(table)).Scan(&count); err != nil {
				return err
			}
			if count > 0 {
				report.TargetRows[table] = count
			}
		}
		encoded, err := json.Marshal(report)
		if err != nil {
			return err
		}
		_, err = tx.ExecContext(ctx, "INSERT INTO import_runs VALUES(?,?,?,?,?,?)", report.RunID, snapshot.SourceEngine, snapshot.SourceRevision, report.SourceChecksum, string(encoded), utcTimestamp(time.Now()))
		return err
	})
	if err != nil {
		return nil, err
	}
	return report, nil
}

func importIdentity(ctx context.Context, tx *sql.Tx, row map[string]any, original []byte, columns map[string]map[string]bool) error {
	uuid := sourceString(row, "uuid")
	kind := strings.ToLower(sourceString(row, "userType"))
	if uuid == "" || row["id"] == nil || (kind != "owner" && kind != "local" && kind != "service") {
		return errors.New("invalid source identity kind/UUID")
	}
	if err := insertRecord(ctx, tx, "identities", map[string]any{"id": row["id"], "uuid": uuid, "kind": kind}, columns["identities"]); err != nil {
		return err
	}
	mapped := make(map[string]any, len(row))
	for k, v := range row {
		mapped[k] = v
	}
	mapped["kind"] = kind
	mapped["legacy_metadata"] = string(original)
	mapped["local_username"] = row["localUsername"]
	// Nullable historical timestamps are filled only in normalized target columns;
	// original nulls remain available in the immutable source archive.
	for _, key := range []string{"created_at", "updated_at"} {
		if mapped[key] == nil {
			mapped[key] = utcTimestamp(time.Now())
		}
	}
	target := "user_accounts"
	if kind == "service" {
		target = "service_accounts"
	}
	if err := insertRecord(ctx, tx, target, mapped, columns[target]); err != nil {
		return err
	}
	if parent := sourceString(row, "linkedUserId"); parent != "" {
		if kind != "service" {
			return errors.New("only service identities can carry a parent link")
		}
		_, err := tx.ExecContext(ctx, "INSERT INTO service_links(user_uuid,service_uuid,link_kind,created_at) VALUES(?,?,'owner',?)", parent, uuid, utcTimestamp(time.Now()))
		return err
	}
	return nil
}

func insertRecord(ctx context.Context, tx *sql.Tx, table string, row map[string]any, allowed map[string]bool) error {
	keys := make([]string, 0, len(row))
	for key := range row {
		if allowed[key] {
			keys = append(keys, key)
		}
	}
	sort.Strings(keys)
	if len(keys) == 0 {
		return errors.New("record contains no recognized columns")
	}
	quoted := make([]string, len(keys))
	placeholders := make([]string, len(keys))
	values := make([]any, len(keys))
	for i, key := range keys {
		quoted[i] = quoteIdentifier(key)
		placeholders[i] = "?"
		value := row[key]
		if text, ok := value.(string); ok && isTimestampColumn(key) {
			var parsed time.Time
			var err error
			for _, layout := range []string{time.RFC3339Nano, "2006-01-02 15:04:05.999999999Z07:00", "2006-01-02T15:04:05.999999999", "2006-01-02 15:04:05.999999999", "2006-01-02"} {
				parsed, err = time.Parse(layout, text)
				if err == nil {
					break
				}
			}
			if err != nil {
				return fmt.Errorf("invalid timestamp in column %s", key)
			}
			value = utcTimestamp(parsed)
		}
		switch v := value.(type) {
		case json.Number:
			n, err := v.Int64()
			if err == nil {
				value = n
			} else {
				f, err := v.Float64()
				if err != nil {
					return err
				}
				value = f
			}
		case []any, map[string]any:
			encoded, err := json.Marshal(v)
			if err != nil {
				return err
			}
			value = string(encoded)
		}
		values[i] = value
	}
	_, err := tx.ExecContext(ctx, "INSERT INTO "+quoteIdentifier(table)+" ("+strings.Join(quoted, ",")+") VALUES ("+strings.Join(placeholders, ",")+")", values...)
	// Driver errors may include SQL identifiers, never append row or credential values.
	return err
}

func isTimestampColumn(key string) bool {
	if strings.HasSuffix(key, "_at") {
		return true
	}
	switch key {
	case "timestamp", "last_scanned", "last_synced", "last_sync", "last_updated", "last_status_check":
		return true
	}
	return false
}
