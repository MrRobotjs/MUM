package main

import (
	"context"
	"encoding/xml"
	"errors"
	"net/http"
	"net/url"
	"strconv"
)

type bulkPlexState struct {
	Owner, Recipient string
	Friend           bool
	Plan             plexSharePreflight
	Attributes       []xml.Attr
}

func (p *jsonProvider) prepareBulkPlex(ctx context.Context, r bulkProviderRequest) (bulkProviderSnapshot, error) {
	s := bulkProviderSnapshot{}
	if !plexNumericID(r.ID) || r.ID == plexOwnerAccountID {
		return s, ErrConflict
	}
	var owner struct {
		XMLName xml.Name `xml:"user"`
		ID      string   `xml:"id,attr"`
	}
	if err := p.plexXML(ctx, "https://plex.tv/users/account", &owner); err != nil {
		return s, err
	}
	if !plexNumericID(owner.ID) || owner.ID == r.ID {
		return s, ErrConflict
	}
	var users struct {
		XMLName xml.Name `xml:"MediaContainer"`
		Size    string   `xml:"size,attr"`
		Offset  string   `xml:"offset,attr"`
		Total   string   `xml:"totalSize,attr"`
		Users   []struct {
			ID         string     `xml:"id,attr"`
			Name       string     `xml:"username,attr"`
			Title      string     `xml:"title,attr"`
			Restricted string     `xml:"restricted,attr"`
			Home       string     `xml:"home,attr"`
			Attrs      []xml.Attr `xml:",any,attr"`
		} `xml:"User"`
	}
	if err := p.plexXML(ctx, "https://plex.tv/api/users/", &users); err != nil {
		return s, err
	}
	if !completePlexList(users.Size, users.Offset, users.Total, len(users.Users)) {
		return s, ErrConflict
	}
	state := bulkPlexState{Owner: owner.ID, Recipient: r.ID}
	seen := map[string]bool{}
	for _, u := range users.Users {
		if !plexNumericID(u.ID) || seen[u.ID] {
			return s, ErrConflict
		}
		seen[u.ID] = true
		if u.ID != r.ID {
			continue
		}
		if u.Name != r.Name && u.Title != r.Name {
			return s, ErrConflict
		}
		if u.Restricted != "" && u.Restricted != "0" && u.Restricted != "false" {
			return s, ErrConflict
		}
		if u.Home != "" && u.Home != "0" && u.Home != "false" {
			return s, ErrConflict
		}
		state.Friend = true
		state.Attributes = u.Attrs
	}
	if r.Action == "delete_users" && !state.Friend {
		identity, err := p.plexIdentity(ctx)
		if err != nil {
			return s, err
		}
		var shares struct {
			XMLName xml.Name `xml:"MediaContainer"`
			Size    string   `xml:"size,attr"`
			Offset  string   `xml:"offset,attr"`
			Total   string   `xml:"totalSize,attr"`
			Shares  []struct {
				ID   string `xml:"id,attr"`
				User string `xml:"userID,attr"`
			} `xml:"SharedServer"`
		}
		if err := p.plexXML(ctx, "https://plex.tv/api/servers/"+url.PathEscape(identity.Machine)+"/shared_servers", &shares); err != nil {
			return s, err
		}
		if !completePlexList(shares.Size, shares.Offset, shares.Total, len(shares.Shares)) {
			return s, ErrConflict
		}
		ids := map[string]bool{}
		for _, share := range shares.Shares {
			if !plexNumericID(share.ID) || !plexNumericID(share.User) || ids[share.ID] || share.User == r.ID {
				return s, ErrConflict
			}
			ids[share.ID] = true
		}
		invites, err := p.plexSentInvitations(ctx)
		if err != nil {
			return s, err
		}
		for _, invite := range invites {
			if invite.Account == r.ID {
				return s, ErrConflict
			}
		}
	}
	if r.Action == "update_libraries" {
		if !r.AllLibraries && len(r.LibraryIDs) == 0 {
			return s, ErrConflict
		}
		plan, err := p.inspectPlexShare(ctx, r.ID, InvitationGrant{AllLibraries: r.AllLibraries, LibraryIDs: r.LibraryIDs})
		if err != nil {
			return s, err
		}
		if !state.Friend || plan.State != "accepted" || plan.ShareID == "" {
			return s, ErrConflict
		}
		if r.AllLibraries && !plan.AllLibraries {
			return s, errBulkPlexDynamicAll
		}
		state.Plan = plan
	}
	s.PlexOwner = owner.ID
	s.PlexRecipient = r.ID
	s.Group = bulkHash([]string{"plex", owner.ID, r.ID})
	s.Absent = !state.Friend
	s.plex = &state
	s.Revision = bulkHash(state)
	return s, nil
}
func (p *jsonProvider) reconcileBulkPlex(r bulkProviderRequest, s bulkProviderSnapshot) bulkProviderResult {
	if r.Action == "delete_users" && s.Absent {
		return bulkProviderResult{"deleted", "PLEX_FRIEND_ABSENT"}
	}
	if r.Action == "update_libraries" && s.plex != nil && s.plex.Plan.AllLibraries == r.AllLibraries && (r.AllLibraries || bulkIDsEqual(s.plex.Plan.LibraryIDs, r.LibraryIDs)) {
		return bulkProviderResult{"updated", "GRANT_VERIFIED"}
	}
	return bulkProviderResult{"unknown", "REMOTE_UNVERIFIED"}
}
func (p *jsonProvider) executeBulkPlex(ctx context.Context, r bulkProviderRequest, s bulkProviderSnapshot, checkpoint func(string) error) (bulkProviderResult, error) {
	match := p.reconcileBulkPlex(r, s)
	if match.Outcome == "deleted" {
		return match, nil
	}
	if match.Outcome == "updated" {
		return bulkProviderResult{"unchanged", "GRANT_UNCHANGED"}, nil
	}
	if checkpoint == nil {
		return bulkProviderResult{"failed", "CHECKPOINT_REQUIRED"}, ErrConflict
	}
	stage := "grant_dispatched"
	if r.Action == "delete_users" {
		stage = "delete_dispatched"
	}
	if err := checkpoint(stage); err != nil {
		return bulkProviderResult{"failed", "CHECKPOINT_FAILED"}, err
	}
	var writeErr error
	if r.Action == "delete_users" {
		_, writeErr = p.fetch(ctx, http.MethodDelete, "https://plex.tv/api/v2/sharings/"+url.PathEscape(r.ID), nil)
	} else {
		plan := s.plex.Plan
		ids := []int64{}
		for _, section := range plan.Sections {
			n, e := strconv.ParseInt(section.CloudID, 10, 64)
			if e != nil {
				return bulkProviderResult{"failed", "INVALID_LIBRARY_MAPPING"}, e
			}
			ids = append(ids, n)
		}
		body := map[string]any{"server_id": plan.Machine, "shared_server": map[string]any{"library_section_ids": ids}}
		_, writeErr = p.fetch(ctx, http.MethodPut, "https://plex.tv/api/servers/"+url.PathEscape(plan.Machine)+"/shared_servers/"+url.PathEscape(plan.ShareID), body)
	}
	after, err := p.prepareBulkPlex(ctx, r)
	if err != nil {
		return bulkProviderResult{"unknown", "REMOTE_UNVERIFIED"}, nil
	}
	if r.Action == "update_libraries" && bulkPlexProtection(s.plex) != bulkPlexProtection(after.plex) {
		return bulkProviderResult{"unknown", "REMOTE_POLICY_CHANGED"}, nil
	}
	result := p.reconcileBulkPlex(r, after)
	if result.Outcome == "updated" || result.Outcome == "deleted" {
		return result, nil
	}
	if writeErr != nil {
		return bulkProviderResult{"unknown", "REMOTE_UNVERIFIED"}, nil
	}
	return bulkProviderResult{"failed", "REMOTE_NOT_APPLIED"}, nil
}

func bulkPlexProtection(s *bulkPlexState) string {
	if s == nil {
		return ""
	}
	return bulkHash(struct {
		Owner, Recipient, Machine, Share, State string
		Friend, Known, Downloads                bool
		Attrs                                   []xml.Attr
	}{s.Owner, s.Recipient, s.Plan.Machine, s.Plan.ShareID, s.Plan.State, s.Friend, s.Plan.DownloadsKnown, s.Plan.AllowDownloads, s.Attributes})
}

var errBulkPlexDynamicAll = errors.New("PLEX_DYNAMIC_ALL_UNSUPPORTED")
