package main

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"app/server/providers/provider"
)

// A server's release is compared with the tested one only as far as the
// tested release goes, so build suffixes don't count as newer.
func TestVersionCheck(t *testing.T) {
	for _, tc := range []struct{ tested, actual, want string }{
		{"1.43.5", "1.43.5.11079-b3b13e506", "tested"},
		{"1.43.5", "1.43.6.100-abc", "newer"},
		{"1.43.5", "1.42.9", "older"},
		{"12.4.0", "12.4.0", "tested"},
		{"12.4.0", "10.11.2", "older"},
		{"0.9.1.4", "0.9.1.24", "newer"},
		{"5.4.1", "5.4", "older"},
		{"2.38.0", "", ""},
		{"", "4.9.0", ""},
		{"1.0", "nightly", ""},
	} {
		if got := versionCheck(tc.tested, tc.actual); got != tc.want {
			t.Errorf("versionCheck(%q, %q) = %q, want %q", tc.tested, tc.actual, got, tc.want)
		}
	}
}

func TestCleanVersion(t *testing.T) {
	for in, want := range map[string]string{"v5.4.1": "5.4.1", " 2.38.0 ": "2.38.0", "1.43.5.11079-b3b13e506": "1.43.5.11079-b3b13e506", "nightly": "", "1.0 <script>": "", "": ""} {
		if got := provider.CleanVersion(in); got != want {
			t.Errorf("CleanVersion(%q) = %q, want %q", in, got, want)
		}
	}
}

// A service whose connection test only reads users gets its release from its
// own version read; the test still passes when that read fails.
func TestConnectionTestReadsServerVersion(t *testing.T) {
	for _, tc := range []struct {
		failVersion bool
		want        string
	}{{false, "5.4.1"}, {true, ""}} {
		upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			switch r.URL.Path {
			case "/api/heartbeat":
				if tc.failVersion {
					w.WriteHeader(500)
					return
				}
				fmt.Fprint(w, `{"SYSTEM":{"VERSION":"5.4.1","SHOW_SETUP_WIZARD":false}}`)
			case "/api/platforms":
				fmt.Fprint(w, `[]`)
			case "/api/users":
				fmt.Fprint(w, `[]`)
			default:
				w.WriteHeader(404)
			}
		}))
		p, err := newServerConnection(ProviderConfig{"romm", upstream.URL, "key"}, upstream.Client())
		if err != nil {
			t.Fatal(err)
		}
		info, err := p.Test(t.Context())
		upstream.Close()
		if err != nil || info.Name != "RomM" || info.Version != tc.want {
			t.Fatal(info, err)
		}
	}
}
