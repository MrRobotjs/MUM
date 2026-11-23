package main

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"
)

// The single writer is reserved throughout this parent-table rebuild; checks run before commit.
func (s *Store) migrateServerNicknames(ctx context.Context) (err error) {
	const version = "094_provider_server_nicknames.sql"
	body, err := migrationFiles.ReadFile("go_migrations/" + version)
	if err != nil {
		return err
	}
	conn, err := s.writer.Conn(ctx)
	if err != nil {
		return err
	}
	defer conn.Close()
	if _, err = conn.ExecContext(ctx, "PRAGMA foreign_keys=OFF"); err != nil {
		return err
	}
	defer func() {
		_, e := conn.ExecContext(context.Background(), "PRAGMA foreign_keys=ON")
		err = errors.Join(err, e)
	}()
	tx, err := conn.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	rows, err := tx.QueryContext(ctx, `SELECT name,sql FROM sqlite_schema WHERE type='trigger' AND sql IS NOT NULL AND (tbl_name='media_servers' OR lower(sql) LIKE '%media_servers%') ORDER BY name`)
	if err != nil {
		return err
	}
	var names, statements []string
	for rows.Next() {
		var n, q string
		if err = rows.Scan(&n, &q); err != nil {
			break
		}
		names = append(names, n)
		statements = append(statements, q)
	}
	if err = errors.Join(err, rows.Err(), rows.Close()); err != nil {
		return err
	}
	for _, n := range names {
		if _, err = tx.ExecContext(ctx, `DROP TRIGGER "`+strings.ReplaceAll(n, `"`, `""`)+`"`); err != nil {
			return err
		}
	}
	if _, err = tx.ExecContext(ctx, string(body)); err != nil {
		return fmt.Errorf("migration %s: %w", version, err)
	}
	for _, q := range statements {
		if _, err = tx.ExecContext(ctx, q); err != nil {
			return err
		}
	}
	rows, err = tx.QueryContext(ctx, "PRAGMA foreign_key_check")
	if err != nil {
		return err
	}
	if rows.Next() {
		rows.Close()
		return errors.New("server nickname migration violated foreign keys")
	}
	if err = errors.Join(rows.Err(), rows.Close()); err != nil {
		return err
	}
	if _, err = tx.ExecContext(ctx, "INSERT INTO schema_migrations VALUES(?,?,?)", version, migrationChecksum(body), utcTimestamp(time.Now())); err != nil {
		return err
	}
	return tx.Commit()
}
