package main

import (
	"testing"
	"time"
)

// Migration 066 renames the former "bulk" tables to "edit" and relabels their
// audit history without losing receipts, source locks, removed identities or
// the links between them.
func TestEditOperationsMigrationKeepsExistingData(t *testing.T) {
	path, db := openSchemaBefore(t, "066")
	now := utcTimestamp(time.Now())
	for _, statement := range []string{
		"INSERT INTO identities(uuid,kind) VALUES('11111111-1111-1111-1111-111111111111','owner')",
		"INSERT INTO user_accounts(uuid,kind,local_username,created_at,updated_at) VALUES('11111111-1111-1111-1111-111111111111','owner','owner','" + now + "','" + now + "')",
		"INSERT INTO media_servers(id,server_nickname,service_type,url) VALUES(1,'fixture','plex','http://fixture.invalid')",
		"INSERT INTO bulk_operations(id,actor_uuid,access_hash,request_id,request_hash,action,payload,targets,results,warnings,effects,state,role_revision,operation_token,created_at,updated_at) VALUES('op-1','11111111-1111-1111-1111-111111111111','h','r','rh','update_libraries','{}','[]','[]','[]','[]','running',1,'tok','" + now + "','" + now + "')",
		"INSERT INTO bulk_source_locks(server_id,operation_id,operation_token) VALUES(1,'op-1','tok')",
		"INSERT INTO bulk_removed_identities(server_id,external_user_id,operation_id,removed_at) VALUES(1,'42','op-1','" + now + "')",
		"INSERT INTO audit_events(actor_uuid,action,details,occurred_at) VALUES('11111111-1111-1111-1111-111111111111','bulk.update_libraries.updated','{}','" + now + "'),('11111111-1111-1111-1111-111111111111','invitation.archive','{}','" + now + "')",
	} {
		if _, err := db.Exec(statement); err != nil {
			t.Fatal(statement, err)
		}
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	s, err := OpenStore(t.Context(), path)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	var operation, lock, removed string
	if err := s.reader.QueryRow("SELECT o.id||'/'||o.state, l.operation_id||'/'||l.operation_token, r.external_user_id||'/'||r.operation_id FROM edit_operations o JOIN edit_source_locks l ON l.operation_id=o.id JOIN edit_removed_identities r ON r.operation_id=o.id").Scan(&operation, &lock, &removed); err != nil {
		t.Fatal("renamed tables lost data or links:", err)
	}
	if operation != "op-1/running" || lock != "op-1/tok" || removed != "42/op-1" {
		t.Fatal(operation, lock, removed)
	}
	var old int
	if err := s.reader.QueryRow("SELECT count(*) FROM sqlite_master WHERE name LIKE 'bulk%'").Scan(&old); err != nil || old != 0 {
		t.Fatal("bulk schema objects remain", old, err)
	}
	var index int
	if err := s.reader.QueryRow("SELECT count(*) FROM sqlite_master WHERE type='index' AND name='edit_operations_actor'").Scan(&index); err != nil || index != 1 {
		t.Fatal("edit_operations_actor index missing", index, err)
	}
	// Foreign keys now point at edit_operations.
	if _, err := s.writer.Exec("INSERT INTO edit_source_locks(server_id,operation_id,operation_token) VALUES(2,'missing','t')"); err == nil {
		t.Fatal("edit_source_locks accepted an unknown operation")
	}
	var actions string
	if err := s.reader.QueryRow("SELECT group_concat(action,',') FROM (SELECT action FROM audit_events ORDER BY action)").Scan(&actions); err != nil {
		t.Fatal(err)
	}
	if actions != "edit.update_libraries.updated,invitation.archive" {
		t.Fatal("audit actions not relabelled correctly:", actions)
	}
}
