package tofa

import (
	"app/server/providers/provider"
	"encoding/json"
	"testing"
)

func TestLiveSocketAuthenticationAndEvents(t *testing.T) {
	s := New(provider.Config{URL: "https://fixture.example", APIKey: "secret"})
	spec, err := s.LiveConnection("fixture")
	if err != nil || spec.URL != "wss://fixture.example/api/v1/ws" {
		t.Fatal(spec.URL, err)
	}
	var auth map[string]string
	if json.Unmarshal(spec.Start, &auth) != nil || auth["type"] != "auth" || auth["token"] != "secret" {
		t.Fatal("invalid auth frame")
	}
	if err = s.LiveAuthAccepted([]byte(`{"type":"auth_ok"}`)); err != nil {
		t.Fatal(err)
	}
	if err = s.LiveAuthAccepted([]byte(`{"error":"unauthorized"}`)); err == nil {
		t.Fatal("accepted failed auth")
	}
	for _, v := range []string{"StreamStarted", "StreamProgress", "StreamUpdated", "StreamStopped", "EventsMissed"} {
		hint, _, err := s.LiveEvent([]byte(`{"type":"` + v + `"}`))
		if err != nil || hint != v {
			t.Fatal(v, hint, err)
		}
	}
}

func TestLivePlaybackReadsTofaStatesAndBoundaries(t *testing.T) {
	s := New(provider.Config{})
	session, user := "01234567-89ab-4cde-8fab-0123456789ab", "11234567-89ab-4cde-8fab-0123456789ab"
	progress := []byte(`{"type":"StreamProgress","session_id":"` + session + `","user_id":"` + user + `","is_paused":true,"position_ms":1200}`)
	events, err := s.LivePlayback(progress)
	if err != nil || len(events) != 1 || events[0].User != user || events[0].State != "paused" || events[0].Position == nil || *events[0].Position != 12000000 {
		t.Fatal(events, err)
	}
	stop := []byte(`{"type":"StreamStopped","session_id":"` + session + `","user_id":"` + user + `","position_ms":1300}`)
	events, err = s.LivePlayback(stop)
	if err != nil || len(events) != 1 || events[0].State != "stopped" || *events[0].Position != 13000000 {
		t.Fatal(events, err)
	}
	for _, frame := range []string{`{"type":"StreamStarted","session_id":"` + session + `"}`, `{"type":"EventsMissed"}`} {
		events, err = s.LivePlayback([]byte(frame))
		if err != nil || len(events) != 1 || !events[0].Barrier {
			t.Fatal(frame, events, err)
		}
	}
	if _, err = s.LivePlayback([]byte(`{"type":"StreamProgress","session_id":"` + session + `","user_id":"` + user + `","is_paused":true,"position_ms":-1}`)); err == nil {
		t.Fatal("accepted negative position")
	}
}
