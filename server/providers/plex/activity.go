package plex

import (
	"bytes"
	"context"
	"encoding/xml"
	"errors"
	"io"
	"math"
	"net/http"
	"net/netip"
	"strings"
	"time"

	"app/server/providers/provider"
)

// maxSessionsBytes bounds one /status/sessions reply.
const maxSessionsBytes = 2 << 20

// ActivitySnapshot reads the server's complete current sessions and adds the
// source details of what is playing. Every failure is
// provider.ErrActivitySnapshot or the transport's authority error, never a
// partial list. Players on public addresses get approximate coordinates.
func (s *Server) ActivitySnapshot(ctx context.Context) (provider.ActivitySnapshot, error) {
	body, err := s.sessions(ctx)
	if err != nil {
		return provider.ActivitySnapshot{}, err
	}
	snapshot, err := ParseActivity(body)
	if err != nil {
		return snapshot, err
	}
	s.enrichSourceDisplay(ctx, body, &snapshot)
	s.enrichLocations(ctx, &snapshot)
	if ctx.Err() != nil {
		return snapshot, ctx.Err()
	}
	return snapshot, nil
}

func (s *Server) sessions(ctx context.Context) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, s.url+"/status/sessions", nil)
	if err != nil {
		return nil, provider.ErrActivitySnapshot
	}
	req.Header.Set("Accept", "application/xml")
	req.Header.Set("X-Plex-Token", s.token)
	req.Header.Set("X-Plex-Client-Identifier", DefaultClientID)
	_, body, err := s.transport.Fetch(req, maxSessionsBytes, nil)
	if err != nil {
		return nil, provider.ActivityReadError(err)
	}
	return body, nil
}

// ParseActivity validates a complete /status/sessions reply: one root, no
// directives or duplicate attributes, exactly one user and player per session
// and a size that matches the rows. Anything else rejects the whole snapshot.
func ParseActivity(body []byte) (provider.ActivitySnapshot, error) {
	result := provider.ActivitySnapshot{Provider: "plex", Sessions: []provider.ActivitySession{}}
	bad := provider.ErrActivitySnapshot
	if len(body) > maxSessionsBytes {
		return result, bad
	}
	decoder := xml.NewDecoder(bytes.NewReader(body))
	depth, roots := 0, 0
	for {
		token, err := decoder.Token()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return result, bad
		}
		switch v := token.(type) {
		case xml.StartElement:
			if depth == 0 {
				roots++
			}
			depth++
			if depth > 32 || v.Name.Space != "" {
				return result, bad
			}
			seen := map[xml.Name]bool{}
			for _, a := range v.Attr {
				if seen[a.Name] {
					return result, bad
				}
				seen[a.Name] = true
			}
		case xml.EndElement:
			depth--
		case xml.Directive:
			return result, bad
		case xml.CharData:
			if depth <= 1 && len(bytes.TrimSpace(v)) > 0 {
				return result, bad
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
		return result, bad
	}
	seen := map[string]bool{}
	displays, err := ParseDisplays(body)
	if err != nil || len(displays) != len(page.Rows) {
		return result, bad
	}
	kinds := map[string]string{"movie": "Movie", "episode": "Episode", "track": "Audio", "clip": "Video"}
	for index, row := range page.Rows {
		if (row.XMLName.Local != "Video" && row.XMLName.Local != "Track") || len(row.Users) != 1 || len(row.Players) != 1 || !NumericID(row.Users[0].ID) || !NumericID(row.Item) || seen[row.Session] {
			return result, bad
		}
		seen[row.Session] = true
		player := row.Players[0]
		if player.State != "playing" && player.State != "paused" && player.State != "buffering" {
			return result, bad
		}
		session := provider.ActivitySession{Session: row.Session, User: row.Users[0].ID, UserName: provider.TruncateRunes(row.Users[0].Name, 128), Item: row.Item, Kind: kinds[row.Kind], Title: row.Title, Paused: player.State == "paused", Parent: row.Parent, ParentTitle: row.ParentTitle, Client: provider.TruncateRunes(player.Product, 128), Device: provider.TruncateRunes(player.Title, 256)}
		session.Display = displays[index]
		if session.Display.Stream != "" && session.Display.Stream != "Unknown" {
			session.PlayMethod = provider.PlayMethods[strings.ReplaceAll(session.Display.Stream, " ", "")]
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
				return result, bad
			}
			n := *row.Position * 10000
			session.Position = &n
		}
		if row.Duration != nil {
			if *row.Duration < 0 || *row.Duration > math.MaxInt64/10000 {
				return result, bad
			}
			n := *row.Duration * 10000
			session.Duration = &n
		}
		if !provider.ValidActivitySession(session) {
			return result, bad
		}
		result.Sessions = append(result.Sessions, session)
	}
	result.ObservedAt = time.Now().UTC()
	return result, nil
}

// SessionAddress reads a player address as Plex reports it: a bare address,
// an address with a port, a bracketed IPv6 address or a forwarded list (only
// the first entry counts).
func SessionAddress(value string) netip.Addr {
	value = strings.TrimSpace(strings.SplitN(value, ",", 2)[0])
	if addr, err := netip.ParseAddr(value); err == nil {
		return addr.WithZone("").Unmap()
	}
	if addr, err := netip.ParseAddrPort(value); err == nil {
		return addr.Addr().WithZone("").Unmap()
	}
	if strings.HasPrefix(value, "[") && strings.HasSuffix(value, "]") {
		if addr, err := netip.ParseAddr(value[1 : len(value)-1]); err == nil {
			return addr.WithZone("").Unmap()
		}
	}
	return netip.Addr{}
}

var nonPublicSessionRanges = []netip.Prefix{
	netip.MustParsePrefix("0.0.0.0/8"), netip.MustParsePrefix("100.64.0.0/10"),
	netip.MustParsePrefix("192.0.0.0/24"), netip.MustParsePrefix("192.0.2.0/24"), netip.MustParsePrefix("192.88.99.0/24"),
	netip.MustParsePrefix("198.18.0.0/15"), netip.MustParsePrefix("198.51.100.0/24"), netip.MustParsePrefix("203.0.113.0/24"), netip.MustParsePrefix("240.0.0.0/4"),
	netip.MustParsePrefix("2001::/32"), netip.MustParsePrefix("2001:2::/48"), netip.MustParsePrefix("2001:db8::/32"), netip.MustParsePrefix("2001:10::/28"), netip.MustParsePrefix("2001:20::/28"), netip.MustParsePrefix("3fff::/20"),
}

// PublicSessionAddress returns the player address only when it is a public
// unicast address, or the zero address.
func PublicSessionAddress(value string) netip.Addr {
	addr := SessionAddress(value)
	if !addr.IsValid() || !addr.IsGlobalUnicast() || addr.IsPrivate() || addr.IsLoopback() || addr.IsLinkLocalUnicast() {
		return netip.Addr{}
	}
	if addr.Is6() && !netip.MustParsePrefix("2000::/3").Contains(addr) {
		return netip.Addr{}
	}
	for _, reserved := range nonPublicSessionRanges {
		if reserved.Contains(addr) {
			return netip.Addr{}
		}
	}
	return addr
}
