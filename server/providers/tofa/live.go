package tofa

import (
	"app/server/providers/provider"
	"encoding/json"
	"time"
)

func (s *Server) LiveConnection(device string) (provider.LiveConnection, error) {
	if s.key == "" {
		return provider.LiveConnection{}, provider.ErrLiveSource
	}
	u, err := provider.SocketURL(s.url, "/api/v1/ws", nil)
	if err != nil {
		return provider.LiveConnection{}, err
	}
	start, err := json.Marshal(map[string]string{"type": "auth", "token": s.key})
	if err != nil {
		return provider.LiveConnection{}, provider.ErrLiveSource
	}
	return provider.LiveConnection{URL: u, Start: start, PingInterval: 20 * time.Second}, nil
}
func (s *Server) LiveAuthAccepted(frame []byte) error {
	fields, err := provider.DecodeObject(frame, provider.MaxLiveFrameBytes)
	if err != nil {
		return err
	}
	var typ string
	if json.Unmarshal(fields["type"], &typ) != nil || typ != "auth_ok" {
		return provider.ErrLiveSource
	}
	return nil
}
func (s *Server) LiveEvent(frame []byte) (string, []byte, error) {
	fields, err := provider.DecodeObject(frame, provider.MaxLiveFrameBytes)
	if err != nil {
		return "", nil, err
	}
	var typ string
	if json.Unmarshal(fields["type"], &typ) != nil || typ == "" {
		return "", nil, provider.ErrActivitySnapshot
	}
	switch typ {
	case "StreamStarted", "StreamUpdated", "StreamProgress", "StreamStopped", "EventsMissed":
		return typ, nil, nil
	}
	return "", nil, nil
}
