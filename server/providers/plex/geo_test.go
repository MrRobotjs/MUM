package plex

import (
	"io"
	"net/http"
	"strconv"
	"strings"
	"testing"

	"app/server/providers/provider"
)

type roundTrip func(*http.Request) (*http.Response, error)

func (f roundTrip) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

// One snapshot makes at most 16 plex.tv lookups and keeps every session.
func TestLocationLookupBudget(t *testing.T) {
	calls := 0
	client := &http.Client{Transport: roundTrip(func(r *http.Request) (*http.Response, error) {
		calls++
		return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": {"application/json"}}, Body: io.NopCloser(strings.NewReader(`{"coordinates":"1,2"}`)), Request: r}, nil
	})}
	s := New(provider.Config{URL: "http://fixture.test", APIKey: "fixture-secret", Transport: provider.Transport{Client: client}, Locations: &provider.LocationCache{}})
	snapshot := provider.ActivitySnapshot{}
	for i := 1; i <= 40; i++ {
		snapshot.Sessions = append(snapshot.Sessions, provider.ActivitySession{Display: &provider.ActivityDisplay{IP: "8.8.4." + strconv.Itoa(i), LocationType: "WAN"}})
	}
	s.enrichLocations(t.Context(), &snapshot)
	located := 0
	for _, session := range snapshot.Sessions {
		if session.Display.Latitude != nil {
			located++
		}
	}
	if calls != maxGeoLookups || located != maxGeoLookups || len(snapshot.Sessions) != 40 {
		t.Fatal("GeoIP lookup budget exceeded", calls, located)
	}
}

// A reply naming another address is not used.
func TestLocationLookupRejectsAddressMismatch(t *testing.T) {
	client := &http.Client{Transport: roundTrip(func(r *http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": {"application/json"}}, Body: io.NopCloser(strings.NewReader(`{"ip":"1.1.1.1","coordinates":"1,2"}`)), Request: r}, nil
	})}
	s := New(provider.Config{URL: "http://fixture.test", APIKey: "fixture-secret", Transport: provider.Transport{Client: client}})
	snapshot := provider.ActivitySnapshot{Sessions: []provider.ActivitySession{{Display: &provider.ActivityDisplay{IP: "8.8.8.8", LocationType: "WAN"}}}}
	s.enrichLocations(t.Context(), &snapshot)
	if snapshot.Sessions[0].Display.Latitude != nil {
		t.Fatal("location for another address accepted")
	}
}
