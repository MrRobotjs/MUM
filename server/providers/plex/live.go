package plex

import (
	"encoding/json"
	"net/http"
	"time"

	"app/server/providers/provider"
)

// LiveConnection describes the server's notification socket. The token and
// device go in headers, never the address. Plex may send binary frames and
// can be quiet for long periods, so the connection is kept alive with pings
// every 20 seconds instead of a read timeout.
func (s *Server) LiveConnection(device string) (provider.LiveConnection, error) {
	if s.token == "" {
		return provider.LiveConnection{}, provider.ErrLiveSource
	}
	endpoint, err := provider.SocketURL(s.url, "/:/websockets/notifications", nil)
	if err != nil {
		return provider.LiveConnection{}, err
	}
	header := make(http.Header)
	header.Set("X-Plex-Token", s.token)
	header.Set("X-Plex-Client-Identifier", device)
	return provider.LiveConnection{URL: endpoint, Header: header, Binary: true, PingInterval: 20 * time.Second}, nil
}

// LiveEvent reads one notification frame and returns only an allowlisted
// notification type, or "" for others. Nothing else in the frame is kept.
func (s *Server) LiveEvent(frame []byte) (hint string, reply []byte, err error) {
	fields, err := provider.DecodeObject(frame, provider.MaxLiveFrameBytes)
	if err != nil {
		return "", nil, err
	}
	var notification struct {
		Type string `json:"type"`
	}
	if raw, ok := fields["NotificationContainer"]; !ok || json.Unmarshal(raw, &notification) != nil || notification.Type == "" {
		return "", nil, provider.ErrActivitySnapshot
	}
	switch notification.Type {
	case "playing", "timeline", "activity", "transcodeSession.start", "transcodeSession.end":
		return notification.Type, nil, nil
	}
	return "", nil, nil
}
