package main

import (
	"encoding/json"
	"testing"
	"time"
)

// A tz value is an IANA name; anything else is refused.
func TestLoadViewerZone(t *testing.T) {
	for _, name := range []string{"UTC", "America/New_York", "Asia/Kolkata", "Asia/Kathmandu"} {
		if zone, err := loadViewerZone(name); err != nil || zone.String() != name {
			t.Fatal(name, zone, err)
		}
	}
	for _, name := range []string{"", "Local", "/etc/localtime", "../UTC", "Mars/Base", "America/New York", "America/New_York\x00"} {
		if _, err := loadViewerZone(name); err == nil {
			t.Fatalf("admitted %q", name)
		}
	}
}

// Quarter-hour groups land in the right local hour even in zones offset by
// half or three quarters of an hour.
func TestZoneQuarter(t *testing.T) {
	kathmandu, _ := time.LoadLocation("Asia/Kathmandu")   // UTC+5:45
	at, err := zoneQuarter("2026-03-01T18", 1, kathmandu) // 18:15 UTC
	if err != nil || at.Format("2006-01-02 15:04") != "2026-03-02 00:00" {
		t.Fatal(at, err)
	}
	for _, bad := range []struct {
		hour    string
		quarter int64
	}{{"2026-03-01T24", 0}, {"2026-03-01", 0}, {"2026-03-01T18", 4}, {"2026-03-01T18", -1}} {
		if _, err := zoneQuarter(bad.hour, bad.quarter, time.UTC); err == nil {
			t.Fatal("admitted", bad)
		}
	}
}

// Hourly activity follows the tz value; a malformed one is refused.
func TestGraphAnalyticsViewerZone(t *testing.T) {
	f := activityReadFixture(t)
	activityExec(t, f.store, "DELETE FROM media_activity_current")
	seedGraphHistory(t, f, f.server, f.service, map[time.Duration]int{5 * time.Hour: 3})
	for _, name := range []string{"Asia/Kolkata", "America/Los_Angeles"} {
		zone, _ := time.LoadLocation(name)
		got := graphRead(t, f, f.ownerToken, "?days=2&tz="+name)
		want := time.Now().Add(-5 * time.Hour).In(zone).Hour()
		if got.Data.Hourly[want].Plays != 3 || got.Meta.Filters["tz"] != name {
			t.Fatal(name, want, got.Data.Hourly, got.Meta.Filters)
		}
	}
	for _, query := range []string{"?tz=Local", "?tz=Mars/Base", "?tz=", "?tz=UTC&tz=UTC"} {
		if w := apiRequest(f.app, "GET", "/api/graphs/analytics"+query, f.ownerToken, nil, nil); w.Code != 400 {
			t.Fatal("malformed tz admitted", query, w.Code)
		}
	}
	if w := apiRequest(f.app, "GET", "/api/graphs/play-history?tz=Mars/Base", f.ownerToken, nil, nil); w.Code != 400 {
		t.Fatal("play history admitted a malformed tz", w.Code)
	}
}

// A play counts on the calendar day it started in the viewer's zone.
func TestGraphPlayHistoryViewerZone(t *testing.T) {
	f := activityReadFixture(t)
	activityExec(t, f.store, "DELETE FROM media_activity_current")
	activityExec(t, f.store, "DELETE FROM media_activity_history")
	// 02:00 UTC two days ago is still the evening before in Los Angeles.
	start := zoneToday(time.Now(), time.UTC).AddDate(0, 0, -2).Add(2 * time.Hour)
	seedWatch(t, f, "z", "z1", "Movie", "A Movie", start, 30)
	la, _ := time.LoadLocation("America/Los_Angeles")
	for zone, day := range map[string]string{"UTC": start.Format("2006-01-02"), "America/Los_Angeles": start.In(la).Format("2006-01-02")} {
		w := apiRequest(f.app, "GET", "/api/graphs/play-history?days=7&tz="+zone, f.ownerToken, nil, nil)
		var body playHistoryBody
		if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &body) != nil {
			t.Fatal(zone, w.Code, w.Body.String())
		}
		found := false
		for _, b := range body.Data.Buckets {
			if b.Seconds["movies"] != 0 {
				found = b.Start == day && b.Seconds["movies"] == 1800
			}
		}
		if !found || body.Data.Buckets[len(body.Data.Buckets)-1].End != zoneToday(time.Now(), mustZone(zone)).Format("2006-01-02") {
			t.Fatalf("%s: want the play on %s, got %+v", zone, day, body.Data.Buckets)
		}
	}
}

func mustZone(name string) *time.Location {
	zone, err := time.LoadLocation(name)
	if err != nil {
		panic(err)
	}
	return zone
}
