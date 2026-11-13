package main

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

// plexStatisticsFixture is a disposable Plex server answering the dashboard
// statistics routes with whatever the test sets.
type plexStatisticsFixture struct {
	mu        sync.Mutex
	bandwidth string
	resources string
	status    int
	timespans []string
	since     []string
}

func newPlexStatisticsRuntime(t *testing.T) (*App, *Store, string, int64, *plexStatisticsFixture) {
	t.Helper()
	a, s := testApp(t)
	token, _ := bootstrapOwner(t, a)
	f := &plexStatisticsFixture{status: 200}
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-Plex-Token") != "fixture-secret" {
			w.WriteHeader(401)
			return
		}
		f.mu.Lock()
		defer f.mu.Unlock()
		switch r.URL.Path {
		case "/proxy/":
			fmt.Fprint(w, `<MediaContainer friendlyName="Plex Fixture" version="1" machineIdentifier="fixture-machine"/>`)
		case "/proxy/library/sections":
			fmt.Fprint(w, `<MediaContainer/>`)
		case "/proxy/statistics/bandwidth":
			f.timespans = append(f.timespans, r.URL.Query().Get("timespan"))
			f.since = append(f.since, r.URL.Query().Get("at>"))
			w.WriteHeader(f.status)
			fmt.Fprint(w, f.bandwidth)
		case "/proxy/statistics/resources":
			if r.URL.Query().Get("timespan") != "6" {
				t.Error("resources not read in real time")
			}
			w.WriteHeader(f.status)
			fmt.Fprint(w, f.resources)
		default:
			t.Error("unexpected Plex fixture path", r.URL.Path)
			w.WriteHeader(404)
		}
	}))
	t.Cleanup(upstream.Close)
	server := createManagedServer(t, a, token, "plex", upstream.URL+"/proxy")
	return a, s, token, server, f
}

func TestPlexServerStatisticsAreReadOnDemand(t *testing.T) {
	a, _, token, server, f := newPlexStatisticsRuntime(t)
	f.bandwidth = `<MediaContainer size="3"><Account id="1" key="/accounts/1" name="owner"/><Device id="7" name="Living Room TV" platform="Roku"/>` +
		`<StatisticsBandwidth accountID="1" deviceID="7" timespan="6" at="1700000000" lan="1" bytes="120000"/>` +
		`<StatisticsBandwidth accountID="1" deviceID="7" timespan="6" at="1700000002" lan="0" bytes="5000"/></MediaContainer>`
	f.resources = `<MediaContainer size="2"><StatisticsResources timespan="6" at="1700000000" hostCpuUtilization="12.5" processCpuUtilization="3.25" hostMemoryUtilization="41" processMemoryUtilization="2.5"/>` +
		`<StatisticsResources timespan="6" at="1700000002" hostCpuUtilization="70" processCpuUtilization="55" hostMemoryUtilization="42"/></MediaContainer>`
	path := fmt.Sprintf("/api/servers/%d/statistics/", server)

	w := apiRequest(a, "GET", path+"bandwidth", token, nil, nil)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	data := responseData(t, w)
	samples := data["samples"].([]any)
	first := samples[0].(map[string]any)
	if data["timespan"] != "seconds" || len(samples) != 2 || first["at"] != "2023-11-14T22:13:20.000000000Z" || first["bytes"].(float64) != 120000 || first["lan"] != true || first["account_id"] != "1" || first["device_id"] != "7" || samples[1].(map[string]any)["lan"] != false {
		t.Fatal(data)
	}
	if accounts := data["accounts"].([]any); len(accounts) != 1 || accounts[0].(map[string]any)["name"] != "owner" {
		t.Fatal(data["accounts"])
	}
	if devices := data["devices"].([]any); len(devices) != 1 || devices[0].(map[string]any)["name"] != "Living Room TV" {
		t.Fatal(data["devices"])
	}
	if strings.Contains(w.Body.String(), "fixture-secret") {
		t.Fatal("server token leaked")
	}
	for span, code := range map[string]string{"hours": "4", "days": "3", "weeks": "2", "months": "1"} {
		if w := apiRequest(a, "GET", path+"bandwidth?timespan="+span, token, nil, nil); w.Code != 200 {
			t.Fatal(span, w.Code)
		}
		f.mu.Lock()
		last := f.timespans[len(f.timespans)-1]
		f.mu.Unlock()
		if last != code {
			t.Fatal(span, "read as Plex timespan", last)
		}
	}
	if w := apiRequest(a, "GET", path+"bandwidth?timespan=years", token, nil, nil); w.Code != 400 {
		t.Fatal("unknown timespan accepted", w.Code)
	}
	// A period ("Last 7 Days") is passed to Plex as its at> filter; none means all.
	if w := apiRequest(a, "GET", path+"bandwidth?timespan=days&since=2026-01-01T00:00:00Z", token, nil, nil); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	f.mu.Lock()
	sinceSent, firstSince := f.since[len(f.since)-1], f.since[0]
	f.mu.Unlock()
	if sinceSent != "1767225600" || firstSince != "" {
		t.Fatal("period filter", sinceSent, firstSince)
	}
	for _, bad := range []string{"yesterday", "2999-01-01T00:00:00Z", "1990-01-01T00:00:00Z"} {
		if w := apiRequest(a, "GET", path+"bandwidth?timespan=days&since="+bad, token, nil, nil); w.Code != 400 {
			t.Fatal("bad since accepted", bad, w.Code)
		}
	}

	w = apiRequest(a, "GET", path+"resources", token, nil, nil)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	readings := responseData(t, w)["samples"].([]any)
	one, two := readings[0].(map[string]any), readings[1].(map[string]any)
	if one["host_cpu"].(float64) != 12.5 || one["process_cpu"].(float64) != 3.25 || one["host_memory"].(float64) != 41 || one["process_memory"].(float64) != 2.5 || two["process_memory"] != nil {
		t.Fatal(readings)
	}
}

func TestPlexServerStatisticsRefusals(t *testing.T) {
	a, s, token, server, f := newPlexStatisticsRuntime(t)
	path := fmt.Sprintf("/api/servers/%d/statistics/", server)
	// Malformed or refused answers are reported, never shown as empty graphs.
	for name, tc := range map[string]struct {
		status          int
		bandwidth, kind string
	}{
		"negative bytes": {200, `<MediaContainer><StatisticsBandwidth at="1700000000" lan="1" bytes="-1"/></MediaContainer>`, "bandwidth"},
		"missing time":   {200, `<MediaContainer><StatisticsBandwidth lan="1" bytes="1"/></MediaContainer>`, "bandwidth"},
		"bad lan":        {200, `<MediaContainer><StatisticsBandwidth at="1700000000" lan="yes" bytes="1"/></MediaContainer>`, "bandwidth"},
		"duplicate attr": {200, `<MediaContainer><StatisticsBandwidth at="1" at="2" bytes="1"/></MediaContainer>`, "bandwidth"},
		"not plex pass":  {401, ``, "bandwidth"},
		"negative cpu":   {200, `<MediaContainer><StatisticsResources at="1700000000" hostCpuUtilization="-5"/></MediaContainer>`, "resources"},
		"unreadable cpu": {200, `<MediaContainer><StatisticsResources at="1700000000" hostCpuUtilization="lots"/></MediaContainer>`, "resources"},
		"server error":   {500, `oops`, "resources"},
	} {
		f.mu.Lock()
		f.status, f.bandwidth, f.resources = tc.status, tc.bandwidth, tc.bandwidth
		f.mu.Unlock()
		if w := apiRequest(a, "GET", path+tc.kind, token, nil, nil); w.Code != 502 || !strings.Contains(w.Body.String(), "STATISTICS_UNAVAILABLE") {
			t.Fatal(name, w.Code, w.Body.String())
		}
	}
	if w := apiRequest(a, "GET", path+"resources", "", nil, nil); w.Code != 401 {
		t.Fatal("anonymous statistics read", w.Code)
	}
	activityExec(t, s, "UPDATE media_servers SET is_active=0 WHERE id=?", server)
	if w := apiRequest(a, "GET", path+"resources", token, nil, nil); w.Code != 409 || !strings.Contains(w.Body.String(), "SERVER_INACTIVE") {
		t.Fatal(w.Code, w.Body.String())
	}
	activityExec(t, s, "INSERT INTO media_servers(server_nickname,service_type,url,api_key) VALUES('Jelly','jellyfin','http://127.0.0.1:9','key')")
	var jellyfin int64
	s.reader.QueryRow("SELECT id FROM media_servers WHERE service_type='jellyfin'").Scan(&jellyfin)
	if w := apiRequest(a, "GET", fmt.Sprintf("/api/servers/%d/statistics/bandwidth", jellyfin), token, nil, nil); w.Code != 409 || !strings.Contains(w.Body.String(), "STATISTICS_UNSUPPORTED") {
		t.Fatal(w.Code, w.Body.String())
	}
	if w := apiRequest(a, "GET", "/api/servers/99999/statistics/bandwidth", token, nil, nil); w.Code != 404 {
		t.Fatal(w.Code)
	}
}
