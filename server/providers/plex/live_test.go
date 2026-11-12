package plex

import (
	"testing"

	"app/server/providers/provider"
)

func TestLiveConnectionAndNotificationBoundaries(t *testing.T) {
	s := New(provider.Config{URL: "https://media.example/base", APIKey: "private-token"})
	spec, err := s.LiveConnection("device")
	if err != nil || spec.URL != "wss://media.example/base/:/websockets/notifications" {
		t.Fatal("wrong Plex endpoint", spec.URL, err)
	}
	if spec.Header.Get("X-Plex-Token") != "private-token" || spec.Header.Get("X-Plex-Client-Identifier") != "device" || !spec.Binary || spec.PingInterval <= 0 || len(spec.Start) != 0 {
		t.Fatal("wrong Plex connection", spec)
	}
	if _, err := New(provider.Config{URL: "https://media.example"}).LiveConnection("device"); err == nil {
		t.Fatal("connection without a token")
	}
	for _, tc := range []struct {
		body, want string
		invalid    bool
	}{
		{`{"NotificationContainer":{"type":"playing","private":"never persist"}}`, "playing", false},
		{`{"NotificationContainer":{"type":"timeline"}}`, "timeline", false},
		{`{"NotificationContainer":{"type":"transcodeSession.end"}}`, "transcodeSession.end", false},
		{`{"NotificationContainer":{"type":"other"}}`, "", false},
		{`{"NotificationContainer":{"type":"playing","type":"other"}}`, "", true},
		{`{"NotificationContainer":null}`, "", true},
		{`{"NotificationContainer":{"type":"playing","a":{"x":1,"x":2}}}`, "", true},
	} {
		got, reply, err := s.LiveEvent([]byte(tc.body))
		if got != tc.want || reply != nil || (err != nil) != tc.invalid {
			t.Fatal(tc.body, got, err)
		}
	}
}
