package main

import (
	"context"
	"database/sql"
	"testing"
	"time"

	"app/server/providers/provider"
)

// A library sync saves each item's file details, replaces them when the file
// changes and clears them when the server stops reporting any.
func TestCatalogueSyncSavesMediaInfo(t *testing.T) {
	_, s := testApp(t)
	server := seedServer(t, s)
	activityExec(t, s, "INSERT INTO media_libraries(server_id,external_id,name) VALUES(?,'lib','Movies')", server)
	var library int64
	if err := s.reader.QueryRow("SELECT id FROM media_libraries WHERE server_id=?", server).Scan(&library); err != nil {
		t.Fatal(err)
	}
	kbps, channels := int64(9861), int64(6)
	sync := func(media *provider.CatalogueMedia) (added, updated int) {
		t.Helper()
		existing := map[string]int64{}
		var id int64
		if s.reader.QueryRow("SELECT id FROM media_items WHERE library_id=? AND external_id='film'", library).Scan(&id) == nil {
			existing["film"] = id
		}
		err := s.write(context.Background(), func(tx *sql.Tx) error {
			var err error
			added, updated, err = upsertCatalogueItems(context.Background(), tx, library, server, "", []catalogueItem{{ID: "film", Title: "Film", SortTitle: "Film", Type: "movie", Media: media}}, existing, utcTimestamp(time.Now()))
			return err
		})
		if err != nil {
			t.Fatal(err)
		}
		return
	}
	read := func() *provider.CatalogueMedia {
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
		m, err := readItemMediaInfo(context.Background(), tx, id)
		if err != nil {
			t.Fatal(err)
		}
		return m
	}
	if added, _ := sync(&provider.CatalogueMedia{Container: "mkv", VideoCodec: "hevc", BitrateKbps: &kbps, AudioChannels: &channels}); added != 1 {
		t.Fatal("item not added")
	}
	if m := read(); m == nil || m.Container != "MKV" || m.VideoCodec != "HEVC" || *m.BitrateKbps != 9861 || *m.AudioChannels != 6 {
		t.Fatalf("%+v", m)
	}
	if _, updated := sync(&provider.CatalogueMedia{Container: "mkv", VideoCodec: "hevc", BitrateKbps: &kbps, AudioChannels: &channels}); updated != 0 {
		t.Fatal("unchanged file details counted as an update")
	}
	if _, updated := sync(&provider.CatalogueMedia{Container: "mp4"}); updated != 1 || read().Container != "MP4" || read().VideoCodec != "" {
		t.Fatal("changed file details not replaced", read())
	}
	if _, updated := sync(nil); updated != 1 || read() != nil {
		t.Fatal("file details not cleared", read())
	}
	activityExec(t, s, `UPDATE media_items SET media_info='{"container":"mkv","audio_channels":9999}' WHERE external_id='film'`)
	if m := read(); m == nil || m.AudioChannels != nil || m.Container != "MKV" {
		t.Fatal("implausible stored value served", m)
	}
}
