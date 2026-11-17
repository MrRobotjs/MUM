package main

import (
	"database/sql"
	"fmt"
	"strings"
	"testing"
)

const plexTrack = `<MediaContainer size="1"><Track sessionKey="11" ratingKey="501" parentRatingKey="500" grandparentRatingKey="499" type="track" title="We Don't Talk Anymore" parentTitle="Nine Track Mind" grandparentTitle="Charlie Puth" librarySectionTitle="Music" thumb="/library/metadata/500/thumb/1700" parentThumb="/library/metadata/500/thumb/1700" duration="217000" viewOffset="60000"><User id="42" title="Viewer"/><Player state="playing" product="Plexamp" title="Private device"/></Track></MediaContainer>`

// History keeps a play's poster, album/series, library and player after the
// live session ends; the poster is served only through a signed administrator
// link and never as a raw provider path.
func TestActivityHistoryKeepsPresentationAfterPlaybackEnds(t *testing.T) {
	a, store := testApp(t)
	token, _ := bootstrapOwner(t, a)
	owner, err := store.Authenticate(t.Context(), token)
	if err != nil {
		t.Fatal(err)
	}
	server := createManagedServer(t, a, token, "plex", "http://127.0.0.1:1")
	apply := func(body string) {
		t.Helper()
		claim, err := store.beginActivityRead(t.Context(), owner.UUID, token, server)
		if err != nil {
			t.Fatal(err)
		}
		snapshot, err := parseActivitySnapshot("plex", []byte(body))
		if err != nil {
			t.Fatal(err)
		}
		if err := store.write(t.Context(), func(tx *sql.Tx) error {
			_, err := commitActivitySnapshot(t.Context(), tx, claim, snapshot)
			return err
		}); err != nil {
			t.Fatal(err)
		}
	}
	apply(plexTrack)
	// While it plays, the current view names the album (the series for an
	// episode) so a status can say what the track or episode belongs to; the
	// other history details stay off it.
	live := apiRequest(a, "GET", "/api/activity/current?scope=all", token, nil, nil)
	current := responseData(t, live)["items"].([]any)
	if len(current) != 1 || current[0].(map[string]any)["parent_title"] != "Nine Track Mind" {
		t.Fatalf("current parent title missing: %s", live.Body.String())
	}
	for _, key := range []string{"library_name", "client", "play_method", "poster_url"} {
		if _, ok := current[0].(map[string]any)[key]; ok {
			t.Fatalf("history detail %s on a current row: %s", key, live.Body.String())
		}
	}
	apply(`<MediaContainer size="0"/>`) // playback ended; the live row is gone
	w := apiRequest(a, "GET", "/api/activity/history?scope=all", token, nil, nil)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	items := responseData(t, w)["items"].([]any)
	if len(items) != 1 {
		t.Fatal(w.Body.String())
	}
	row := items[0].(map[string]any)
	if row["ended_observation_at"] == nil || row["parent_title"] != "Nine Track Mind" || row["library_name"] != "Music" || row["client"] != "Plexamp" {
		t.Fatalf("presentation missing: %v", row)
	}
	poster, _ := row["poster_url"].(string)
	if !strings.HasPrefix(poster, fmt.Sprintf("/api/activity/history-images/%s?", row["id"])) || strings.Contains(w.Body.String(), "/library/metadata/") {
		t.Fatalf("poster should be a signed link only: %q", poster)
	}
	// The link resolves to the stored poster (the fixture provider is offline,
	// so the fetch itself fails upstream rather than the source lookup).
	if got := apiRequest(a, "GET", poster, "", nil, nil).Code; got != 502 {
		t.Fatal("history poster source not resolved", got)
	}
	if got := apiRequest(a, "GET", poster+"tampered", "", nil, nil).Code; got != 403 && got != 404 {
		t.Fatal("tampered poster link accepted", got)
	}
	if got := apiRequest(a, "GET", fmt.Sprintf("/api/activity/history-images/%s", row["id"]), "", nil, nil).Code; got == 200 || got == 502 {
		t.Fatal("unsigned poster request reached the provider", got)
	}
}
