package mediabrowser

import (
	"encoding/json"
	"net/http"
	"net/url"
	"time"

	"app/server/providers/provider"
)

// Live describes the server's session socket at suffix (Jellyfin "/socket",
// Emby the configured address itself). Jellyfin takes the API key in the
// Authorization header; Emby takes it in the query. The device ID goes in the
// query for both. Once connected, MUM subscribes to session
// updates every 5 seconds. Jellyfin can be silent when no sessions change,
// so a WebSocket ping tests liveness without requiring application frames.
func (s *Server) Live(device, suffix string) (provider.LiveConnection, error) {
	if s.apiKey == "" {
		return provider.LiveConnection{}, provider.ErrLiveSource
	}
	query := url.Values{"deviceId": {device}}
	if s.emby {
		query.Set("api_key", s.apiKey)
	} else if s.keyAuthorization() == "" {
		return provider.LiveConnection{}, provider.ErrLiveSource
	}
	endpoint, err := provider.SocketURL(s.root, suffix, query)
	if err != nil {
		return provider.LiveConnection{}, err
	}
	start, _ := json.Marshal(map[string]string{"MessageType": "SessionsStart", "Data": "0,5000"})
	if !s.emby {
		header := http.Header{}
		s.authorize(header)
		return provider.LiveConnection{URL: endpoint, Header: header, Start: start, PingInterval: 30 * time.Second}, nil
	}
	return provider.LiveConnection{URL: endpoint, Start: start, ReadTimeout: 45 * time.Second}, nil
}

var keepAlive, _ = json.Marshal(map[string]string{"MessageType": "KeepAlive"})

// LiveEvent reads one socket frame. It validates the envelope, discards Data
// entirely and returns only an allowlisted message type, or "" for other
// messages. A ForceKeepAlive request returns the KeepAlive reply instead of a
// hint.
func (s *Server) LiveEvent(frame []byte) (hint string, reply []byte, err error) {
	fields, err := provider.DecodeObject(frame, provider.MaxLiveFrameBytes)
	if err != nil {
		return "", nil, err
	}
	var message string
	if raw, ok := fields["MessageType"]; !ok || json.Unmarshal(raw, &message) != nil || message == "" {
		return "", nil, provider.ErrActivitySnapshot
	}
	switch message {
	case "ForceKeepAlive":
		return "", keepAlive, nil
	case "Sessions", "SessionStart", "SessionEnded", "PlaybackStart", "PlaybackStopped", "PlaybackProgress":
		return message, nil, nil
	}
	return "", nil, nil
}
