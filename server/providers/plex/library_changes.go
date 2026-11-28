package plex

import (
	"context"
	"encoding/json"
	"encoding/xml"
	"errors"
	"strconv"
	"strings"

	"app/server/providers/provider"
)

// Plex timeline item types and states. A finished item is state 5; a removed
// one is state 9 or has metadataState "deleted".
var timelineKinds = map[int]string{1: "movie", 2: "show", 3: "season", 4: "episode", 8: "artist", 9: "album", 10: "track"}

const (
	timelineFinished = 5
	timelineDeleted  = 9
	maxTimelineItems = 200
)

// timelineID reads a section or item ID, which Plex sends as a string or a
// number, and accepts only a positive decimal ID.
func timelineID(raw json.RawMessage) string {
	var text string
	if json.Unmarshal(raw, &text) != nil {
		var number json.Number
		if json.Unmarshal(raw, &number) != nil {
			return ""
		}
		text = number.String()
	}
	if !NumericID(text) {
		return ""
	}
	return text
}

// LiveLibraryChanges reads the library items a "timeline" notification
// reports as finished or removed. Other notifications return nothing.
func (s *Server) LiveLibraryChanges(frame []byte) ([]provider.LibraryChange, error) {
	fields, err := provider.DecodeObject(frame, provider.MaxLiveFrameBytes)
	if err != nil {
		return nil, err
	}
	var notification struct {
		Type    string `json:"type"`
		Entries []struct {
			Identifier    string          `json:"identifier"`
			Section       json.RawMessage `json:"sectionID"`
			Item          json.RawMessage `json:"itemID"`
			Kind          int             `json:"type"`
			State         int             `json:"state"`
			MetadataState string          `json:"metadataState"`
		} `json:"TimelineEntry"`
	}
	raw, ok := fields["NotificationContainer"]
	if !ok || strings.TrimSpace(string(raw)) == "null" || json.Unmarshal(raw, &notification) != nil {
		return nil, provider.ErrActivitySnapshot
	}
	if notification.Type != "timeline" {
		return nil, nil
	}
	changes := []provider.LibraryChange{}
	for _, e := range notification.Entries {
		if len(changes) == maxTimelineItems {
			break
		}
		kind, known := timelineKinds[e.Kind]
		removed := e.State == timelineDeleted || e.MetadataState == "deleted"
		section, item := timelineID(e.Section), timelineID(e.Item)
		if e.Identifier != "com.plexapp.plugins.library" || !known || section == "" || item == "" || !removed && e.State != timelineFinished {
			continue
		}
		changes = append(changes, provider.LibraryChange{Library: section, Item: item, Kind: kind, Removed: removed})
	}
	return changes, nil
}

// CatalogueParent returns the show of an episode or season, or the album of
// a track, so only that show's episodes or album's tracks are read again.
func (s *Server) CatalogueParent(ctx context.Context, item string) (string, error) {
	if !NumericID(item) {
		return "", errors.New("invalid Plex item identifier")
	}
	_, body, err := s.catalogueGet(ctx, "/library/metadata/"+item, "application/xml", -1, 1<<20, nil)
	if err != nil {
		return "", err
	}
	var page struct {
		Items []struct {
			ID     string `xml:"ratingKey,attr"`
			Kind   string `xml:"type,attr"`
			Show   string `xml:"grandparentRatingKey,attr"`
			Parent string `xml:"parentRatingKey,attr"`
		} `xml:",any"`
	}
	if err := xml.Unmarshal(body, &page); err != nil || len(page.Items) != 1 || page.Items[0].ID != item {
		return "", errors.New("unreadable Plex item")
	}
	entry := page.Items[0]
	parent := ""
	switch strings.ToLower(entry.Kind) {
	case "episode":
		parent = entry.Show
	case "season", "track":
		parent = entry.Parent
	}
	if !NumericID(parent) {
		return "", errors.New("Plex item has no show or album: " + strconv.Quote(entry.Kind))
	}
	return parent, nil
}
