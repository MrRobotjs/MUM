package plex

import (
	"context"
	"encoding/xml"
	"errors"
	"net/http"
	"net/url"
)

// Plex limits how many people one Plex account can share its servers with:
// 99 besides the owner, Plex Home members included, of whom at most 14 can
// be Plex Home members besides the owner.
const (
	MemberLimit = 99
	HomeLimit   = 14
)

// HomeUsers is the owner's Plex Home: the owner (admin), Plex's built-in
// guest account, managed users and invited members.
type HomeUsers struct {
	XMLName xml.Name   `xml:"MediaContainer"`
	Users   []HomeUser `xml:"User"`
}

type HomeUser struct {
	ID    string `xml:"id,attr"`
	Admin string `xml:"admin,attr"`
	Guest string `xml:"guest,attr"`
}

func (s *Server) HomeUsers(ctx context.Context) (HomeUsers, error) {
	var result HomeUsers
	return result, s.XML(ctx, cloudAPI+"/home/users", &result)
}

// InviteToHome invites the plex.tv account with this username or email into
// the owner's Plex Home; they accept the invitation in Plex.
func (s *Server) InviteToHome(ctx context.Context, invited string) error {
	if invited == "" {
		return errors.New("Plex Home invitation needs a username")
	}
	return s.write(ctx, http.MethodPost, cloudAPI+"/home/users?"+url.Values{"invitedEmail": {invited}}.Encode(), nil)
}

// MemberCounts reads the account's members as plex.tv counts them for its
// limits: every friend (Plex Home members included) and invitation awaiting
// acceptance, and the Home members besides the owner and the guest account
// with pending Home invitations. Each person is counted once.
func (s *Server) MemberCounts(ctx context.Context) (members, home int, err error) {
	friends, err := s.Friends(ctx)
	if err != nil {
		return 0, 0, err
	}
	sent, err := s.SentInvitations(ctx)
	if err != nil {
		return 0, 0, err
	}
	homeUsers, err := s.HomeUsers(ctx)
	if err != nil {
		return 0, 0, err
	}
	people := map[string]bool{}
	for _, f := range friends.Users {
		if id := f.Attr("id"); id != "" {
			people[id] = true
		}
	}
	inHome := map[string]bool{}
	for _, u := range homeUsers.Users {
		admin, _ := ExplicitBool(u.Admin)
		guest, _ := ExplicitBool(u.Guest)
		if u.ID != "" && !admin && !guest {
			inHome[u.ID] = true
		}
	}
	for _, invite := range sent.Invites {
		if invite.ID == "" {
			continue
		}
		people[invite.ID] = true
		if invited, _ := ExplicitBool(invite.Home); invited {
			inHome[invite.ID] = true
		}
	}
	for id := range inHome {
		people[id] = true
	}
	return len(people), len(inHome), nil
}
