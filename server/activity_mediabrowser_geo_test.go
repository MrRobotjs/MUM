package main

import (
	"app/server/providers/provider"
	"io"
	"net/http"
	"strings"
	"testing"
)

func TestMediaBrowserLocationsUsePlexGeoAndSkipPrivate(t *testing.T) {
	a, _ := testApp(t)
	token, _ := bootstrapOwner(t, a)
	calls := 0
	a.ProviderHTTP = &http.Client{Transport: providerTransport(func(r *http.Request) (*http.Response, error) {
		calls++
		if r.URL.Host != "plex.tv" || r.URL.Query().Get("ip_address") != "8.8.8.8" || r.Header.Get("X-Plex-Token") != "fixture-secret" {
			t.Errorf("unexpected GeoIP request")
		}
		return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": {"application/json"}}, Body: io.NopCloser(strings.NewReader(`{"ip":"8.8.8.8","coordinates":"37.4, -122.1"}`)), Request: r}, nil
	})}
	snapshot := activitySnapshot{Provider: "jellyfin", Sessions: []activitySession{{Display: &provider.ActivityDisplay{IP: "8.8.8.8", LocationType: "WAN"}}, {Display: &provider.ActivityDisplay{IP: "192.168.1.2", LocationType: "LAN"}}}}
	a.enrichMediaBrowserLocations(t.Context(), &snapshot)
	if calls != 0 || snapshot.Sessions[0].Display.Latitude != nil {
		t.Fatal("lookup without configured Plex")
	}
	createManagedServer(t, a, token, "plex", "http://fixture.test")
	a.enrichMediaBrowserLocations(t.Context(), &snapshot)
	d := snapshot.Sessions[0].Display
	if calls != 1 || d.Latitude == nil || *d.Latitude != 37.4 || d.Longitude == nil || snapshot.Sessions[1].Display.Latitude != nil {
		t.Fatalf("unexpected enrichment: calls=%d display=%+v", calls, d)
	}
	a.enrichMediaBrowserLocations(t.Context(), &snapshot)
	if calls != 1 {
		t.Fatal("GeoIP cache not reused")
	}
	snapshot.Provider = "emby"
	snapshot.Sessions[0].Display.Latitude = nil
	snapshot.Sessions[0].Display.Longitude = nil
	a.enrichMediaBrowserLocations(t.Context(), &snapshot)
	if calls != 1 || snapshot.Sessions[0].Display.Latitude == nil {
		t.Fatal("Emby did not reuse Plex GeoIP cache")
	}
}
