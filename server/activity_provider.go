package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

var errActivitySnapshot = errors.New("provider activity snapshot is unsupported, incomplete or invalid")

type activitySession struct {
	Session, User, Item, Kind, Title string
	UserName                         string
	Display                          *activityDisplay
	// Parent is the series of an episode or the album of a track, used to
	// attribute plays to library catalogue items. Optional.
	Parent, ParentTitle string
	Paused              bool
	Position, Duration  *int64
	// Client application, device name and delivery mode as last reported.
	// Empty means unknown. Device names stay private: only classified
	// buckets leave the store (see classifyActivityDevice).
	Client, Device, PlayMethod string
}
type activitySnapshot struct {
	Provider   string
	ObservedAt time.Time
	Sessions   []activitySession
}

func activityText(value string, maximum int) bool {
	if value == "" || value != strings.TrimSpace(value) || len(value) > maximum || !utf8.ValidString(value) {
		return false
	}
	for _, c := range value {
		if unicode.IsControl(c) {
			return false
		}
	}
	return true
}
func validActivitySession(s activitySession) bool {
	if s.UserName != "" && !activityText(s.UserName, 128) {
		return false
	}
	if !activityText(s.Session, 256) || !activityText(s.User, 256) || !activityText(s.Item, 256) || !activityText(s.Title, 1024) {
		return false
	}
	if s.Parent != "" && !activityText(s.Parent, 256) || s.ParentTitle != "" && (s.Parent == "" || !activityText(s.ParentTitle, 1024)) {
		return false
	}
	switch s.Kind {
	case "Movie", "Episode", "Audio", "Video", "MusicVideo", "Trailer":
	default:
		return false
	}
	if s.Position != nil && *s.Position < 0 || s.Duration != nil && *s.Duration < 0 || s.Position != nil && s.Duration != nil && *s.Position > *s.Duration {
		return false
	}
	return true
}

// Validate duplicate object keys at every nesting level before decoding selected
// fields. Unknown provider fields are ignored, never persisted or returned.
func activityJSONValue(d *json.Decoder, depth int) error {
	if depth > 32 {
		return errActivitySnapshot
	}
	token, err := d.Token()
	if err != nil {
		return errActivitySnapshot
	}
	delimiter, container := token.(json.Delim)
	if !container {
		return nil
	}
	switch delimiter {
	case '{':
		seen := map[string]bool{}
		for d.More() {
			key, err := d.Token()
			if err != nil {
				return errActivitySnapshot
			}
			name, ok := key.(string)
			if !ok || seen[name] {
				return errActivitySnapshot
			}
			seen[name] = true
			if err := activityJSONValue(d, depth+1); err != nil {
				return err
			}
		}
	case '[':
		for d.More() {
			if err := activityJSONValue(d, depth+1); err != nil {
				return err
			}
		}
	default:
		return errActivitySnapshot
	}
	close, err := d.Token()
	if err != nil || delimiter == '{' && close != json.Delim('}') || delimiter == '[' && close != json.Delim(']') {
		return errActivitySnapshot
	}
	return nil
}
func exactActivityKeys(object map[string]json.RawMessage, keys ...string) bool {
	for field := range object {
		for _, key := range keys {
			if field != key && strings.EqualFold(field, key) {
				return false
			}
		}
	}
	return true
}
func parseActivitySnapshot(provider string, body []byte) (activitySnapshot, error) {
	if provider == "plex" {
		return parsePlexActivity(body)
	}
	result := activitySnapshot{Provider: provider, Sessions: []activitySession{}}
	if provider != "jellyfin" && provider != "emby" {
		return result, errActivitySnapshot
	}
	trimmed := bytes.TrimSpace(body)
	if len(trimmed) == 0 || trimmed[0] != '[' || len(body) > 2<<20 {
		return result, errActivitySnapshot
	}
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.UseNumber()
	if err := activityJSONValue(decoder, 0); err != nil {
		return result, err
	}
	if _, err := decoder.Token(); err != io.EOF {
		return result, errActivitySnapshot
	}
	var rows []map[string]json.RawMessage
	if err := json.Unmarshal(body, &rows); err != nil || rows == nil || len(rows) > 1000 {
		return result, errActivitySnapshot
	}
	seen := map[string]bool{}
	validated := []activitySession{}
	for _, row := range rows {
		if !exactActivityKeys(row, "Id", "UserId", "NowPlayingItem", "PlayState", "AdditionalUsers", "Client", "DeviceName") {
			return result, errActivitySnapshot
		}
		var id string
		if err := json.Unmarshal(row["Id"], &id); err != nil || !activityText(id, 256) || seen[id] {
			return result, errActivitySnapshot
		}
		seen[id] = true
		item, playing := row["NowPlayingItem"]
		if !playing || bytes.Equal(bytes.TrimSpace(item), []byte("null")) {
			continue
		}
		var media map[string]json.RawMessage
		if err := json.Unmarshal(item, &media); err != nil || media == nil {
			return result, errActivitySnapshot
		}
		if !exactActivityKeys(media, "Id", "Name", "Type", "RunTimeTicks") {
			return result, errActivitySnapshot
		}
		var session activitySession
		session.Session = id
		if json.Unmarshal(row["UserId"], &session.User) != nil || json.Unmarshal(media["Id"], &session.Item) != nil || json.Unmarshal(media["Name"], &session.Title) != nil || json.Unmarshal(media["Type"], &session.Kind) != nil {
			return result, errActivitySnapshot
		}
		parentID, parentName := "", ""
		switch session.Kind {
		case "Episode":
			parentID, parentName = "SeriesId", "SeriesName"
		case "Audio":
			parentID, parentName = "AlbumId", "Album"
		}
		if parentID != "" {
			if !exactActivityKeys(media, "Id", "Name", "Type", "RunTimeTicks", parentID, parentName) {
				return result, errActivitySnapshot
			}
			for key, target := range map[string]*string{parentID: &session.Parent, parentName: &session.ParentTitle} {
				if raw, ok := media[key]; ok && !bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
					if json.Unmarshal(raw, target) != nil {
						return result, errActivitySnapshot
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
				return result, errActivitySnapshot
			}
		}
		var state map[string]json.RawMessage
		if json.Unmarshal(row["PlayState"], &state) != nil || state == nil {
			return result, errActivitySnapshot
		}
		if !exactActivityKeys(state, "IsPaused", "PositionTicks", "PlayMethod") {
			return result, errActivitySnapshot
		}
		var paused *bool
		if json.Unmarshal(state["IsPaused"], &paused) != nil || paused == nil {
			return result, errActivitySnapshot
		}
		session.Paused = *paused
		if ticks, ok := state["PositionTicks"]; ok {
			if json.Unmarshal(ticks, &session.Position) != nil {
				return result, errActivitySnapshot
			}
		}
		var label error
		if session.Client, label = optionalActivityLabel(row["Client"], 128); label != nil {
			return result, errActivitySnapshot
		}
		if session.Device, label = optionalActivityLabel(row["DeviceName"], 256); label != nil {
			return result, errActivitySnapshot
		}
		method, err := optionalActivityLabel(state["PlayMethod"], 64)
		if err != nil {
			return result, errActivitySnapshot
		}
		session.PlayMethod = activityPlayMethods[method]
		if ticks, ok := media["RunTimeTicks"]; ok {
			if json.Unmarshal(ticks, &session.Duration) != nil {
				return result, errActivitySnapshot
			}
		}
		if !validActivitySession(session) {
			return result, errActivitySnapshot
		}
		validated = append(validated, session)
	}
	result.Sessions = validated
	result.ObservedAt = time.Now().UTC()
	return result, nil
}
func (p *jsonProvider) readActivitySnapshot(ctx context.Context) (activitySnapshot, error) {
	if p.config.Type == "plex" {
		_, body, err := p.plexCatalogueGet(ctx, "/status/sessions", "application/xml", -1, 2<<20)
		if err != nil {
			return activitySnapshot{}, errActivitySnapshot
		}
		snapshot, err := parsePlexActivity(body)
		if err != nil {
			return snapshot, err
		}
		p.enrichPlexSourceDisplay(ctx, body, &snapshot)
		p.enrichPlexGeo(ctx, &snapshot)
		if ctx.Err() != nil {
			return snapshot, ctx.Err()
		}
		return snapshot, nil
	}
	if p.config.Type != "jellyfin" && p.config.Type != "emby" {
		return activitySnapshot{}, errActivitySnapshot
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	base := strings.TrimRight(p.config.URL, "/")
	if p.config.Type == "emby" && !strings.HasSuffix(base, "/emby") {
		base += "/emby"
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, base+"/Sessions", nil)
	if err != nil {
		return activitySnapshot{}, errActivitySnapshot
	}
	request.Header.Set("Accept", "application/json")
	if p.config.Type == "jellyfin" {
		request.Header.Set("Accept", `application/json; profile="PascalCase"`)
	}
	request.Header.Set("X-Emby-Token", p.config.APIKey)
	response, err := p.client.Do(request)
	if err != nil {
		return activitySnapshot{}, errActivitySnapshot
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return activitySnapshot{}, errActivitySnapshot
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, (2<<20)+1))
	if err != nil || len(body) > 2<<20 {
		return activitySnapshot{}, errActivitySnapshot
	}
	return parseActivitySnapshot(p.config.Type, body)
}
