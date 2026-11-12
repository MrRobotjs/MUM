package main

import (
	"app/server/providers/plex"
	"app/server/providers/provider"
	"io"
	"net/http"
	"strings"
	"testing"
)

func TestPlexAvatarFollowsApprovedImageRedirectWithoutCredentials(t *testing.T) {
	var calls int
	p, _ := newServerConnection(ProviderConfig{"plex", "http://127.0.0.1", "private-key"}, &http.Client{Transport: providerTransport(func(r *http.Request) (*http.Response, error) {
		calls++
		if r.URL.Host != "plex.tv" || r.Header.Get("X-Plex-Token") != "" || r.Header.Get("Authorization") != "" || r.Header.Get("Cookie") != "" {
			t.Fatal("avatar credentials/origin escaped")
		}
		if calls == 1 {
			return &http.Response{StatusCode: 302, Header: http.Header{"Location": {"https://plex.tv/avatars/EB9F9F/31/3/80"}}, Body: io.NopCloser(strings.NewReader("")), Request: r}, nil
		}
		return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": {"image/png"}}, Body: io.NopCloser(strings.NewReader("PNG avatar")), Request: r}, nil
	})})
	_, body, err := p.activityAvatar(t.Context(), "https://plex.tv/users/fixture-user/avatar")
	if err != nil || string(body) != "PNG avatar" || calls != 2 {
		t.Fatal("normal Plex image redirect refused", err, calls)
	}
}

func TestPlexLocalAvatarRedirectStripsProviderKeyAtCloudBoundary(t *testing.T) {
	calls := 0
	p, _ := newServerConnection(ProviderConfig{"plex", "http://fixture.test/proxy", "private-key"}, &http.Client{Transport: providerTransport(func(r *http.Request) (*http.Response, error) {
		calls++
		if calls == 1 {
			if r.URL.Host != "fixture.test" || r.Header.Get("X-Plex-Token") != "private-key" {
				t.Fatal("local avatar lost source credentials")
			}
			return &http.Response{StatusCode: 302, Header: http.Header{"Location": {"https://plex.tv/avatars/EB9F9F/31/3/80"}}, Body: io.NopCloser(strings.NewReader("")), Request: r}, nil
		}
		if r.URL.Host != "plex.tv" || r.Header.Get("X-Plex-Token") != "" || r.Header.Get("Authorization") != "" || r.Header.Get("Cookie") != "" {
			t.Fatal("provider credential escaped local origin")
		}
		return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": {"image/png"}}, Body: io.NopCloser(strings.NewReader("PNG avatar")), Request: r}, nil
	})})
	_, _, err := p.activityAvatar(t.Context(), "/accounts/42/thumb")
	if err != nil || calls != 2 {
		t.Fatal("local-to-cloud avatar redirect failed", err, calls)
	}
}

func TestPlexAvatarRejectsRedirectLoopsAndDowngrades(t *testing.T) {
	for _, destination := range []string{"http://plex.tv/avatars/test", "https://plex.tv.evil.test/avatar", "https://plex.tv:444/avatars/test", "https://plex.tv/users/fixture-user/avatar"} {
		calls := 0
		p, _ := newServerConnection(ProviderConfig{"plex", "http://fixture.test", "private-key"}, &http.Client{Transport: providerTransport(func(r *http.Request) (*http.Response, error) {
			calls++
			return &http.Response{StatusCode: 302, Header: http.Header{"Location": {destination}}, Body: io.NopCloser(strings.NewReader("")), Request: r}, nil
		})})
		if _, _, err := p.activityAvatar(t.Context(), "https://plex.tv/users/fixture-user/avatar"); err == nil || calls > 4 {
			t.Fatal("unbounded/unsafe avatar redirect", err, calls)
		}
	}
}

func TestPlexGeoFailureDoesNotLoseSessionsAndIsCached(t *testing.T) {
	geoCalls := 0
	body := strings.Replace(strings.Replace(plexRichPlaying, `address="127.0.0.1" local="1"`, `address="8.8.8.8" local="0"`, 1), `location="lan"`, `location="wan"`, 1)
	p, _ := newServerConnection(ProviderConfig{"plex", "http://fixture.test", "fixture-secret"}, &http.Client{Transport: providerTransport(func(r *http.Request) (*http.Response, error) {
		text := body
		status := 200
		if r.URL.Host == "plex.tv" {
			geoCalls++
			status = 503
			text = "unavailable"
		} else if strings.HasPrefix(r.URL.Path, "/library/") {
			text = plexSingleOriginalSource
		}
		return &http.Response{StatusCode: status, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(text)), Request: r}, nil
	})})
	c := p
	c.locations = &provider.LocationCache{}
	for i := 0; i < 2; i++ {
		s, err := c.readActivitySnapshot(t.Context())
		if err != nil || len(s.Sessions) != 1 || s.Sessions[0].Display.Latitude != nil {
			t.Fatal("optional GeoIP failure lost session", err)
		}
	}
	if geoCalls != 1 {
		t.Fatal("negative GeoIP cache not applied", geoCalls)
	}
}

func TestPlexWANCoordinatesSkipLANAndUseBoundedCache(t *testing.T) {
	var geoCalls int
	body := strings.Replace(plexRichPlaying, `address="127.0.0.1" local="1"`, `address="8.8.8.8" local="0"`, 1)
	body = strings.Replace(body, `location="lan"`, `location="wan"`, 1)
	p, _ := newServerConnection(ProviderConfig{"plex", "http://fixture.test", "fixture-secret"}, &http.Client{Transport: providerTransport(func(r *http.Request) (*http.Response, error) {
		text := body
		kind := "application/xml"
		if r.URL.Host == "plex.tv" {
			geoCalls++
			if r.URL.Path != "/api/v2/geoip" || r.URL.Query().Get("ip_address") != "8.8.8.8" || r.Header.Get("X-Plex-Token") != "fixture-secret" {
				t.Fatal("incorrect GeoIP request")
			}
			text = `{"ip":"8.8.8.8","coordinates":"37.4, -122.1"}`
			kind = "application/json"
		} else if strings.HasPrefix(r.URL.Path, "/library/") {
			text = plexSingleOriginalSource
		}
		return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": {kind}}, Body: io.NopCloser(strings.NewReader(text)), Request: r}, nil
	})})
	concrete := p
	concrete.locations = &provider.LocationCache{}
	for i := 0; i < 2; i++ {
		s, err := concrete.readActivitySnapshot(t.Context())
		if err != nil || len(s.Sessions) != 1 {
			t.Fatal(err)
		}
		d := s.Sessions[0].Display
		if d.Latitude == nil || *d.Latitude != 37.4 || d.Longitude == nil || *d.Longitude != -122.1 {
			t.Fatalf("WAN coordinates missing: %+v", d)
		}
	}
	if geoCalls != 1 {
		t.Fatal("GeoIP cache not reused", geoCalls)
	}
	body = plexRichPlaying
	s, err := concrete.readActivitySnapshot(t.Context())
	if err != nil || s.Sessions[0].Display.Latitude != nil || geoCalls != 1 {
		t.Fatal("LAN was geolocated", err, geoCalls)
	}
}

func TestPlexGeoCoordinatesRejectInvalidValuesAndPrivateIPs(t *testing.T) {
	for _, ip := range []string{"127.0.0.1", "192.168.1.2", "10.0.0.2", "172.16.1.2", "100.64.0.2", "169.254.1.1", "192.0.2.1", "198.51.100.1", "203.0.113.1", "::1", "fe80::1", "fd00::1", "2001:db8::1", "224.0.0.1", "not an address"} {
		if plex.PublicSessionAddress(ip).IsValid() {
			t.Fatal("non-public address admitted", ip)
		}
	}
	for _, body := range []string{`{"coordinates":"NaN,0"}`, `{"coordinates":"91,0"}`, `{"coordinates":"0,181"}`, `{"coordinates":"0"}`, `{"coordinates":"1,2","coordinates":"3,4"}`} {
		if _, err := plex.ParseGeo([]byte(body), "application/json"); err == nil {
			t.Fatal("invalid coordinates accepted", body)
		}
	}
	point, err := plex.ParseGeo([]byte(`<location coordinates="-33.9, 151.2"/>`), "application/xml")
	if err != nil || point.Latitude != -33.9 || point.Longitude != 151.2 {
		t.Fatal(point, err)
	}
	if !plex.PublicSessionAddress("::ffff:8.8.8.8").Is4() || !plex.PublicSessionAddress("[2606:4700:4700::1111]:443").Is6() {
		t.Fatal("public address normalization failed")
	}
}
