// Package plex is MUM's Plex client: the XML requests Plex Media Server and
// plex.tv answer, the server identity, library reads and the parsing helpers
// for Plex's attribute values.
//
// The remote parts of sharing, catalogue, activity and location lookup still
// live in the core and call this client until they move here. MUM's sharing
// workflow (sign-in authorization, invitation scope, jobs and checkpoints)
// stays in the core, because it reads and writes the database.
package plex

import (
	"context"
	"encoding/xml"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"app/server/providers/provider"
)

var Definition = provider.Definition{
	ID:             "plex",
	Name:           "Plex",
	Description:    "Plex library discovery and cloud sharing synchronization",
	DownloadLabels: true,
}

// DefaultClientID identifies MUM to Plex when no per-installation client ID
// is configured.
const DefaultClientID = "mum-go"

// Server is one configured Plex Media Server, reached with its owner token.
type Server struct {
	url, token, clientID string
	transport            provider.Transport
	locations            *provider.LocationCache
}

func New(cfg provider.Config) *Server {
	clientID := cfg.ClientID
	if clientID == "" {
		clientID = DefaultClientID
	}
	return &Server{url: strings.TrimRight(cfg.URL, "/"), token: cfg.APIKey, clientID: clientID, transport: cfg.Transport, locations: cfg.Locations}
}

// Authorize adds the Plex token and client identifier to a request.
func (s *Server) Authorize(header http.Header) {
	header.Set("X-Plex-Token", s.token)
	header.Set("X-Plex-Client-Identifier", s.clientID)
}

// XML performs a GET on target (the server, or a fixed plex.tv endpoint) and
// decodes the XML reply into out.
func (s *Server) XML(ctx context.Context, target string, out any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		return errors.New("invalid provider request")
	}
	req.Header.Set("Accept", "application/xml")
	s.Authorize(req.Header)
	body, err := s.transport.Send(req)
	if err != nil {
		return err
	}
	if err := xml.Unmarshal(body, out); err != nil {
		return errors.New("invalid Plex XML response")
	}
	return nil
}

// Identity is the server's machine identifier, name and version.
type Identity struct {
	XMLName xml.Name `xml:"MediaContainer"`
	Machine string   `xml:"machineIdentifier,attr"`
	Name    string   `xml:"friendlyName,attr"`
	Version string   `xml:"version,attr"`
}

func (s *Server) Identity(ctx context.Context) (Identity, error) {
	var identity Identity
	err := s.XML(ctx, s.url+"/", &identity)
	if err == nil && identity.Machine == "" {
		err = errors.New("Plex server identity missing")
	}
	return identity, err
}

// Libraries reads the server's library sections.
func (s *Server) Libraries(ctx context.Context) ([]provider.Library, error) {
	var container struct {
		XMLName   xml.Name `xml:"MediaContainer"`
		Libraries []struct {
			Key   string `xml:"key,attr"`
			Title string `xml:"title,attr"`
			Type  string `xml:"type,attr"`
		} `xml:"Directory"`
	}
	if err := s.XML(ctx, s.url+"/library/sections", &container); err != nil {
		return nil, err
	}
	result := []provider.Library{}
	for _, l := range container.Libraries {
		result = append(result, provider.Library{ID: l.Key, Name: l.Title, Type: l.Type})
	}
	return result, nil
}

// ExplicitBool parses a Plex boolean attribute. known is false for anything
// but "0", "1", "false" or "true": a missing value is not a "no".
func ExplicitBool(value string) (result, known bool) {
	switch value {
	case "0", "false":
		return false, true
	case "1", "true":
		return true, true
	default:
		return false, false
	}
}

// ShareJoinDate converts SharedServer.acceptedAt (the share acceptance time in
// Unix seconds, not the account creation time) to RFC 3339. An absent or
// invalid timestamp is unknown and returns "".
func ShareJoinDate(value string) string {
	if value == "" || len(value) > 12 {
		return ""
	}
	for _, digit := range value {
		if digit < '0' || digit > '9' {
			return ""
		}
	}
	seconds, err := strconv.ParseInt(value, 10, 64)
	if err != nil || seconds <= 0 || seconds > 253402300799 {
		return ""
	}
	return time.Unix(seconds, 0).UTC().Format(time.RFC3339)
}

// Test reads the server identity and its libraries.
func (s *Server) Test(ctx context.Context) (provider.Info, error) {
	identity, err := s.Identity(ctx)
	if err != nil {
		return provider.Info{}, err
	}
	libraries, err := s.Libraries(ctx)
	if err == nil {
		err = provider.CheckLibraries(libraries)
	}
	if err != nil {
		return provider.Info{}, err
	}
	return provider.Info{Name: identity.Name, Version: identity.Version}, nil
}

// friendRelationship reads a friend's Plex Home membership and whether they
// share a server back. In the friend list, each of the friend's Server entries
// says whether the owner owns it: owned="0" is the friend's own server shared
// with the owner. Any flag that is not explicit leaves both unknown (nil).
func friendRelationship(u Friend) *provider.UserRelationship {
	home, known := ExplicitBool(u.Attr("home"))
	if !known {
		return nil
	}
	relationship := &provider.UserRelationship{Home: home}
	for _, server := range u.Servers {
		owned, known := ExplicitBool(server.Owned)
		if !known {
			return nil
		}
		if !owned {
			relationship.SharesBack = true
		}
	}
	return relationship
}

// OwnerAccountID is the server-local account ID Plex Media Server gives its
// owner, also used in playback sessions.
const OwnerAccountID = "1"

// Users reads the server's users: the owner (as local account 1) and every
// plex.tv account the server is shared with, with their library grants.
// Cloud endpoints are fixed here, never configurable or taken from upstream
// redirects, and share or token attributes are never kept.
func (s *Server) Users(ctx context.Context) ([]provider.User, error) {
	identity, err := s.Identity(ctx)
	if err != nil {
		return nil, err
	}
	users, err := s.Friends(ctx)
	if err != nil {
		return nil, err
	}
	grants, err := s.SharedServers(ctx, identity.Machine)
	if err != nil {
		return nil, err
	}
	// The token's account owns the server: plex.tv only lets the owner read
	// shared_servers above. The owner never appears in that list, so it is
	// read here; a failure fails the snapshot rather than dropping the owner.
	owner, err := s.Account(ctx)
	if err != nil {
		return nil, err
	}
	ownerName := owner.Username
	if ownerName == "" {
		ownerName = owner.Title
	}
	if owner.ID == "" || ownerName == "" {
		return nil, errors.New("Plex owner account is incomplete")
	}
	policy := map[string]provider.User{}
	for _, g := range grants.Shares {
		if g.UserID == "" {
			return nil, errors.New("Plex sharing record missing user ID")
		}
		if _, duplicate := policy[g.UserID]; duplicate {
			return nil, errors.New("duplicate Plex sharing record")
		}
		all, known := ExplicitBool(g.All)
		if !known {
			return nil, errors.New("Plex sharing record missing explicit library policy")
		}
		ids := []string{}
		seen := map[string]bool{}
		for _, section := range g.Sections {
			shared, known := ExplicitBool(section.Shared)
			if !known || section.Key == "" || seen[section.Key] {
				return nil, errors.New("Plex sharing record has ambiguous library policy")
			}
			seen[section.Key] = true
			if shared {
				ids = append(ids, section.Key)
			}
		}
		policy[g.UserID] = provider.User{AllLibraries: all, LibraryIDs: ids, Profile: &provider.UserProfile{JoinDate: ShareJoinDate(g.Accepted)}}
	}
	// The owner has every library and can always download; plex.tv supplies
	// no share date for it.
	result := []provider.User{{ID: OwnerAccountID, Name: ownerName, Email: owner.Email, Active: true, AllLibraries: true, LibraryIDs: []string{}, Access: &provider.UserAccess{LibrariesKnown: true, DownloadsKnown: true, AllowDownloads: true}, Profile: &provider.UserProfile{AvatarURL: UserAvatar(owner.Thumb)}}}
	seenUsers := map[string]bool{OwnerAccountID: true}
	for _, u := range users.Users {
		id := u.Attr("id")
		if id == owner.ID {
			continue // the owner is already included as local account 1
		}
		for _, server := range u.Servers {
			if server.Machine != identity.Machine {
				continue
			}
			if id == "" || seenUsers[id] {
				return nil, errors.New("Plex sharing user reference is ambiguous")
			}
			seenUsers[id] = true
			grant, found := policy[id]
			pending, known := ExplicitBool(server.Pending)
			if !known {
				return nil, errors.New("Plex sharing reference missing explicit acceptance state")
			}
			if !found && !pending {
				return nil, errors.New("Plex sharing data is incomplete")
			}
			name := u.Attr("username")
			if name == "" {
				name = u.Attr("title")
			}
			if grant.LibraryIDs == nil {
				grant.LibraryIDs = []string{}
			}
			profile := &provider.UserProfile{AvatarURL: UserAvatar(u.Attr("thumb"))}
			if !pending && grant.Profile != nil {
				profile.JoinDate = grant.Profile.JoinDate
			}
			access := &provider.UserAccess{LibrariesKnown: true}
			access.AllowDownloads, access.DownloadsKnown = ExplicitBool(u.Attr("allowSync"))
			result = append(result, provider.User{ID: id, Name: name, Email: u.Attr("email"), Active: !pending, AllLibraries: grant.AllLibraries, LibraryIDs: grant.LibraryIDs, Access: access, Profile: profile, Relationship: friendRelationship(u)})
		}
	}
	return result, nil
}
