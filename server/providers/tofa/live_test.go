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
