package tofa

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"app/server/providers/provider"
)

func TestTerminateSession(t *testing.T) {
	session := "01234567-89ab-4cde-8fab-0123456789ab"
	status, calls := http.StatusNoContent, 0
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if r.Method != http.MethodDelete || r.URL.Path != "/api/v1/system/playback/sessions/"+session || r.Header.Get("Authorization") != "Bearer fixture" {
			t.Error("incorrect stop request")
		}
		w.WriteHeader(status)
	}))
	defer upstream.Close()
	s := New(provider.Config{URL: upstream.URL, APIKey: "fixture", Transport: provider.Transport{Client: upstream.Client()}})
	if err := s.TerminateSession(context.Background(), session, ""); err != nil || calls != 1 {
		t.Fatal(err, calls)
	}
	status = http.StatusNotFound
	if err := s.TerminateSession(context.Background(), session, ""); !errors.Is(err, provider.ErrSessionGone) {
		t.Fatal(err)
	}
	status = http.StatusForbidden
	if err := s.TerminateSession(context.Background(), session, ""); !errors.Is(err, provider.ErrTerminateRefused) {
		t.Fatal(err)
	}
	before := calls
	if err := s.TerminateSession(context.Background(), "../other", ""); err == nil || calls != before {
		t.Fatal("accepted invalid session")
	}
	if err := s.TerminateSession(context.Background(), session, "hello"); err == nil || calls != before {
		t.Fatal("accepted unsupported message")
	}
}
