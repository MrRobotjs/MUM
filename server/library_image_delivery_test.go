package main

import (
	"net/http"
	"strings"
	"testing"
)

// Change durable state only after the provider has returned the image. This
// exercises the network boundary without sleeps or a held database transaction.
func TestCatalogueImageRechecksStateAfterProviderIO(t *testing.T) {
	for _, tc := range []struct {
		name, sql string
		status    int
	}{
		{"logout", "DELETE FROM app_sessions", 403},
		{"expired_account", "UPDATE user_accounts SET access_expires_at='2000-01-01T00:00:00Z'", 403},
		{"expired_session", "UPDATE app_sessions SET refresh_expires_at='2000-01-01T00:00:00Z'", 403},
		{"disabled_provider", "UPDATE provider_settings SET enabled=0 WHERE provider_id='jellyfin'", 404},
		{"inactive_server", "UPDATE media_servers SET is_active=0", 404},
		{"unavailable_library", "UPDATE media_libraries SET is_available=0", 404},
		{"reconfigured_server", "UPDATE media_servers SET config_revision=config_revision+1", 409},
		{"replaced_poster", "UPDATE media_items SET thumb_path='replacement'", 409},
		{"purged_item", "DELETE FROM media_items", 404},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newCatalogueFixture(t, 1)
			if w := apiRequest(f.a, "POST", f.path("/sync"), f.token, nil, nil); w.Code != 200 {
				t.Fatal(w.Code, w.Body.String())
			}
			thumb := f.list(t, "").Data[0].Thumb
			calls := 0
			f.a.ProviderHTTP = &http.Client{Transport: providerTransport(func(r *http.Request) (*http.Response, error) {
				response, err := http.DefaultTransport.RoundTrip(r)
				if err == nil {
					calls++
					activityExec(t, f.s, tc.sql)
				}
				return response, err
			})}
			w := apiRequest(f.a, "GET", thumb, "", nil, nil)
			if calls != 1 || w.Code != tc.status || strings.Contains(w.Body.String(), "PNG fixture") {
				t.Fatalf("provider calls=%d, status=%d, body=%s", calls, w.Code, w.Body.String())
			}
		})
	}
}

func TestCatalogueImageRequiresFreshAuthorizationForEveryFetch(t *testing.T) {
	f := newCatalogueFixture(t, 1)
	if w := apiRequest(f.a, "POST", f.path("/sync"), f.token, nil, nil); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	thumb := f.list(t, "").Data[0].Thumb
	w := apiRequest(f.a, "GET", thumb, "", nil, nil)
	if w.Code != 200 || w.Header().Get("Cache-Control") != "private, no-store" {
		t.Fatal(w.Code, w.Header())
	}
	activityExec(t, f.s, "DELETE FROM app_sessions")
	if w := apiRequest(f.a, "GET", thumb, "", nil, nil); w.Code != 403 {
		t.Fatal("signed poster survived logout", w.Code)
	}
}
