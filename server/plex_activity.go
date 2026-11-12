package main

import (
	"bytes"
	"encoding/xml"
	"errors"
	"io"
	"math"
	"strings"
	"time"
)

func parsePlexActivity(body []byte) (activitySnapshot, error) {
	result := activitySnapshot{Provider: "plex", Sessions: []activitySession{}}
	if len(body) > 2<<20 {
		return result, errActivitySnapshot
	}
	decoder := xml.NewDecoder(bytes.NewReader(body))
	depth, roots := 0, 0
	for {
		token, err := decoder.Token()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return result, errActivitySnapshot
		}
		switch v := token.(type) {
		case xml.StartElement:
			if depth == 0 {
				roots++
			}
			depth++
			if depth > 32 || v.Name.Space != "" {
				return result, errActivitySnapshot
			}
			seen := map[xml.Name]bool{}
			for _, a := range v.Attr {
				if seen[a.Name] {
					return result, errActivitySnapshot
				}
				seen[a.Name] = true
			}
		case xml.EndElement:
			depth--
		case xml.Directive:
			return result, errActivitySnapshot
		case xml.CharData:
			if depth <= 1 && len(bytes.TrimSpace(v)) > 0 {
				return result, errActivitySnapshot
			}
		}
	}
	var page struct {
		XMLName xml.Name `xml:"MediaContainer"`
		Size    *int     `xml:"size,attr"`
		Total   *int     `xml:"totalSize,attr"`
		Rows    []struct {
			XMLName     xml.Name
			Session     string `xml:"sessionKey,attr"`
			Item        string `xml:"ratingKey,attr"`
			Kind        string `xml:"type,attr"`
			Title       string `xml:"title,attr"`
			Parent      string `xml:"grandparentRatingKey,attr"`
			ParentTitle string `xml:"grandparentTitle,attr"`
			Album       string `xml:"parentRatingKey,attr"`
			AlbumTitle  string `xml:"parentTitle,attr"`
			Position    *int64 `xml:"viewOffset,attr"`
			Duration    *int64 `xml:"duration,attr"`
			Users       []struct {
				ID   string `xml:"id,attr"`
				Name string `xml:"title,attr"`
			} `xml:"User"`
			Players []struct {
				State   string `xml:"state,attr"`
				Product string `xml:"product,attr"`
				Title   string `xml:"title,attr"`
			} `xml:"Player"`
		} `xml:",any"`
	}
	if roots != 1 || xml.Unmarshal(body, &page) != nil || page.Size == nil || *page.Size != len(page.Rows) || len(page.Rows) > 1000 || page.Total != nil && *page.Total != *page.Size {
		return result, errActivitySnapshot
	}
	seen := map[string]bool{}
	displays, err := parsePlexDisplays(body)
	if err != nil || len(displays) != len(page.Rows) {
		return result, errActivitySnapshot
	}
	kinds := map[string]string{"movie": "Movie", "episode": "Episode", "track": "Audio", "clip": "Video"}
	for index, row := range page.Rows {
		if (row.XMLName.Local != "Video" && row.XMLName.Local != "Track") || len(row.Users) != 1 || len(row.Players) != 1 || !validPlexCatalogueID(row.Users[0].ID) || !validPlexCatalogueID(row.Item) || seen[row.Session] {
			return result, errActivitySnapshot
		}
		seen[row.Session] = true
		player := row.Players[0]
		if player.State != "playing" && player.State != "paused" && player.State != "buffering" {
			return result, errActivitySnapshot
		}
		session := activitySession{Session: row.Session, User: row.Users[0].ID, UserName: truncateRunes(row.Users[0].Name, 128), Item: row.Item, Kind: kinds[row.Kind], Title: row.Title, Paused: player.State == "paused", Parent: row.Parent, ParentTitle: row.ParentTitle, Client: truncateRunes(player.Product, 128), Device: truncateRunes(player.Title, 256)}
		session.Display = displays[index]
		if session.Display.Stream != "" && session.Display.Stream != "Unknown" {
			session.PlayMethod = activityPlayMethods[strings.ReplaceAll(session.Display.Stream, " ", "")]
		}
		if row.Kind == "track" {
			session.Parent = row.Album
			session.ParentTitle = row.AlbumTitle
		}
		if row.Kind != "episode" && row.Kind != "track" {
			session.Parent = ""
			session.ParentTitle = ""
		}
		if row.Position != nil {
			if *row.Position < 0 || *row.Position > math.MaxInt64/10000 {
				return result, errActivitySnapshot
			}
			n := *row.Position * 10000
			session.Position = &n
		}
		if row.Duration != nil {
			if *row.Duration < 0 || *row.Duration > math.MaxInt64/10000 {
				return result, errActivitySnapshot
			}
			n := *row.Duration * 10000
			session.Duration = &n
		}
		if !validActivitySession(session) {
			return result, errActivitySnapshot
		}
		result.Sessions = append(result.Sessions, session)
	}
	result.ObservedAt = time.Now().UTC()
	return result, nil
}
