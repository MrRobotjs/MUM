package plex

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"app/server/providers/provider"
)

const terminateSessions = `<MediaContainer size="2"><Video sessionKey="7" ratingKey="1" type="movie" title="A"><User id="2" title="Reader"/><Player state="playing"/><Session id="abc123" bandwidth="1"/></Video><Track sessionKey="8" ratingKey="2" type="track" title="B"><User id="3" title="Other"/><Player state="paused"/><Session id="def456"/></Track></MediaContainer>`

func TestSessionIDFindsTheStream(t *testing.T) {
	if id, err := SessionID([]byte(terminateSessions), "8"); err != nil || id != "def456" {
		t.Fatal(id, err)
	}
	for _, c := range []struct{ body, key string }{
		{terminateSessions, "9"}, // not listed
		{terminateSessions, ""},
		{`<MediaContainer size="1"><Video sessionKey="7"/></MediaContainer>`, "7"},                                                                        // no Session id
		{`<MediaContainer size="2"><Video sessionKey="7"><Session id="a"/></Video><Video sessionKey="7"><Session id="b"/></Video></MediaContainer>`, "7"}, // ambiguous
		{`not xml`, "7"},
	} {
		if _, err := SessionID([]byte(c.body), c.key); !errors.Is(err, provider.ErrSessionGone) {
			t.Fatalf("%q %q: %v", c.body, c.key, err)
		}
	}
}

// TerminateSession reads the current sessions, then stops the stream by its
// Session id with the message as the reason, authenticated with the token.
func TestTerminateSessionStopsByID(t *testing.T) {
	var got string
	status := http.StatusOK
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-Plex-Token") != "fixture-secret" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		switch r.URL.Path {
		case "/status/sessions":
			w.Header().Set("Content-Type", "application/xml")
			_, _ = w.Write([]byte(terminateSessions))
		case "/status/sessions/terminate":
			got = r.URL.Query().Get("sessionId") + "|" + r.URL.Query().Get("reason")
			w.WriteHeader(status)
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer server.Close()
	s := New(provider.Config{URL: server.URL, APIKey: "fixture-secret", Transport: provider.Transport{Client: server.Client()}})
	if err := s.TerminateSession(t.Context(), "7", "Maintenance & restart"); err != nil || got != "abc123|Maintenance & restart" {
		t.Fatal(got, err)
	}
	got = ""
	if err := s.TerminateSession(t.Context(), "9", ""); !errors.Is(err, provider.ErrSessionGone) || got != "" {
		t.Fatal("ended stream", got, err)
	}
	status = http.StatusUnauthorized
	if err := s.TerminateSession(t.Context(), "7", ""); !errors.Is(err, provider.ErrTerminateRefused) {
		t.Fatal("no Plex Pass", err)
	}
}
