package main

import (
	"context"
	"database/sql"
	"testing"
	"time"

	"app/server/providers/provider"
)

// A library sync saves each item's TMDB, TVDB and IMDb IDs, counts a changed
// ID as an update, and clears IDs the server no longer reports.
func TestCatalogueSyncSavesExternalIDs(t *testing.T) {
	_, s := testApp(t)
	server := seedServer(t, s)
	activityExec(t, s, "INSERT INTO media_libraries(server_id,external_id,name) VALUES(?,'lib','Movies')", server)
	var library int64
	if err := s.reader.QueryRow("SELECT id FROM media_libraries WHERE server_id=?", server).Scan(&library); err != nil {
		t.Fatal(err)
	}
	sync := func(ids provider.ExternalIDs) (added, updated int) {
		t.Helper()
		existing := map[string]int64{}
		var id int64
		if s.reader.QueryRow("SELECT id FROM media_items WHERE library_id=? AND external_id='film'", library).Scan(&id) == nil {
			existing["film"] = id
		}
		err := s.write(context.Background(), func(tx *sql.Tx) error {
			var err error
			added, updated, err = upsertCatalogueItems(context.Background(), tx, library, server, "", []catalogueItem{{ID: "film", Title: "Film", SortTitle: "Film", Type: "movie", IDs: ids}}, existing, utcTimestamp(time.Now()))
			return err
		})
		if err != nil {
			t.Fatal(err)
		}
		return
	}
	read := func() catalogueExternalIDs {
		t.Helper()
		var id int64
		if err := s.reader.QueryRow("SELECT id FROM media_items WHERE library_id=? AND external_id='film'", library).Scan(&id); err != nil {
			t.Fatal(err)
		}
		tx, err := s.reader.BeginTx(context.Background(), &sql.TxOptions{ReadOnly: true})
		if err != nil {
			t.Fatal(err)
		}
		defer tx.Rollback()
		ids, err := readItemExternalIDs(context.Background(), tx, id)
		if err != nil {
			t.Fatal(err)
		}
		return ids
	}
	if added, _ := sync(provider.ExternalIDs{TMDB: 603, IMDb: "tt0133093"}); added != 1 {
		t.Fatal("item not added")
	}
	if ids := read(); ids.TMDB == nil || *ids.TMDB != 603 || ids.TVDB != nil || ids.IMDb == nil || *ids.IMDb != "tt0133093" {
		t.Fatalf("%+v", ids)
	}
	if _, updated := sync(provider.ExternalIDs{TMDB: 603, IMDb: "tt0133093"}); updated != 0 {
		t.Fatal("unchanged IDs counted as an update")
	}
	if _, updated := sync(provider.ExternalIDs{TMDB: 603, TVDB: 169, IMDb: "tt0133093"}); updated != 1 || read().TVDB == nil || *read().TVDB != 169 {
		t.Fatal("added ID not saved", read())
	}
	if _, updated := sync(provider.ExternalIDs{}); updated != 1 || read() != (catalogueExternalIDs{}) {
		t.Fatal("IDs not cleared", read())
	}
	for _, bad := range []string{"tmdb_id=0", "tvdb_id=-1", "tmdb_id='abc'", "tmdb_id=1.5", "imdb_id='0133093'", "imdb_id='tt12'", "imdb_id='tt01330x3'"} {
		if _, err := s.writer.Exec("UPDATE media_items SET "+bad+" WHERE external_id='film'"); err == nil {
			t.Fatalf("%s accepted", bad)
		}
	}
}
