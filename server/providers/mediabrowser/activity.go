package mediabrowser

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"time"

	"app/server/providers/provider"
)

// maxSessionsBytes bounds one /Sessions reply.
const maxSessionsBytes = 2 << 20

// Sessions reads the server's complete current sessions. accept is the
// Accept header: Jellyfin needs its PascalCase profile to keep Emby's field
// names. Every failure is provider.ErrActivitySnapshot or the transport's
// authority error, never a partial list.
func (s *Server) Sessions(ctx context.Context, kind, accept string) (provider.ActivitySnapshot, error) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, s.base+"/Sessions", nil)
	if err != nil {
		return provider.ActivitySnapshot{}, provider.ErrActivitySnapshot
	}
	req.Header.Set("Accept", accept)
	s.authorize(req.Header)
	_, body, err := s.transport.Fetch(req, maxSessionsBytes, nil)
	if err != nil {
		return provider.ActivitySnapshot{}, provider.ActivityReadError(err)
	}
	return ParseSessions(kind, body)
}

// ParseSessions validates a complete /Sessions reply. Duplicate keys at any
// depth, case-variant field names, unexpected co-viewers, wrong types or
// invalid sessions reject the whole snapshot. Unknown fields are ignored,
// never stored or returned.
func ParseSessions(kind string, body []byte) (provider.ActivitySnapshot, error) {
	result := provider.ActivitySnapshot{Provider: kind, Sessions: []provider.ActivitySession{}}
	bad := provider.ErrActivitySnapshot
	if kind != "jellyfin" && kind != "emby" {
		return result, bad
	}
	trimmed := bytes.TrimSpace(body)
	if len(trimmed) == 0 || trimmed[0] != '[' || len(body) > maxSessionsBytes {
		return result, bad
	}
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.UseNumber()
	if err := provider.UniqueJSONKeys(decoder); err != nil {
		return result, err
	}
	if _, err := decoder.Token(); err != io.EOF {
		return result, bad
	}
	var rows []map[string]json.RawMessage
	if err := json.Unmarshal(body, &rows); err != nil || rows == nil || len(rows) > 1000 {
		return result, bad
	}
	seen := map[string]bool{}
	validated := []provider.ActivitySession{}
	for _, row := range rows {
		if !exactKeys(row, "Id", "UserId", "NowPlayingItem", "PlayState", "AdditionalUsers", "Client", "DeviceName") {
			return result, bad
		}
		var id string
		if err := json.Unmarshal(row["Id"], &id); err != nil || !provider.ValidText(id, 256) || seen[id] {
			return result, bad
		}
		seen[id] = true
		item, playing := row["NowPlayingItem"]
		if !playing || bytes.Equal(bytes.TrimSpace(item), []byte("null")) {
			continue
		}
		var media map[string]json.RawMessage
		if err := json.Unmarshal(item, &media); err != nil || media == nil {
			return result, bad
		}
		if !exactKeys(media, "Id", "Name", "Type", "RunTimeTicks") {
			return result, bad
		}
		var session provider.ActivitySession
		session.Session = id
		if json.Unmarshal(row["UserId"], &session.User) != nil || json.Unmarshal(media["Id"], &session.Item) != nil || json.Unmarshal(media["Name"], &session.Title) != nil || json.Unmarshal(media["Type"], &session.Kind) != nil {
			return result, bad
		}
		parentID, parentName := "", ""
		switch session.Kind {
		case "Episode":
			parentID, parentName = "SeriesId", "SeriesName"
		case "Audio":
			parentID, parentName = "AlbumId", "Album"
		}
		if parentID != "" {
			if !exactKeys(media, "Id", "Name", "Type", "RunTimeTicks", parentID, parentName) {
				return result, bad
			}
			for key, target := range map[string]*string{parentID: &session.Parent, parentName: &session.ParentTitle} {
				if raw, ok := media[key]; ok && !bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
					if json.Unmarshal(raw, target) != nil {
						return result, bad
					}
				}
			}
			if session.Parent == "" {
				session.ParentTitle = ""
			}
		}
		if extra, ok := row["AdditionalUsers"]; ok && !bytes.Equal(bytes.TrimSpace(extra), []byte("null")) {
			var users []json.RawMessage
			if json.Unmarshal(extra, &users) != nil || len(users) != 0 {
				return result, bad
			}
		}
		var state map[string]json.RawMessage
		if json.Unmarshal(row["PlayState"], &state) != nil || state == nil {
			return result, bad
		}
		if !exactKeys(state, "IsPaused", "PositionTicks", "PlayMethod") {
			return result, bad
		}
		var paused *bool
		if json.Unmarshal(state["IsPaused"], &paused) != nil || paused == nil {
			return result, bad
		}
		session.Paused = *paused
		if ticks, ok := state["PositionTicks"]; ok {
			if json.Unmarshal(ticks, &session.Position) != nil {
				return result, bad
			}
		}
		var label error
		if session.Client, label = provider.OptionalLabel(row["Client"], 128); label != nil {
			return result, bad
		}
		if session.Device, label = provider.OptionalLabel(row["DeviceName"], 256); label != nil {
			return result, bad
		}
		method, err := provider.OptionalLabel(state["PlayMethod"], 64)
		if err != nil {
			return result, bad
		}
		session.PlayMethod = provider.PlayMethods[method]
		if ticks, ok := media["RunTimeTicks"]; ok {
			if json.Unmarshal(ticks, &session.Duration) != nil {
				return result, bad
			}
		}
		if !provider.ValidActivitySession(session) {
			return result, bad
		}
		validated = append(validated, session)
	}
	result.Sessions = validated
	result.ObservedAt = time.Now().UTC()
	return result, nil
}

// exactKeys rejects a field whose name differs from an expected key only by
// case, which Go's decoder would otherwise accept as that key.
func exactKeys(object map[string]json.RawMessage, keys ...string) bool {
	for field := range object {
		for _, key := range keys {
			if field != key && strings.EqualFold(field, key) {
				return false
			}
		}
	}
	return true
}
