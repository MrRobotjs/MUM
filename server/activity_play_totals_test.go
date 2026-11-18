package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

type playPeriodTest struct {
	Period  string `json:"period"`
	Plays   string `json:"plays"`
	Timed   string `json:"timed_plays"`
	Seconds string `json:"seconds"`
}

type recentPlayTest struct {
	Source      string  `json:"source"`
	Title       string  `json:"title"`
	ParentTitle *string `json:"parent_title"`
	PlayedAt    string  `json:"played_at"`
	Poster      string  `json:"poster_url"`
}

type playTotalsTestPage struct {
	Actor    string           `json:"actor_uuid"`
	Scope    string           `json:"scope"`
	Target   string           `json:"target_uuid"`
	Source   string           `json:"source"`
	Sources  []string         `json:"sources"`
	Imported string           `json:"imported_plays"`
	Periods  []playPeriodTest `json:"periods"`
	Recent   []recentPlayTest `json:"recent_plays"`
	Players  []struct {
		Client   string  `json:"client"`
		Platform *string `json:"platform"`
		Plays    string  `json:"plays"`
	} `json:"players"`
}

func readPlayTotals(t *testing.T, a *App, token, target, query string) (int, playTotalsTestPage) {
	t.Helper()
	w := apiRequest(a, "GET", "/api/activity/identities/"+target+"/plays"+query, token, nil, nil)
	var out struct{ Data playTotalsTestPage }
	if w.Code == 200 {
		if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
			t.Fatal(err)
		}
	}
	return w.Code, out.Data
}

func periodsText(p playTotalsTestPage) string {
	out := ""
	for _, period := range p.Periods {
		out += period.Period + ":" + period.Plays + "/" + period.Timed + "/" + period.Seconds + " "
	}
	return out
}

// playTotalsFixture moves the timeline fixture's plays to times around now:
// MUM one 2h ago (an hour long, 10 minutes paused), MUM three 3 days ago (two
// hours seen, one-hour item, pauses unknown), imported Plex plays 12 hours, 10
// days and 40 days ago.
func playTotalsFixture(t *testing.T) (*App, string, string, string) {
	t.Helper()
	a, s, token, viewer, local := timelineFixture(t)
	now := time.Now().UTC()
	ago := func(d time.Duration) string { return utcTimestamp(now.Add(-d)) }
	activityExec(t, s, `UPDATE media_activity_history SET first_seen_at=?,last_seen_at=?,paused_seconds=600,client='Infuse' WHERE title='MUM one'`, ago(2*time.Hour), ago(time.Hour))
	activityExec(t, s, `UPDATE media_activity_history SET first_seen_at=?,last_seen_at=?,paused_seconds=NULL,duration_ticks=36000000000,platform='Chrome' WHERE title='MUM three'`, ago(72*time.Hour), ago(70*time.Hour))
	for title, d := range map[string]time.Duration{"Plex four": 12 * time.Hour, "Plex two": 240 * time.Hour, "Plex three": 960 * time.Hour} {
		activityExec(t, s, `UPDATE history_imports SET viewed_at=? WHERE title=?`, ago(d), title)
	}
	return a, token, viewer, local
}

// The profile's totals count the plays the History tab lists, per period, with
// time only from MUM's plays: seen time less paused time, capped at the item's
// length. Imported plays count as plays without time.
func TestIdentityPlayTotalsPeriods(t *testing.T) {
	a, token, viewer, local := playTotalsFixture(t)
	for _, c := range []struct{ token, scope string }{{token, "all"}, {viewer, "own"}} {
		code, p := readPlayTotals(t, a, c.token, local, "?scope="+c.scope+"&source=all")
		if code != 200 || p.Scope != c.scope || p.Target != local || p.Source != "all" || len(p.Sources) != 1 || p.Sources[0] != "plex" {
			t.Fatal(c.scope, code, p)
		}
		if got := periodsText(p); got != "day:2/1/3000 week:3/2/6600 month:4/2/6600 all:5/2/6600 " {
			t.Fatal(c.scope, got)
		}
		// Every play of both sources, newest first.
		if p.Imported != "3" || len(p.Recent) != 5 || p.Recent[0].Source != "mum" || p.Recent[0].Title != "MUM one" ||
			!slices.IsSortedFunc(p.Recent, func(x, y recentPlayTest) int { return strings.Compare(y.PlayedAt, x.PlayedAt) }) {
			t.Fatalf("%s imported/last %+v", c.scope, p)
		}
		if len(p.Players) != 2 || p.Players[0].Client != "Infuse" || p.Players[0].Platform != nil || p.Players[1].Client != "Plex Web" || p.Players[1].Platform == nil || *p.Players[1].Platform != "Chrome" {
			t.Fatalf("%s players %+v", c.scope, p.Players)
		}
	}
	_, mum := readPlayTotals(t, a, token, local, "?scope=all&source=mum")
	if got := periodsText(mum); got != "day:1/1/3000 week:2/2/6600 month:2/2/6600 all:2/2/6600 " || mum.Imported != "0" || len(mum.Players) != 2 {
		t.Fatal("mum", got, mum)
	}
	_, plex := readPlayTotals(t, a, token, local, "?scope=all&source=plex")
	if got := periodsText(plex); got != "day:1/0/0 week:1/0/0 month:2/0/0 all:3/0/0 " || plex.Imported != "3" || len(plex.Players) != 0 {
		t.Fatal("plex", got, plex)
	}
	if len(plex.Recent) != 3 || plex.Recent[0].Source != "plex" || plex.Recent[0].Title != "Plex four" || plex.Recent[0].ParentTitle == nil || *plex.Recent[0].ParentTitle != "A Show" {
		t.Fatalf("plex recent %+v", plex.Recent)
	}
}

func TestIdentityPlayTotalsEmptyAndAuthority(t *testing.T) {
	a, s, token, viewer, local := timelineFixture(t)
	owner, _ := s.Authenticate(t.Context(), token)
	other, err := s.CreateAccount(t.Context(), owner.UUID, "other-viewer", "fixture-hash", false)
	if err != nil {
		t.Fatal(err)
	}
	code, p := readPlayTotals(t, a, token, other, "?scope=all&source=all")
	if code != 200 || periodsText(p) != "day:0/0/0 week:0/0/0 month:0/0/0 all:0/0/0 " || p.Recent == nil || len(p.Recent) != 0 || p.Players == nil || len(p.Players) != 0 || p.Sources == nil || len(p.Sources) != 0 {
		t.Fatalf("no plays %d %+v", code, p)
	}
	if code, _ := readPlayTotals(t, a, viewer, other, "?scope=own&source=all"); code != 403 {
		t.Fatal("read another person's plays", code)
	}
	if code, _ := readPlayTotals(t, a, viewer, local, "?scope=all&source=all"); code != 403 {
		t.Fatal("a viewer used the administrator scope", code)
	}
	for _, bad := range []string{"", "?scope=all", "?scope=every&source=all", "?scope=all&source=both", "?scope=all&source=all&before=1", "?scope=all&scope=own&source=all"} {
		if code, _ := readPlayTotals(t, a, token, local, bad); code != 400 {
			t.Fatal("bad query accepted", bad, code)
		}
	}
}

// Each app carries the platform most of its plays reported, as Plex sends it
// (a tie goes to the first name), and apps are counted across platforms before the most used are kept.
func TestIdentityPlayTotalsPlayerPlatforms(t *testing.T) {
	a, token, _, local := playTotalsFixture(t)
	var id int64
	if err := a.store.reader.QueryRow(`SELECT id FROM media_activity_history WHERE title='MUM three'`).Scan(&id); err != nil {
		t.Fatal(err)
	}
	// Two more Plex Web plays: one on Android, one with no platform.
	for i, platform := range []any{"Android", nil} {
		activityExec(t, a.store, `INSERT INTO media_activity_history(server_id,external_session_id,service_uuid,owner_uuid,item_id,media_type,title,first_seen_at,last_seen_at,paused,client,platform)
			SELECT server_id,external_session_id||?,service_uuid,owner_uuid,item_id,media_type,title,first_seen_at,last_seen_at,0,client,? FROM media_activity_history WHERE id=?`, "-extra"+string(rune('a'+i)), platform, id)
	}
	_, p := readPlayTotals(t, a, token, local, "?scope=all&source=mum")
	if len(p.Players) != 2 || p.Players[0].Client != "Plex Web" || p.Players[0].Plays != "3" || p.Players[0].Platform == nil || *p.Players[0].Platform != "Android" {
		t.Fatalf("a tie goes to the first name %+v", p.Players)
	}
	// Chrome now has more Plex Web plays than Android.
	activityExec(t, a.store, `UPDATE media_activity_history SET platform='Chrome' WHERE client='Plex Web' AND platform IS NULL`)
	if _, p = readPlayTotals(t, a, token, local, "?scope=all&source=mum"); *p.Players[0].Platform != "Chrome" {
		t.Fatalf("players %+v", p.Players)
	}
}

// Recent plays' posters are signed administrator links, as on the History tab.
func TestIdentityPlayTotalsRecentPlayPosters(t *testing.T) {
	a, token, viewer, local := playTotalsFixture(t)
	activityExec(t, a.store, "UPDATE history_imports SET poster_item='20',poster_path='/library/metadata/20/thumb/1' WHERE title='Plex four'")
	_, plex := readPlayTotals(t, a, token, local, "?scope=all&source=plex")
	if len(plex.Recent) != 3 || !strings.HasPrefix(plex.Recent[0].Poster, "/api/activity/imported-history-images/") || plex.Recent[1].Poster != "" || plex.Recent[2].Poster != "" {
		t.Fatalf("posters %+v", plex.Recent)
	}
	if _, own := readPlayTotals(t, a, viewer, local, "?scope=own&source=plex"); len(own.Recent) != 3 || own.Recent[0].Poster != "" {
		t.Fatalf("a viewer got a poster link %+v", own.Recent)
	}
}

// MUM counts paused time while a play runs: from each paused reading to the
// next one. Plays recorded before this have no paused time (NULL).
func TestActivityHistoryCountsPausedTime(t *testing.T) {
	a, s := testApp(t)
	token, _ := bootstrapOwner(t, a)
	owner, _ := s.Authenticate(t.Context(), token)
	var payload atomic.Value
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write(payload.Load().([]byte)) }))
	defer upstream.Close()
	server := createManagedServer(t, a, token, "jellyfin", upstream.URL)
	service := seedService(t, s, server)
	row := activityFixtureRow()
	row["UserId"] = service
	capture := func(paused bool) {
		t.Helper()
		row["PlayState"].(map[string]any)["IsPaused"] = paused
		body, _ := json.Marshal([]any{row})
		payload.Store(body)
		if _, err := a.captureProviderActivity(t.Context(), owner.UUID, token, server); err != nil {
			t.Fatal(err)
		}
	}
	back := func(seconds int) {
		activityExec(t, s, `UPDATE media_activity_history SET last_seen_at=strftime('%Y-%m-%dT%H:%M:%f000000Z',julianday(last_seen_at)-?/86400.0),
			paused_since=CASE WHEN paused_since IS NOT NULL THEN strftime('%Y-%m-%dT%H:%M:%f000000Z',julianday(paused_since)-?/86400.0) END`, seconds, seconds)
	}
	paused := func() int64 {
		var v int64
		if err := s.reader.QueryRow(`SELECT paused_seconds FROM media_activity_history`).Scan(&v); err != nil {
			t.Fatal(err)
		}
		return v
	}
	capture(false)
	if paused() != 0 {
		t.Fatal("a new play starts with no paused time")
	}
	back(100)
	capture(true) // was playing: the 100 seconds were not paused
	if got := paused(); got != 0 {
		t.Fatal("playing time counted as paused", got)
	}
	back(60)
	capture(true)
	back(30)
	capture(false) // was paused until this reading
	if got := paused(); got < 89 || got > 91 {
		t.Fatal("paused seconds", got)
	}
}
