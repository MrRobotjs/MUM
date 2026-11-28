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
		// Library notifications are read by LiveLibraryChanges, not as playback.
		{`{"NotificationContainer":{"type":"timeline"}}`, "", false},
		{`{"NotificationContainer":{"type":"activity"}}`, "", false},
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

// A "playing" notification carries each session's state; only the session,
// item, state and position are read, and anything doubtful is refused.
func TestLivePlaybackEvents(t *testing.T) {
	s := New(provider.Config{URL: "https://media.example", APIKey: "private-token"})
	events, err := s.LivePlayback([]byte(`{"NotificationContainer":{"type":"playing","size":2,"PlaySessionStateNotification":[
		{"sessionKey":"10","clientIdentifier":"private","ratingKey":"123","key":"/library/metadata/123","viewOffset":2000,"state":"paused"},
		{"sessionKey":"11","ratingKey":"124","state":"stopped"}]}}`))
	if err != nil || len(events) != 2 {
		t.Fatal(events, err)
	}
	if e := events[0]; e.Session != "10" || e.Item != "123" || e.State != "paused" || e.Position == nil || *e.Position != 20000000 {
		t.Fatalf("event %+v", e)
	}
	if e := events[1]; e.Session != "11" || e.Item != "124" || e.State != "stopped" || e.Position != nil {
		t.Fatalf("event %+v", e)
	}
	// Other notification types carry no playback states.
	if events, err := s.LivePlayback([]byte(`{"NotificationContainer":{"type":"timeline"}}`)); err != nil || len(events) != 0 {
		t.Fatal(events, err)
	}
	for _, body := range []string{
		`{"NotificationContainer":{"type":"playing","PlaySessionStateNotification":[{"sessionKey":"10","ratingKey":"123","state":"rewinding"}]}}`,
		`{"NotificationContainer":{"type":"playing","PlaySessionStateNotification":[{"sessionKey":"","ratingKey":"123","state":"playing"}]}}`,
		`{"NotificationContainer":{"type":"playing","PlaySessionStateNotification":[{"sessionKey":"10","ratingKey":"abc","state":"playing"}]}}`,
		`{"NotificationContainer":{"type":"playing","PlaySessionStateNotification":[{"sessionKey":"10","ratingKey":"123","state":"playing","viewOffset":-1}]}}`,
		`{"NotificationContainer":{"type":"playing","PlaySessionStateNotification":{"sessionKey":"10"}}}`,
	} {
		if _, err := s.LivePlayback([]byte(body)); err == nil {
			t.Fatal("accepted", body)
		}
	}
}
