package main

import (
	"encoding/json"
	"strconv"
	"testing"
	"time"
)

type playHistoryBody struct {
	Data struct {
		Days    int    `json:"days"`
		Media   string `json:"media"`
		Bucket  string `json:"bucket"`
		Buckets []struct {
			Start   string           `json:"start"`
			End     string           `json:"end"`
			Seconds map[string]int64 `json:"seconds"`
			Plays   map[string]int64 `json:"plays"`
		} `json:"buckets"`
		Totals map[string]int64 `json:"totals"`
		Users  []struct {
			UUID string `json:"uuid"`
			Name string `json:"name"`
		} `json:"users"`
	} `json:"data"`
}

// Watched time per period, stacked by media type, with media and person
// filters; periods follow the window's length.
func TestGraphPlayHistory(t *testing.T) {
	f := activityReadFixture(t)
	activityExec(t, f.store, "DELETE FROM media_activity_current")
	activityExec(t, f.store, "DELETE FROM media_activity_history")
	now := time.Now().UTC().Truncate(time.Hour)
	seedWatch(t, f, "m", "m1", "Movie", "A Movie", now.Add(-48*time.Hour), 60)
	seedWatch(t, f, "e", "e1", "Episode", "An Episode", now.Add(-50*time.Hour), 30)
	seedWatch(t, f, "t", "t1", "track", "A Song", now.AddDate(0, 0, -9), 10)
	seedWatch(t, f, "c", "c1", "Clip", "A Clip", now.Add(-26*time.Hour), 20)
	seedWatch(t, f, "old", "o1", "Movie", "Too Old", now.AddDate(0, 0, -40), 90)
	// One play by the server account on its own, not as the linked person.
	activityExec(t, f.store, "UPDATE media_activity_history SET owner_uuid=NULL WHERE external_session_id='c'")

	read := func(query string) (int, playHistoryBody) {
		t.Helper()
		w := apiRequest(f.app, "GET", "/api/graphs/play-history"+query, f.ownerToken, nil, nil)
		var body playHistoryBody
		if w.Code == 200 {
			if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
				t.Fatal(err)
			}
		}
		return w.Code, body
	}

	code, all := read("?days=30")
	d := all.Data
	today := now.Format("2006-01-02")
	if code != 200 || d.Bucket != "week" || len(d.Buckets) != 5 || d.Buckets[4].End != today ||
		d.Buckets[4].Start != now.AddDate(0, 0, -6).Format("2006-01-02") || d.Buckets[0].Start != now.AddDate(0, 0, -29).Format("2006-01-02") {
		t.Fatalf("weeks %d %+v", code, d.Buckets)
	}
	if d.Totals["movies"] != 3600 || d.Totals["tv"] != 1800 || d.Totals["music"] != 600 || d.Totals["other"] != 1200 || d.Totals["photos"] != 0 {
		t.Fatalf("totals %+v", d.Totals)
	}
	if last := d.Buckets[4].Seconds; last["movies"] != 3600 || last["tv"] != 1800 || last["music"] != 0 {
		t.Fatalf("this week %+v", last)
	}
	if last := d.Buckets[4].Plays; last["movies"] != 1 || last["tv"] != 1 {
		t.Fatalf("play counts %+v", last)
	}
	if prior := d.Buckets[3].Seconds; prior["music"] != 600 {
		t.Fatalf("last week %+v", prior)
	}
	// Two people: the linked person and the server account playing alone.
	if len(d.Users) != 2 {
		t.Fatalf("people %+v", d.Users)
	}

	// Filters narrow the bars and totals, never the people list.
	if _, tv := read("?days=30&media=tv"); tv.Data.Media != "tv" || tv.Data.Totals["tv"] != 1800 || tv.Data.Totals["movies"] != 0 || len(tv.Data.Users) != 2 {
		t.Fatalf("tv only %+v", tv.Data)
	}
	if _, mine := read("?days=30&user=" + f.user); mine.Data.Totals["other"] != 0 || mine.Data.Totals["movies"] != 3600 {
		t.Fatalf("one person %+v", mine.Data.Totals)
	}

	// Short windows are days, long ones months; the old play shows in a year.
	if _, week := read("?days=7"); week.Data.Bucket != "day" || len(week.Data.Buckets) != 7 || week.Data.Buckets[6].Start != today {
		t.Fatalf("days %+v", week.Data.Buckets)
	}
	if _, year := read("?days=365"); year.Data.Bucket != "month" || year.Data.Totals["movies"] != 3600+5400 || year.Data.Buckets[len(year.Data.Buckets)-1].End != today {
		t.Fatalf("months %s %+v", year.Data.Bucket, year.Data.Totals)
	}
	if _, daily := read("?days=30&interval=day"); daily.Data.Bucket != "day" || len(daily.Data.Buckets) != 30 {
		t.Fatalf("daily interval %+v", daily.Data)
	}
	if _, monthly := read("?days=30&interval=month"); monthly.Data.Bucket != "month" {
		t.Fatalf("monthly interval %+v", monthly.Data)
	}
	if _, one := read("?days=30&server_id=" + strconv.FormatInt(f.server, 10)); one.Data.Totals["movies"] != 3600 {
		t.Fatalf("one server %+v", one.Data.Totals)
	}
	for _, bad := range []string{"?days=0", "?days=366", "?media=books", "?user=someone", "?user=" + f.user + "&user=" + f.user, "?other=1"} {
		if code, _ := read(bad); code != 400 {
			t.Fatal(bad, code)
		}
	}
}
