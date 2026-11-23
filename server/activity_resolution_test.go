package main

import (
	"app/server/providers/provider"
	"testing"
)

func TestActivityResolutionPersistsAndPreservesKnownValues(t *testing.T) {
	_, s, _, token, actor := roleReadFixture(t)
	server := seedServer(t, s)
	service := seedService(t, s, server)
	observe := func(source, stream string) {
		t.Helper()
		claim, err := s.beginActivityRead(t.Context(), actor, token, server)
		if err != nil {
			t.Fatal(err)
		}
		snapshot := activityForUser(t, service)
		snapshot.Sessions[0].Display = &provider.ActivityDisplay{SourceResolution: source, StreamResolution: stream}
		if _, err := s.applyActivitySnapshot(t.Context(), claim, snapshot); err != nil {
			t.Fatal(err)
		}
	}
	observe("1080p", "480p")
	observe("invalid", "")
	var source, stream string
	if err := s.reader.QueryRow(`SELECT source_resolution,stream_resolution FROM media_activity_history WHERE server_id=?`, server).Scan(&source, &stream); err != nil {
		t.Fatal(err)
	}
	if source != "1080p" || stream != "480p" {
		t.Fatalf("resolution %q %q", source, stream)
	}
}
