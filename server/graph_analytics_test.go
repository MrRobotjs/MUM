package main

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"
)

type graphResponse struct {
	Data struct {
		Hourly []struct {
			Hour  int   `json:"hour"`
			Plays int64 `json:"plays"`
		} `json:"hourly_activity"`
		WatchTime []any `json:"watch_time_activity"`
		Devices   []any `json:"device_preferences"`
		Playback  []any `json:"playback_health"`
		Separated *struct {
			Enabled bool `json:"enabled"`
			Servers []struct {
				ID          int64  `json:"id"`
				Key         string `json:"key"`
				Name        string `json:"name"`
				ServiceType string `json:"service_type"`
			} `json:"servers"`
			Hourly []struct {
				Hour   int              `json:"hour"`
				Label  string           `json:"label"`
				Values map[string]int64 `json:"values"`
			} `json:"hourly_activity"`
			WatchTime []any `json:"watch_time_activity"`
			Devices   struct {
				Categories []any `json:"categories"`
				Rows       []any `json:"rows"`
			} `json:"device_preferences"`
			Playback struct {
				Categories []any `json:"categories"`
				Rows       []any `json:"rows"`
			} `json:"playback_health"`
		} `json:"separated"`
	} `json:"data"`
	Meta struct {
		GeneratedAt string         `json:"generated_at"`
		Notes       []string       `json:"notes"`
		Unavailable []string       `json:"unavailable"`
		Filters     map[string]any `json:"filters"`
	} `json:"meta"`
}

// seedGraphHistory records ended observations started at fixed UTC hours
// relative to now: count observations per hours-ago offset.
func seedGraphHistory(t *testing.T, f activityViewFixture, server int64, service string, startedAgo map[time.Duration]int) {
	t.Helper()
	err := f.store.write(t.Context(), func(tx *sql.Tx) error {
		n := 0
		for ago, count := range startedAgo {
			for i := 0; i < count; i++ {
				at := utcTimestamp(time.Now().Add(-ago))
				n++
				if _, err := tx.ExecContext(t.Context(), `INSERT INTO media_activity_history(server_id,external_session_id,service_uuid,owner_uuid,item_id,media_type,title,first_seen_at,last_seen_at,ended_at,end_reason,paused) VALUES(?,?,?,NULL,'graph-item','Movie','Private graph title',?,?,?,'not_observed',0)`, server, fmt.Sprintf("graph-%d-%d", server, n), service, at, at, at); err != nil {
					return err
				}
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}

func graphRead(t *testing.T, f activityViewFixture, token, query string) graphResponse {
	t.Helper()
	w := apiRequest(f.app, "GET", "/api/graphs/analytics"+query, token, nil, nil)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	var got graphResponse
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	for _, private := range []string{"Private graph title", "graph-item", f.service, f.user, "api_key", "external_session_id"} {
		if strings.Contains(w.Body.String(), private) {
			t.Fatal("private field in analytics", private)
		}
	}
	return got
}

func hourOf(ago time.Duration) int { return time.Now().UTC().Add(-ago).Hour() }

func TestGraphAnalyticsHourlyFromRecordedHistory(t *testing.T) {
	f := activityReadFixture(t) // one current observation started now
	seedGraphHistory(t, f, f.server, f.service, map[time.Duration]int{3 * time.Hour: 4, 30 * time.Hour: 2, 40 * 24 * time.Hour: 5})
	got := graphRead(t, f, f.ownerToken, "")
	if len(got.Data.Hourly) != 24 {
		t.Fatal("hourly buckets", len(got.Data.Hourly))
	}
	want := map[int]int64{}
	want[hourOf(0)]++
	want[hourOf(3*time.Hour)] += 4
	want[hourOf(30*time.Hour)] += 2 // inside the default 30-day window; the 40-day rows are not
	var total int64
	for i, bucket := range got.Data.Hourly {
		if bucket.Hour != i || bucket.Plays != want[i] {
			t.Fatal("hour", i, bucket, want)
		}
		total += bucket.Plays
	}
	if total != 7 {
		t.Fatal("window total", total)
	}
	if day := graphRead(t, f, f.ownerToken, "?days=1"); day.Data.Hourly[hourOf(30*time.Hour)].Plays != want[hourOf(30*time.Hour)]-2 {
		t.Fatal("one-day window kept older observations", day.Data.Hourly)
	}
	if long := graphRead(t, f, f.ownerToken, "?days=365"); long.Data.Hourly[hourOf(40*24*time.Hour)].Plays < 5 {
		t.Fatal("year window dropped observations", long.Data.Hourly)
	}
}

func TestGraphAnalyticsUnrecordedDatasetsAreUnavailableNotZero(t *testing.T) {
	f := activityReadFixture(t)
	got := graphRead(t, f, f.ownerToken, "")
	// Device and playback data are recorded but this fixture has none: the
	// device mix is empty and playback counts are zero. Watch time is recorded
	// too: one bucket per day of the window.
	if len(got.Data.WatchTime) != 30 || len(got.Data.Devices) != 0 || len(got.Data.Playback) != 3 {
		t.Fatal("invented datasets", got.Data)
	}
	want := []string{}
	if strings.Join(got.Meta.Unavailable, ",") != strings.Join(want, ",") {
		t.Fatal("unavailable datasets", got.Meta.Unavailable)
	}
	joined := strings.ToLower(strings.Join(got.Meta.Notes, " "))
	shown := ""
	for _, note := range got.Meta.Notes {
		if strings.Contains(strings.ToLower(note), "playback health") {
			shown = strings.ToLower(note) // the page displays only this note
		}
	}
	if !strings.Contains(joined, "playback health") || !strings.Contains(shown, "utc") {
		t.Fatal("notes must explain unavailable playback health and UTC hours", got.Meta.Notes)
	}
	if got.Meta.GeneratedAt == "" || got.Data.Separated != nil {
		t.Fatal(got.Meta, got.Data.Separated)
	}
}

func TestGraphAnalyticsServerFilterAndSeparatedMode(t *testing.T) {
	f := activityReadFixture(t)
	inserted, err := f.store.writer.Exec(`INSERT INTO media_servers(server_nickname,service_type,url) VALUES('second','emby','http://example.invalid')`)
	if err != nil {
		t.Fatal(err)
	}
	activityExec(t, f.store, "UPDATE provider_settings SET enabled=1 WHERE provider_id='emby'")
	second, _ := inserted.LastInsertId()
	secondService := seedService(t, f.store, second)
	seedGraphHistory(t, f, second, secondService, map[time.Duration]int{2 * time.Hour: 3})
	only := graphRead(t, f, f.ownerToken, fmt.Sprintf("?server_id=%d", second))
	if only.Data.Hourly[hourOf(2*time.Hour)].Plays != 3 || only.Data.Hourly[hourOf(0)].Plays != boolCount(hourOf(0) == hourOf(2*time.Hour))*3 {
		t.Fatal("server filter", only.Data.Hourly)
	}
	none := graphRead(t, f, f.ownerToken, "?server_id=999999")
	if sumHourly(none) != 0 || strings.Join(none.Meta.Unavailable, ",") != "device_preferences,hourly_activity,playback_health,watch_time_activity" {
		t.Fatal("a server that records no activity must report hourly activity unavailable, not zero", none.Data.Hourly, none.Meta.Unavailable)
	}
	// A server filter disables the separated breakdown, as before.
	if filtered := graphRead(t, f, f.ownerToken, fmt.Sprintf("?server_id=%d&server_mode=separated", second)); filtered.Data.Separated != nil {
		t.Fatal("separated breakdown for one server")
	}
	split := graphRead(t, f, f.ownerToken, "?server_id=all&server_mode=separated")
	s := split.Data.Separated
	if s == nil || !s.Enabled || len(s.Servers) != 2 || len(s.Hourly) != 24 {
		t.Fatal("separated payload", s)
	}
	keys := map[int64]string{}
	for _, server := range s.Servers {
		wantName, wantType := "test", "jellyfin"
		if server.ID == second {
			wantName, wantType = "second", "emby"
		}
		if server.Key != fmt.Sprintf("s%d", server.ID) || server.Name != wantName || server.ServiceType != wantType {
			t.Fatal("server meta", server)
		}
		keys[server.ID] = server.Key
	}
	h := s.Hourly[hourOf(2*time.Hour)]
	if h.Label != fmt.Sprintf("%02d:00", hourOf(2*time.Hour)) || h.Values[keys[second]] != 3 {
		t.Fatal("separated hourly", h)
	}
	if s.Hourly[hourOf(0)].Values[keys[f.server]] < 1 || len(s.WatchTime) != 30 || len(s.Devices.Rows) != 2 || len(s.Playback.Rows) != 2 {
		t.Fatal("separated datasets", s)
	}
	if sumHourly(split) != 4 {
		t.Fatal("combined total in separated mode", sumHourly(split))
	}
}

func TestGraphAnalyticsExcludesInactiveSources(t *testing.T) {
	f := activityReadFixture(t)
	seedGraphHistory(t, f, f.server, f.service, map[time.Duration]int{time.Hour: 2})
	activityExec(t, f.store, "UPDATE media_servers SET is_active=0 WHERE id=?", f.server)
	if got := graphRead(t, f, f.ownerToken, "?server_mode=separated"); sumHourly(got) != 0 || len(got.Data.Separated.Servers) != 0 || got.Meta.Unavailable[1] != "hourly_activity" {
		t.Fatal("inactive server counted", got.Data, got.Meta.Unavailable)
	}
	activityExec(t, f.store, "UPDATE media_servers SET is_active=1 WHERE id=?", f.server)
	activityExec(t, f.store, "UPDATE provider_settings SET enabled=0 WHERE provider_id='jellyfin'")
	if got := graphRead(t, f, f.ownerToken, ""); sumHourly(got) != 0 {
		t.Fatal("disabled provider counted", got.Data.Hourly)
	}
}

func TestGraphAnalyticsAuthorityAndValidation(t *testing.T) {
	f := activityReadFixture(t)
	if w := apiRequest(f.app, "GET", "/api/graphs/analytics", "", nil, nil); w.Code != 401 {
		t.Fatal("anonymous analytics", w.Code)
	}
	activityExec(t, f.store, "DELETE FROM admin_privileges WHERE user_uuid=?", f.user)
	if w := apiRequest(f.app, "GET", "/api/graphs/analytics", f.token, nil, nil); w.Code != 403 {
		t.Fatal("ordinary account read all-server analytics", w.Code, w.Body.String())
	}
	for _, query := range []string{"?days=0", "?days=366", "?days=07", "?days=x", "?server_id=0", "?server_id=x", "?server_id=01", "?server_mode=split", "?other=1", "?days=1&days=2"} {
		if w := apiRequest(f.app, "GET", "/api/graphs/analytics"+query, f.ownerToken, nil, nil); w.Code != 400 {
			t.Fatal("malformed query admitted", query, w.Code)
		}
	}
	for _, query := range []string{"?days=1", "?days=365&server_id=all&server_mode=combined", "?server_mode=separated"} {
		if w := apiRequest(f.app, "GET", "/api/graphs/analytics"+query, f.ownerToken, nil, nil); w.Code != 200 {
			t.Fatal("valid query refused", query, w.Code, w.Body.String())
		}
	}
	activityExec(t, f.store, "DELETE FROM app_sessions")
	if w := apiRequest(f.app, "GET", "/api/graphs/analytics", f.ownerToken, nil, nil); w.Code != 401 {
		t.Fatal("revoked session read analytics", w.Code)
	}
}

func sumHourly(g graphResponse) int64 {
	var total int64
	for _, bucket := range g.Data.Hourly {
		total += bucket.Plays
	}
	return total
}

func boolCount(b bool) int64 {
	if b {
		return 1
	}
	return 0
}

// seedDeviceHistory records ended observations with client, device and play
// method; a nil method or empty client/device stores NULL (unknown).
func seedDeviceHistory(t *testing.T, f activityViewFixture, rows []struct {
	client, device, method string
	count                  int
}) {
	t.Helper()
	err := f.store.write(t.Context(), func(tx *sql.Tx) error {
		n := 0
		for _, r := range rows {
			for i := 0; i < r.count; i++ {
				n++
				at := utcTimestamp(time.Now().Add(-time.Hour))
				if _, err := tx.ExecContext(t.Context(), `INSERT INTO media_activity_history(server_id,external_session_id,service_uuid,item_id,media_type,title,first_seen_at,last_seen_at,ended_at,end_reason,paused,client,device_name,play_method)
				 VALUES(?,?,?,'item','Movie','Seeded',?,?,?,'not_observed',0,nullif(?,''),nullif(?,''),nullif(?,''))`, f.server, fmt.Sprintf("device-%d", n), f.service, at, at, at, r.client, r.device, r.method); err != nil {
					return err
				}
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}

func TestGraphAnalyticsDeviceMixAndPlaybackFromRecordedFields(t *testing.T) {
	f := activityReadFixture(t) // one current observation without device data
	seedDeviceHistory(t, f, []struct {
		client, device, method string
		count                  int
	}{
		{"Jellyfin Web", "Chrome", "direct_play", 3},
		{"Swiftfin", "Bob's iPhone", "transcode", 2},
		{"Kodi", "Grandma's box", "direct_stream", 1},
		{"", "", "", 1}, // recorded before device fields existed
	})
	w := apiRequest(f.app, "GET", "/api/graphs/analytics?server_mode=separated", f.ownerToken, nil, nil)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	for _, private := range []string{"Bob's iPhone", "Grandma", "Seeded"} {
		if strings.Contains(w.Body.String(), private) {
			t.Fatal("personal device name or title in analytics", private)
		}
	}
	var got struct {
		Data struct {
			Devices []struct {
				Name  string
				Value int64
			} `json:"device_preferences"`
			Playback []struct {
				Name  string
				Value int64
				Color string
			} `json:"playback_health"`
			Separated struct {
				Devices struct {
					Categories []struct{ Key string } `json:"categories"`
					Rows       []struct {
						ServerID int64            `json:"server_id"`
						Total    int64            `json:"total"`
						Values   map[string]int64 `json:"values"`
						Counts   map[string]int64 `json:"counts"`
					} `json:"rows"`
				} `json:"device_preferences"`
				Playback struct {
					Rows []struct {
						Total  int64            `json:"total"`
						Counts map[string]int64 `json:"counts"`
						Values map[string]int64 `json:"values"`
					} `json:"rows"`
				} `json:"playback_health"`
			} `json:"separated"`
		} `json:"data"`
		Meta struct {
			Unavailable []string         `json:"unavailable"`
			Playback    map[string]int64 `json:"playback_health"`
		} `json:"meta"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	devices := map[string]int64{}
	for _, d := range got.Data.Devices {
		devices[d.Name] = d.Value
	}
	if len(devices) != 3 || devices["Chrome"] != 50 || devices["iPhone"] != 33 || devices["Kodi"] != 17 {
		t.Fatal("device mix", got.Data.Devices)
	}
	playback := map[string]int64{}
	for _, p := range got.Data.Playback {
		playback[p.Name] = p.Value
	}
	if len(got.Data.Playback) != 3 || playback["Direct Play"] != 3 || playback["Direct Stream"] != 1 || playback["Transcode"] != 2 || got.Data.Playback[0].Color == "" {
		t.Fatal("playback health", got.Data.Playback)
	}
	if len(got.Meta.Unavailable) != 0 {
		t.Fatal("recorded datasets still unavailable", got.Meta.Unavailable)
	}
	if got.Meta.Playback["total_rows_considered"] != 8 || got.Meta.Playback["rows_with_playback_mode"] != 6 || got.Meta.Playback["rows_with_device"] != 6 {
		t.Fatal("coverage meta", got.Meta.Playback)
	}
	sd := got.Data.Separated.Devices
	if len(sd.Categories) != 3 || len(sd.Rows) != 1 || sd.Rows[0].ServerID != f.server || sd.Rows[0].Total != 6 || sd.Rows[0].Counts["iPhone"] != 2 || sd.Rows[0].Values["Chrome"] != 50 {
		t.Fatal("separated device mix", sd)
	}
	sp := got.Data.Separated.Playback.Rows
	if len(sp) != 1 || sp[0].Total != 6 || sp[0].Counts["Transcode"] != 2 || sp[0].Values["Direct Play"] != 50 {
		t.Fatal("separated playback", sp)
	}
}

func TestGraphAnalyticsDeviceMixGroupsBeyondTopFour(t *testing.T) {
	f := activityReadFixture(t)
	seedDeviceHistory(t, f, []struct {
		client, device, method string
		count                  int
	}{
		{"Jellyfin Web", "Chrome", "", 5}, {"Jellyfin Web", "Firefox", "", 4}, {"Infuse", "Apple TV", "", 3},
		{"Kodi", "box", "", 2}, {"Plexamp", "phone", "", 1}, {"Finamp", "phone", "", 1},
	})
	var got struct {
		Data struct {
			Devices []struct {
				Name  string
				Value int64
			} `json:"device_preferences"`
		} `json:"data"`
	}
	json.Unmarshal(apiRequest(f.app, "GET", "/api/graphs/analytics", f.ownerToken, nil, nil).Body.Bytes(), &got)
	names := []string{}
	for _, d := range got.Data.Devices {
		names = append(names, d.Name)
	}
	if strings.Join(names, ",") != "Chrome,Firefox,Apple TV,Kodi,Others" || got.Data.Devices[4].Value != 13 {
		t.Fatal("top four plus others", got.Data.Devices)
	}
}
