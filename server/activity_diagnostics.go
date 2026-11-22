package main

import (
	"app/server/providers/provider"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"strconv"
)

// The per-process key keeps provider session identifiers out of console logs.
func (a *App) activitySessionReference(server int64, session string) string {
	h := hmac.New(sha256.New, a.imageKey)
	h.Write([]byte("activity-diagnostic:" + strconv.FormatInt(server, 10) + ":" + session))
	return hex.EncodeToString(h.Sum(nil)[:8])
}

func (a *App) logSocketPlaybackEvent(server int64, providerName string, event provider.PlaybackEvent) {
	state := event.State
	if !provider.PlaybackStates[state] {
		state = "unknown"
	}
	args := []any{"server_id", server, "provider", providerName, "session_ref", a.activitySessionReference(server, event.Session), "state", state}
	if event.Position != nil {
		args = append(args, "position_ms", *event.Position/10000)
	}
	a.logger.Info("WebSocket playback notification", args...)
}

func (a *App) logActivitySnapshot(c activityReadClaim, snapshot activitySnapshot) {
	trigger := activityObservationSource(c.Source)
	for _, session := range snapshot.Sessions {
		state := "playing"
		if session.Paused {
			state = "paused"
		}
		if session.Display != nil && provider.PlaybackStates[session.Display.State] {
			state = session.Display.State
		}
		args := []any{"server_id", c.Server, "provider", c.Provider, "session_ref", a.activitySessionReference(c.Server, session.Session), "title", session.Title, "transport", "http", "trigger", trigger, "state", state, "observed_at", snapshot.ObservedAt.UTC()}
		if session.Position != nil {
			args = append(args, "position_ms", *session.Position/10000)
		}
		a.logger.Info("Stream session updated", args...)
	}
}
