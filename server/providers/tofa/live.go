package tofa

import (
	"app/server/providers/provider"
	"encoding/json"
	"strings"
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

// LivePlayback reads only identity and timing fields needed for history.
// Start and missed-event frames break the attribution chain.
func (s *Server) LivePlayback(frame []byte) ([]provider.PlaybackEvent, error) {
	fields, err := provider.DecodeObject(frame, provider.MaxLiveFrameBytes)
	if err != nil {
		return nil, err
	}
	var kind string
	if json.Unmarshal(fields["type"], &kind) != nil {
		return nil, provider.ErrActivitySnapshot
	}
	if kind == "EventsMissed" {
		return []provider.PlaybackEvent{{Barrier: true}}, nil
	}
	if kind != "StreamStarted" && kind != "StreamProgress" && kind != "StreamStopped" {
		return nil, nil
	}
	var session string
	if json.Unmarshal(fields["session_id"], &session) != nil || !uuid.MatchString(session) {
		return []provider.PlaybackEvent{{Barrier: true}}, nil
	}
	session = strings.ToLower(session)
	if kind == "StreamStarted" {
		return []provider.PlaybackEvent{{Session: session, Barrier: true}}, nil
	}
	var user string
	if json.Unmarshal(fields["user_id"], &user) != nil || !uuid.MatchString(user) {
		return []provider.PlaybackEvent{{Session: session, Barrier: true}}, nil
	}
	var paused *bool
	if raw, ok := fields["is_paused"]; ok && json.Unmarshal(raw, &paused) != nil {
		return nil, provider.ErrActivitySnapshot
	}
	var milliseconds *int64
	if raw, ok := fields["position_ms"]; ok && json.Unmarshal(raw, &milliseconds) != nil {
		return nil, provider.ErrActivitySnapshot
	}
	position, err := activityTicks(milliseconds)
	if err != nil {
		return nil, err
	}
	state := "stopped"
	if kind == "StreamProgress" {
		if paused == nil {
			return []provider.PlaybackEvent{{Session: session, Barrier: true}}, nil
		}
		state = "playing"
		if *paused {
			state = "paused"
		}
	}
	return []provider.PlaybackEvent{{Session: session, User: strings.ToLower(user), State: state, Position: position}}, nil
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
