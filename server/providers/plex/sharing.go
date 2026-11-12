package plex

import (
	"bytes"
	"context"
	"encoding/json"
	"encoding/xml"
	"errors"
	"net/http"
	"net/url"
	"slices"
)

// plex.tv sharing API: the server owner's friends, the server's shares,
// pending invitations and the share writes. Endpoints are fixed here, never
// configurable or taken from upstream redirects. MUM's core decides what to
// share and records every step before a write; this file only reads and
// sends.

const cloudAPI = "https://plex.tv/api"

// Friend is one entry of the owner's friend list. Every attribute is kept,
// read with Attr, so callers that compare a friend's complete record before
// and after a change see every attribute.
type Friend struct {
	Attrs   []xml.Attr     `xml:",any,attr"`
	Servers []FriendServer `xml:"Server"`
}

// Attr returns the named attribute, or "" when it is absent.
func (f Friend) Attr(name string) string {
	for _, a := range f.Attrs {
		if a.Name.Space == "" && a.Name.Local == name {
			return a.Value
		}
	}
	return ""
}

// AttrsExcept returns every attribute except the named ones.
func (f Friend) AttrsExcept(names ...string) []xml.Attr {
	result := []xml.Attr{}
	for _, a := range f.Attrs {
		if a.Name.Space != "" || !slices.Contains(names, a.Name.Local) {
			result = append(result, a)
		}
	}
	return result
}

// FriendServer is a server a friend or invitation refers to.
type FriendServer struct {
	ID      string `xml:"id,attr"`
	Machine string `xml:"machineIdentifier,attr"`
	Pending string `xml:"pending,attr"`
	Owned   string `xml:"owned,attr"`
}

// Friends is the owner's friend list with its paging attributes.
type Friends struct {
	XMLName xml.Name `xml:"MediaContainer"`
	Size    string   `xml:"size,attr"`
	Offset  string   `xml:"offset,attr"`
	Total   string   `xml:"totalSize,attr"`
	Users   []Friend `xml:"User"`
}

// SharedServer is one share of this server with a plex.tv account.
type SharedServer struct {
	ID       string          `xml:"id,attr"`
	UserID   string          `xml:"userID,attr"`
	All      string          `xml:"allLibraries,attr"`
	Accepted string          `xml:"acceptedAt,attr"`
	Sections []SharedSection `xml:"Section"`
}

type SharedSection struct {
	Key    string `xml:"key,attr"`
	Shared string `xml:"shared,attr"`
}

// SharedServers is a server's share list with its paging attributes.
type SharedServers struct {
	XMLName xml.Name       `xml:"MediaContainer"`
	Size    string         `xml:"size,attr"`
	Offset  string         `xml:"offset,attr"`
	Total   string         `xml:"totalSize,attr"`
	Shares  []SharedServer `xml:"SharedServer"`
}

// Account is the plex.tv account that owns the token.
type Account struct {
	XMLName  xml.Name `xml:"user"`
	ID       string   `xml:"id,attr"`
	Username string   `xml:"username,attr"`
	Title    string   `xml:"title,attr"`
	Email    string   `xml:"email,attr"`
	Thumb    string   `xml:"thumb,attr"`
}

// CloudServers is plex.tv's record of a server, with the cloud IDs of its
// library sections.
type CloudServers struct {
	XMLName xml.Name      `xml:"MediaContainer"`
	Servers []CloudServer `xml:"Server"`
}

type CloudServer struct {
	Machine  string         `xml:"machineIdentifier,attr"`
	Sections []CloudSection `xml:"Section"`
}

type CloudSection struct {
	ID  string `xml:"id,attr"`
	Key string `xml:"key,attr"`
}

// SentInvitations are the owner's pending outgoing invitations.
type SentInvitations struct {
	XMLName xml.Name     `xml:"MediaContainer"`
	Size    string       `xml:"size,attr"`
	Offset  string       `xml:"offset,attr"`
	Total   string       `xml:"totalSize,attr"`
	Invites []SentInvite `xml:"Invite"`
}

type SentInvite struct {
	ID      string         `xml:"id,attr"`
	Friend  string         `xml:"friend,attr"`
	Home    string         `xml:"home,attr"`
	Server  string         `xml:"server,attr"`
	Servers []FriendServer `xml:"Server"`
}

func (s *Server) Friends(ctx context.Context) (Friends, error) {
	var result Friends
	return result, s.XML(ctx, cloudAPI+"/users/", &result)
}

func (s *Server) SharedServers(ctx context.Context, machine string) (SharedServers, error) {
	var result SharedServers
	return result, s.XML(ctx, cloudAPI+"/servers/"+url.PathEscape(machine)+"/shared_servers", &result)
}

func (s *Server) Account(ctx context.Context) (Account, error) {
	var result Account
	return result, s.XML(ctx, "https://plex.tv/users/account", &result)
}

func (s *Server) CloudServer(ctx context.Context, machine string) (CloudServers, error) {
	var result CloudServers
	return result, s.XML(ctx, cloudAPI+"/servers/"+url.PathEscape(machine), &result)
}

func (s *Server) SentInvitations(ctx context.Context) (SentInvitations, error) {
	var result SentInvitations
	return result, s.XML(ctx, cloudAPI+"/invites/requested", &result)
}

// write sends one JSON body to plex.tv. The reply is not used: MUM verifies
// every write by reading the result back, and never resends a write whose
// outcome is uncertain.
func (s *Server) write(ctx context.Context, method, target string, body any) error {
	var encoded []byte
	if body != nil {
		var err error
		if encoded, err = json.Marshal(body); err != nil {
			return errors.New("invalid provider request body")
		}
	}
	req, err := http.NewRequestWithContext(ctx, method, target, bytes.NewReader(encoded))
	if err != nil {
		return errors.New("invalid provider request")
	}
	req.Header.Set("Accept", "application/xml")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	s.Authorize(req.Header)
	_, err = s.transport.Send(req)
	return err
}

// CreateShare shares the server: with a friend by account ID, or as an
// invitation to a new person. body is the plex.tv shared_server request.
func (s *Server) CreateShare(ctx context.Context, machine string, body any) error {
	return s.write(ctx, http.MethodPost, cloudAPI+"/servers/"+url.PathEscape(machine)+"/shared_servers", body)
}

// UpdateShare replaces the libraries of an existing share.
func (s *Server) UpdateShare(ctx context.Context, machine, share string, body any) error {
	return s.write(ctx, http.MethodPut, cloudAPI+"/servers/"+url.PathEscape(machine)+"/shared_servers/"+url.PathEscape(share), body)
}

// DeleteShare removes a share of this server.
func (s *Server) DeleteShare(ctx context.Context, machine, share string, body any) error {
	return s.write(ctx, http.MethodDelete, cloudAPI+"/servers/"+url.PathEscape(machine)+"/shared_servers/"+url.PathEscape(share), body)
}

// RemoveFriend removes the friendship with an account, ending every share
// with it.
func (s *Server) RemoveFriend(ctx context.Context, account string) error {
	return s.write(ctx, http.MethodDelete, cloudAPI+"/v2/sharings/"+url.PathEscape(account), nil)
}
