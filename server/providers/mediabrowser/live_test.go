package mediabrowser

import (
	"net/url"
	"strings"
	"testing"

	"app/server/providers/provider"
)

func TestLiveEnvelopeAndURLBoundaries(t *testing.T) {
	s := New(provider.Config{URL: "https://media.example/base", APIKey: "private +&?"}, false)
	for _, tc := range []struct {
		name, input, want  string
		keepAlive, invalid bool
	}{
		{"session", `{"MessageType":"Sessions","Data":[]}`, "Sessions", false, false},
		{"incremental", `{"MessageType":"PlaybackProgress","Data":{"private":"never logged"}}`, "PlaybackProgress", false, false},
		{"unknown", `{"MessageType":"Other","Data":"private"}`, "", false, false},
		{"keepalive", `{"MessageType":"ForceKeepAlive"}`, "", true, false},
		{"duplicate", `{"MessageType":"Sessions","MessageType":"Other"}`, "", false, true},
		{"lowercase", `{"messagetype":"Sessions"}`, "", false, true},
		{"null", `null`, "", false, true},
		{"oversized", strings.Repeat(" ", provider.MaxLiveFrameBytes+1), "", false, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, reply, err := s.LiveEvent([]byte(tc.input))
			if (err != nil) != tc.invalid || got != tc.want || (string(reply) == `{"MessageType":"KeepAlive"}`) != tc.keepAlive {
				t.Fatal(got, string(reply), err)
			}
		})
	}
	for _, emby := range []bool{false, true} {
		suffix, want := "", "/base"
		if !emby {
			suffix, want = "/socket", "/base/socket"
		}
		spec, err := New(provider.Config{URL: "https://media.example/base", APIKey: "private +&?"}, emby).Live("device", suffix)
		if err != nil {
			t.Fatal(err)
		}
		u, _ := url.Parse(spec.URL)
		if u.Scheme != "wss" || u.Path != want || u.Query().Get("api_key") != "private +&?" || u.Query().Get("deviceId") != "device" || spec.ReadTimeout <= 0 || len(spec.Start) == 0 {
			t.Fatal("incorrect endpoint", spec.URL)
		}
	}
	for _, address := range []string{"http://user:pass@example.test", "ftp://example.test", "http://example.test/?a=1"} {
		if _, err := New(provider.Config{URL: address, APIKey: "key"}, false).Live("device", "/socket"); err == nil {
			t.Fatal("accepted", address)
		}
	}
	if _, err := New(provider.Config{URL: "http://example.test"}, false).Live("device", "/socket"); err == nil {
		t.Fatal("connection without an API key")
	}
}
