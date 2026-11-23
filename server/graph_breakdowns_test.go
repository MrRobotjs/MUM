package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"
)

func TestGraphNextLocalDayAcrossSkippedMidnight(t *testing.T) {
	zone, err := time.LoadLocation("America/Sao_Paulo")
	if err != nil {
		t.Fatal(err)
	}
	before := time.Date(2018, 11, 4, 2, 45, 0, 0, time.UTC)
	want := time.Date(2018, 11, 4, 3, 0, 0, 0, time.UTC)
	got := graphNextLocalDay(before, zone)
	if !got.Equal(want) || !got.After(before) {
		t.Fatalf("boundary = %v, want %v", got, want)
	}
	day := time.Date(2018, 11, 4, 0, 0, 0, 0, time.UTC)
	if got := graphLocalDayStart(day, zone); !got.Equal(want) {
		t.Fatalf("day start = %v, want %v", got, want)
	}
}

func TestGraphBreakdownsSplitAtSkippedMidnight(t *testing.T) {
	zone, err := time.LoadLocation("America/Sao_Paulo")
	if err != nil {
		t.Fatal(err)
	}
	f := activityReadFixture(t)
	activityExec(t, f.store, "DELETE FROM media_activity_current")
	activityExec(t, f.store, "DELETE FROM media_activity_history")
	start := time.Date(2018, 11, 4, 2, 45, 0, 0, time.UTC)
	seedWatch(t, f, "crossing", "item", "Movie", "Title", start, 30)
	tx, err := f.store.reader.BeginTx(context.Background(), &sql.TxOptions{ReadOnly: true})
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	data, err := readGraphBreakdowns(context.Background(), tx, graphQuery{Days: 2, Zone: zone}, "", "plays", start.Add(2*time.Hour), map[int64]bool{f.server: true})
	if err != nil {
		t.Fatal(err)
	}
	rows := data["concurrent_modes"].([]*graphBreakdownRow)
	if len(rows) != 2 || rows[0].Label != "2018-11-03" || rows[1].Label != "2018-11-04" || rows[0].Plays["total"] != 1 || rows[1].Plays["total"] != 1 {
		t.Fatal(rows)
	}
}

func TestGraphBreakdownLimitExcludesInactiveSources(t *testing.T) {
	f := activityReadFixture(t)
	activityExec(t, f.store, "DELETE FROM media_activity_current")
	activityExec(t, f.store, "DELETE FROM media_activity_history")
	activityExec(t, f.store, `INSERT INTO media_servers(id,server_nickname,service_type,url) VALUES(10002,'inactive fixture','jellyfin','http://fixture.invalid')`)
	inactiveService := seedService(t, f.store, 10002)
	now := time.Now().UTC().Truncate(time.Minute)
	at := utcTimestamp(now.Add(-time.Hour))
	activityExec(t, f.store, `WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<100001)
	 INSERT INTO media_activity_history(server_id,external_session_id,service_uuid,item_id,media_type,title,first_seen_at,last_seen_at,ended_at,end_reason,paused)
	 SELECT 10002,'inactive-'||i,?,'item','Movie','inactive',?,?,?,'not_observed',0 FROM n`, inactiveService, at, at, at)
	seedWatch(t, f, "visible", "item", "Movie", "active", now.Add(-time.Hour), 1)
	tx, err := f.store.reader.BeginTx(context.Background(), &sql.TxOptions{ReadOnly: true})
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	data, err := readGraphBreakdowns(context.Background(), tx, graphQuery{Days: 2, Zone: time.UTC}, "", "plays", now, map[int64]bool{f.server: true, 10002: false})
	if err != nil {
		t.Fatal(err)
	}
	hourly := data["hourly_media"].([]*graphBreakdownRow)
	if hourly[now.Add(-time.Hour).Hour()].Plays["movies"] != 1 {
		t.Fatal("active observation missing")
	}
}

func TestGraphBreakdownsRecordedActivity(t *testing.T) {
	f := activityReadFixture(t)
	activityExec(t, f.store, "DELETE FROM media_activity_current")
	activityExec(t, f.store, "DELETE FROM media_activity_history")
	now := time.Now().UTC().Truncate(time.Minute)
	seedWatch(t, f, "breakdown", "item", "Movie", "Private title", now.Add(-time.Hour), 10)
	activityExec(t, f.store, `UPDATE media_activity_history SET play_method='transcode',platform='Roku' WHERE external_session_id='breakdown'`)
	w := apiRequest(f.app, "GET", "/api/graphs/breakdowns?days=2&tz=UTC", f.ownerToken, nil, nil)
	if w.Code != http.StatusOK {
		t.Fatal(w.Code, w.Body.String())
	}
	var response struct {
		Data struct {
			Hourly []struct {
				Label string           `json:"label"`
				Plays map[string]int64 `json:"plays"`
			} `json:"hourly_media"`
			Platforms []struct {
				Label string           `json:"label"`
				Plays map[string]int64 `json:"plays"`
			} `json:"platforms_modes"`
		} `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	if len(response.Data.Hourly) != 24 || response.Data.Hourly[now.Add(-time.Hour).Hour()].Plays["movies"] != 1 {
		t.Fatal(response.Data.Hourly)
	}
	if len(response.Data.Platforms) != 1 || response.Data.Platforms[0].Label != "Roku" || response.Data.Platforms[0].Plays["transcode"] != 1 {
		t.Fatal(response.Data.Platforms)
	}
	if w := apiRequest(f.app, "GET", "/api/graphs/breakdowns", "", nil, nil); w.Code != http.StatusUnauthorized {
		t.Fatal(w.Code)
	}
	activityExec(t, f.store, "DELETE FROM admin_privileges WHERE user_uuid=?", f.user)
	if w := apiRequest(f.app, "GET", "/api/graphs/breakdowns", f.token, nil, nil); w.Code != http.StatusForbidden {
		t.Fatal(w.Code)
	}
	for _, query := range []string{"?user=bad", "?rank=invalid", "?days=2&days=3", "?server_id=abc"} {
		if w := apiRequest(f.app, "GET", "/api/graphs/breakdowns"+query, f.ownerToken, nil, nil); w.Code != http.StatusBadRequest {
			t.Fatal(query, w.Code)
		}
	}
	if strings.Contains(w.Body.String(), "Private title") || strings.Contains(w.Body.String(), "breakdown") {
		t.Fatal("private activity detail returned")
	}
}

func TestGraphBreakdownsConcurrentAndFilters(t *testing.T) {
	f := activityReadFixture(t)
	activityExec(t, f.store, "DELETE FROM media_activity_current")
	activityExec(t, f.store, "DELETE FROM media_activity_history")
	now := time.Now().UTC()
	start := time.Date(now.Year(), now.Month(), now.Day()-1, 12, 0, 0, 0, time.UTC)
	seedWatch(t, f, "one", "item-one", "Movie", "First", start, 60)
	seedWatch(t, f, "two", "item-two", "Episode", "Second", start.Add(30*time.Minute), 60)
	activityExec(t, f.store, `UPDATE media_activity_history SET play_method=CASE external_session_id WHEN 'one' THEN 'direct_play' ELSE 'transcode' END,source_resolution='1080p'`)
	path := fmt.Sprintf("/api/graphs/breakdowns?days=3&tz=UTC&server_id=%d&user=%s", f.server, f.user)
	w := apiRequest(f.app, "GET", path, f.ownerToken, nil, nil)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	var response struct {
		Data struct {
			Concurrent []struct {
				Label string           `json:"label"`
				Plays map[string]int64 `json:"plays"`
			} `json:"concurrent_modes"`
			Source []struct {
				Label string           `json:"label"`
				Plays map[string]int64 `json:"plays"`
			} `json:"source_resolution"`
			Missing int `json:"stream_resolution_missing"`
		} `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	found := false
	for _, day := range response.Data.Concurrent {
		if day.Label == start.Format("2006-01-02") {
			found = true
			if day.Plays["total"] != 2 || day.Plays["direct_play"] != 1 || day.Plays["transcode"] != 1 {
				t.Fatal(day)
			}
		}
	}
	if !found {
		t.Fatal("missing concurrency day")
	}
	if len(response.Data.Source) != 1 || response.Data.Source[0].Plays["total"] != 2 || response.Data.Missing != 2 {
		t.Fatal(response.Data)
	}
	w = apiRequest(f.app, "GET", fmt.Sprintf("/api/graphs/breakdowns?days=3&user=%s", "11111111-1111-4111-8111-111111111111"), f.ownerToken, nil, nil)
	if w.Code != 200 || strings.Contains(w.Body.String(), "1080p") {
		t.Fatal("user filter leaked another account", w.Code, w.Body.String())
	}
}

func TestGraphBreakdownRankingUsesRequestedMetric(t *testing.T) {
	a, b := newBreakdownRow("A", ""), newBreakdownRow("B", "")
	addBreakdown(a, "movies", 10)
	addBreakdown(a, "movies", 10)
	addBreakdown(b, "movies", 100)
	rows := map[string]*graphBreakdownRow{"a": a, "b": b}
	if topBreakdown(rows, "plays")[0].Label != "A" || topBreakdown(rows, "seconds")[0].Label != "B" {
		t.Fatal("ranking ignored metric")
	}
}
