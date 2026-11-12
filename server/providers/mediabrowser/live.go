package mediabrowser

import (
	"encoding/json"
	"net/url"
	"time"

	"app/server/providers/provider"
)

// Live describes the server's session socket at suffix (Jellyfin "/socket",
// Emby the configured address itself). The API key and device ID go in the
// query, as both servers require. Once connected, MUM subscribes to session
// updates every 5 seconds; a silent socket is dropped after 45 seconds.
func (s *Server) Live(device, suffix string) (provider.LiveConnection, error) {
	if s.apiKey == "" {
		return provider.LiveConnection{}, provider.ErrLiveSource
	}
	endpoint, err := provider.SocketURL(s.root, suffix, url.Values{"api_key": {s.apiKey}, "deviceId": {device}})
	if err != nil {
		return provider.LiveConnection{}, err
	}
	start, _ := json.Marshal(map[string]string{"MessageType": "SessionsStart", "Data": "0,5000"})
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
