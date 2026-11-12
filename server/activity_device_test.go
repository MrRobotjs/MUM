package main

import (
	"database/sql"
	"encoding/json"
	"testing"
)

func TestActivityProviderRecordsClientDeviceAndPlayMethod(t *testing.T) {
	for _, kind := range []string{"jellyfin", "emby"} {
		t.Run(kind, func(t *testing.T) {
			row := activityFixtureRow()
			row["Client"] = "Jellyfin Web"
			row["DeviceName"] = "Bob's Chrome"
			row["PlayState"].(map[string]any)["PlayMethod"] = "Transcode"
			plain := activityFixtureRow()
			plain["Id"] = "plain"
			plain["Client"] = "  "
			plain["PlayState"].(map[string]any)["PlayMethod"] = "SomethingNew"
			body, _ := json.Marshal([]any{row, plain})
			snapshot, err := parseActivitySnapshot(kind, body)
			if err != nil || len(snapshot.Sessions) != 2 {
				t.Fatal(snapshot, err)
			}
			s := snapshot.Sessions[0]
			if s.Client != "Jellyfin Web" || s.Device != "Bob's Chrome" || s.PlayMethod != "transcode" {
				t.Fatal("fields not recorded", s)
			}
			// Blank and unrecognised values are unknown, not a failed snapshot.
			if p := snapshot.Sessions[1]; p.Client != "" || p.Device != "" || p.PlayMethod != "" {
				t.Fatal("unknown values recorded", p)
			}
		})
	}
	for name, mutate := range map[string]func(map[string]any){
		"numeric client":    func(r map[string]any) { r["Client"] = 7 },
		"object device":     func(r map[string]any) { r["DeviceName"] = map[string]any{} },
		"numeric method":    func(r map[string]any) { r["PlayState"].(map[string]any)["PlayMethod"] = 1 },
		"client case alias": func(r map[string]any) { r["Client"] = "a"; r["client"] = "b" },
		"method case alias": func(r map[string]any) {
			r["PlayState"].(map[string]any)["PlayMethod"] = "DirectPlay"
			r["PlayState"].(map[string]any)["playMethod"] = "Transcode"
		},
	} {
		t.Run(name, func(t *testing.T) {
			row := activityFixtureRow()
			mutate(row)
			body, _ := json.Marshal([]any{row})
			if _, err := parseActivitySnapshot("jellyfin", body); err == nil {
				t.Fatal("malformed device fields accepted")
			}
		})
	}
}

func TestActivityDeviceClassificationKeepsPersonalNamesOut(t *testing.T) {
	for _, tc := range []struct{ client, device, want string }{
		{"Jellyfin Web", "Chrome", "Chrome"},
		{"Jellyfin Android TV", "SHIELD Android TV", "NVIDIA Shield"},
		{"Swiftfin", "Christopher's iPhone", "iPhone"},
		{"Jellyfin Media Player", "Living room PC", "Jellyfin Media Player"},
		{"Kodi", "Grandma's box", "Kodi"},
		{"", "Bob's laptop", "Unknown"},
		{"", "", "Unknown"},
		{"A very long client application name that goes on", "x", "A very long client application na..."},
		{"Ünïcödé client name that is quite long here", "x", "Ünïcödé client name that is quite..."},
	} {
		if got := classifyActivityDevice(tc.client, tc.device); got != tc.want {
			t.Fatalf("%q/%q: got %q want %q", tc.client, tc.device, got, tc.want)
		}
	}
}

func applyDeviceSnapshot(t *testing.T, f activityViewFixture, rows ...map[string]any) {
	t.Helper()
	// Claim first, then observe: a snapshot taken before its claim is stale.
	owner, _ := f.store.Authenticate(t.Context(), f.ownerToken)
	claim, err := f.store.beginActivityRead(t.Context(), owner.UUID, f.ownerToken, f.server)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := json.Marshal(rows)
	snapshot, err := parseActivitySnapshot("jellyfin", body)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.store.applyActivitySnapshot(t.Context(), claim, snapshot); err != nil {
		t.Fatal(err)
	}
}

func TestActivityStoreKeepsLastKnownDeviceAndPlayMethod(t *testing.T) {
	f := activityReadFixture(t) // session "session" already observed without device data
	row := func(method any, client any) map[string]any {
		r := activityFixtureRow()
		r["UserId"] = f.service
		r["Client"] = client
		r["DeviceName"] = "Bob's iPhone"
		r["PlayState"].(map[string]any)["PlayMethod"] = method
		return r
	}
	read := func() (client, device, method sql.NullString) {
		f.store.reader.QueryRow("SELECT client,device_name,play_method FROM media_activity_history WHERE external_session_id='session'").Scan(&client, &device, &method)
		return
	}
	applyDeviceSnapshot(t, f, row("DirectPlay", "Swiftfin"))
	if c, d, m := read(); c.String != "Swiftfin" || d.String != "Bob's iPhone" || m.String != "direct_play" {
		t.Fatal("update did not record device data", c, d, m)
	}
	// A later poll without the fields keeps the last known values; a changed
	// delivery mode replaces the previous one.
	applyDeviceSnapshot(t, f, row(nil, nil))
	if c, _, m := read(); c.String != "Swiftfin" || m.String != "direct_play" {
		t.Fatal("unknown values erased recorded data", c, m)
	}
	applyDeviceSnapshot(t, f, row("Transcode", "Swiftfin"))
	if _, _, m := read(); m.String != "transcode" {
		t.Fatal("changed play method not recorded", m)
	}
	var n int
	f.store.reader.QueryRow("SELECT count(*) FROM media_activity_history").Scan(&n)
	if n != 1 {
		t.Fatal("device changes split the observation", n)
	}
}
