package main

import (
	"database/sql"
	"testing"
)

func TestActivityMissingLibraryRequiresKnownCompletedCatalogue(t *testing.T) {
	_, s := testApp(t)
	server := seedServer(t, s)
	service := seedService(t, s, server)
	activityExec(t, s, `INSERT INTO media_libraries(server_id,external_id,name,library_type) VALUES(?,'movies','Movies','movie')`, server)
	activityExec(t, s, `INSERT INTO media_activity_history(server_id,external_session_id,service_uuid,item_id,media_type,title,first_seen_at,last_seen_at,paused,library_name) VALUES(?,'session',?,'movie-1','movie','Movie','2026','2026',0,'Movies')`, server, service)
	check := func(want bool) {
		t.Helper()
		tx, err := s.reader.BeginTx(t.Context(), &sql.TxOptions{ReadOnly: true})
		if err != nil {
			t.Fatal(err)
		}
		defer tx.Rollback()
		got, err := activityMissingFromLibrary(t.Context(), tx, server, "movie-1", "")
		if err != nil || got != want {
			t.Fatalf("missing=%v want=%v: %v", got, want, err)
		}
	}
	check(false)
	activityExec(t, s, `UPDATE media_libraries SET catalogue_synced_at='2026-01-01T00:00:00Z' WHERE server_id=?`, server)
	check(true)
	activityExec(t, s, `INSERT INTO media_libraries(server_id,external_id,name,library_type,catalogue_synced_at) VALUES(?,'other','Movies','movie','2026-01-01T00:00:00Z')`, server)
	check(false)
	activityExec(t, s, `DELETE FROM media_libraries WHERE server_id=? AND external_id='other'`, server)
	activityExec(t, s, `INSERT INTO media_items(library_id,server_id,external_id,title,item_type) SELECT id,server_id,'movie-1','Movie','movie' FROM media_libraries WHERE server_id=?`, server)
	check(false)
}
