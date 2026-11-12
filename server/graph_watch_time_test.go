package main

import (
	"database/sql"
	"strings"
	"testing"
	"time"
)

// Watch time per UTC day, as Flask computed it: each play counts its observed
// span (last minus first observation), or its last position when it was seen
// only once; plays are bucketed by the day they started.
func TestGraphAnalyticsWatchTimeByDay(t *testing.T) {
	f := activityReadFixture(t)
	activityExec(t, f.store, "DELETE FROM media_activity_current")
	activityExec(t, f.store, "DELETE FROM media_activity_history")
	day := time.Now().UTC().Add(-24 * time.Hour).Truncate(24 * time.Hour).Add(10 * time.Hour)
	insert := func(session string, first, last time.Time, position any) {
		t.Helper()
		if err := f.store.write(t.Context(), func(tx *sql.Tx) error {
			_, err := tx.ExecContext(t.Context(), `INSERT INTO media_activity_history(server_id,external_session_id,service_uuid,item_id,media_type,title,first_seen_at,last_seen_at,ended_at,end_reason,paused,position_ticks) VALUES(?,?,?,'graph-item','Movie','Private graph title',?,?,?,'not_observed',0,?)`, f.server, session, f.service, utcTimestamp(first), utcTimestamp(last), utcTimestamp(last), position)
			return err
		}); err != nil {
			t.Fatal(err)
		}
	}
	insert("span", day, day.Add(30*time.Minute), int64(1))                     // 30 minutes observed
	insert("single", day.Add(time.Hour), day.Add(time.Hour), int64(600000000)) // seen once: 60 s position
	insert("old", day.Add(-40*24*time.Hour), day.Add(-40*24*time.Hour+time.Hour), nil)
	got := graphRead(t, f, f.ownerToken, "")
	if strings.Contains(strings.Join(got.Meta.Unavailable, ","), "watch_time_activity") {
		t.Fatal("watch time still reported unavailable", got.Meta.Unavailable)
	}
	if len(got.Data.WatchTime) != 30 {
		t.Fatal("expected 30 daily buckets", len(got.Data.WatchTime))
	}
	first, last := got.Data.WatchTime[0].(map[string]any), got.Data.WatchTime[29].(map[string]any)
	today := time.Now().UTC().Format("2006-01-02")
	if last["date"] != today || last["label"] != today || first["date"] != time.Now().UTC().AddDate(0, 0, -29).Format("2006-01-02") {
		t.Fatal("bucket range", first, last)
	}
	var total float64
	for _, raw := range got.Data.WatchTime {
		bucket := raw.(map[string]any)
		minutes := bucket["minutes"].(float64)
		if bucket["date"] == day.Format("2006-01-02") && minutes != 31 {
			t.Fatal("day minutes", bucket)
		}
		total += minutes
	}
	if total != 31 {
		t.Fatal("window total (the 40-day-old play must be excluded)", total)
	}
	if one := graphRead(t, f, f.ownerToken, "?days=1"); len(one.Data.WatchTime) != 1 {
		t.Fatal("one-day window", one.Data.WatchTime)
	}
	sep := graphRead(t, f, f.ownerToken, "?server_mode=separated")
	if sep.Data.Separated == nil || len(sep.Data.Separated.WatchTime) != 30 || len(sep.Data.Separated.Servers) != 1 {
		t.Fatal("separated watch time", sep.Data.Separated)
	}
	key := sep.Data.Separated.Servers[0].Key
	for _, raw := range sep.Data.Separated.WatchTime {
		bucket := raw.(map[string]any)
		if bucket["date"] == day.Format("2006-01-02") && bucket["values"].(map[string]any)[key] != 31.0 {
			t.Fatal("separated day minutes", bucket)
		}
	}
}
