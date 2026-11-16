package plex

import (
	"context"
	"encoding/xml"
	"errors"
	"net/http"
	"net/url"
	"time"

	"app/server/providers/provider"
)

// TerminateSession stops the stream whose sessionKey is session, showing
// message on the player. Plex stops a stream by its Session id, which MUM does
// not store, so the current sessions are read first; that also confirms the
// stream is still playing (provider.ErrSessionGone otherwise). Plex only
// allows this with Plex Pass and refuses it otherwise
// (provider.ErrTerminateRefused).
func (s *Server) TerminateSession(ctx context.Context, session, message string) error {
	body, err := s.sessions(ctx)
	if err != nil {
		return err
	}
	id, err := SessionID(body, session)
	if err != nil {
		return err
	}
	query := url.Values{"sessionId": {id}}
	if message != "" {
		query.Set("reason", message)
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, s.url+"/status/sessions/terminate?"+query.Encode(), nil)
	if err != nil {
		return err
	}
	req.Header.Set("X-Plex-Token", s.token)
	req.Header.Set("X-Plex-Client-Identifier", DefaultClientID)
	_, err = s.transport.Send(req)
	if status, ok := errors.AsType[*provider.HTTPError](err); ok {
		switch status.StatusCode {
		case http.StatusNotFound:
			return provider.ErrSessionGone
		case http.StatusUnauthorized, http.StatusForbidden:
			return provider.ErrTerminateRefused
		}
	}
	return err
}

// SessionID finds the Session id of the stream whose sessionKey is session in
// a /status/sessions reply. A reply that does not list it exactly once, or
// lists it without a usable id, is provider.ErrSessionGone.
func SessionID(body []byte, session string) (string, error) {
	var page struct {
		XMLName xml.Name `xml:"MediaContainer"`
		Rows    []struct {
			Key      string `xml:"sessionKey,attr"`
			Sessions []struct {
				ID string `xml:"id,attr"`
			} `xml:"Session"`
		} `xml:",any"`
	}
	if session == "" || len(body) > maxSessionsBytes || xml.Unmarshal(body, &page) != nil {
		return "", provider.ErrSessionGone
	}
	id, found := "", 0
	for _, row := range page.Rows {
		if row.Key != session {
			continue
		}
		found++
		if len(row.Sessions) == 1 {
			id = row.Sessions[0].ID
		}
	}
	if found != 1 || id == "" || !provider.ValidText(id, 256) {
		return "", provider.ErrSessionGone
	}
	return id, nil
}
