package main

import (
	"context"
	"encoding/xml"
	"errors"
	"strconv"
)

type editPlexState struct {
	Owner, Recipient string
	Friend           bool
	Plan             plexSharePreflight
	Attributes       []xml.Attr
}

func (p *serverConnection) prepareEditPlex(ctx context.Context, r editProviderRequest) (editProviderSnapshot, error) {
	s := editProviderSnapshot{}
	if !plexNumericID(r.ID) || r.ID == plexOwnerAccountID {
		return s, ErrConflict
	}
	owner, err := p.plexServer().Account(ctx)
	if err != nil {
		return s, err
	}
	if !plexNumericID(owner.ID) || owner.ID == r.ID {
		return s, ErrConflict
	}
	users, err := p.plexServer().Friends(ctx)
	if err != nil {
		return s, err
	}
	if !completePlexList(users.Size, users.Offset, users.Total, len(users.Users)) {
		return s, ErrConflict
	}
	state := editPlexState{Owner: owner.ID, Recipient: r.ID}
	seen := map[string]bool{}
	for _, u := range users.Users {
		if !plexNumericID(u.Attr("id")) || seen[u.Attr("id")] {
			return s, ErrConflict
		}
		seen[u.Attr("id")] = true
		if u.Attr("id") != r.ID {
			continue
		}
		if u.Attr("username") != r.Name && u.Attr("title") != r.Name {
			return s, ErrConflict
		}
		if restricted := u.Attr("restricted"); restricted != "" && restricted != "0" && restricted != "false" {
			return s, ErrConflict
		}
		if home := u.Attr("home"); home != "" && home != "0" && home != "false" {
			return s, ErrConflict
		}
		state.Friend = true
		// The protection hash covers every attribute except those checked above.
		state.Attributes = u.AttrsExcept("id", "username", "title", "restricted", "home")
	}
	if r.Action == "delete_users" && !state.Friend {
		identity, err := p.plexIdentity(ctx)
		if err != nil {
			return s, err
		}
		shares, err := p.plexServer().SharedServers(ctx, identity.Machine)
		if err != nil {
			return s, err
		}
		if !completePlexList(shares.Size, shares.Offset, shares.Total, len(shares.Shares)) {
			return s, ErrConflict
		}
		ids := map[string]bool{}
		for _, share := range shares.Shares {
			if !plexNumericID(share.ID) || !plexNumericID(share.UserID) || ids[share.ID] || share.UserID == r.ID {
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
			return s, errEditPlexDynamicAll
		}
		state.Plan = plan
	}
	s.PlexOwner = owner.ID
	s.PlexRecipient = r.ID
	s.Group = editHash([]string{"plex", owner.ID, r.ID})
	s.Absent = !state.Friend
	s.plex = &state
	s.Revision = editHash(state)
	return s, nil
}
func (p *serverConnection) reconcileEditPlex(r editProviderRequest, s editProviderSnapshot) editProviderResult {
	if r.Action == "delete_users" && s.Absent {
		return editProviderResult{"deleted", "PLEX_FRIEND_ABSENT"}
	}
	if r.Action == "update_libraries" && s.plex != nil && s.plex.Plan.AllLibraries == r.AllLibraries && (r.AllLibraries || editIDsEqual(s.plex.Plan.LibraryIDs, r.LibraryIDs)) {
		return editProviderResult{"updated", "GRANT_VERIFIED"}
	}
	return editProviderResult{"unknown", "REMOTE_UNVERIFIED"}
}
func (p *serverConnection) executeEditPlex(ctx context.Context, r editProviderRequest, s editProviderSnapshot, checkpoint func(string) error) (editProviderResult, error) {
	match := p.reconcileEditPlex(r, s)
	if match.Outcome == "deleted" {
		return match, nil
	}
	if match.Outcome == "updated" {
		return editProviderResult{"unchanged", "GRANT_UNCHANGED"}, nil
	}
	if checkpoint == nil {
		return editProviderResult{"failed", "CHECKPOINT_REQUIRED"}, ErrConflict
	}
	stage := "grant_dispatched"
	if r.Action == "delete_users" {
		stage = "delete_dispatched"
	}
	if err := checkpoint(stage); err != nil {
		return editProviderResult{"failed", "CHECKPOINT_FAILED"}, err
	}
	var writeErr error
	if r.Action == "delete_users" {
		writeErr = p.plexServer().RemoveFriend(ctx, r.ID)
	} else {
		plan := s.plex.Plan
		ids := []int64{}
		for _, section := range plan.Sections {
			n, e := strconv.ParseInt(section.CloudID, 10, 64)
			if e != nil {
				return editProviderResult{"failed", "INVALID_LIBRARY_MAPPING"}, e
			}
			ids = append(ids, n)
		}
		body := map[string]any{"server_id": plan.Machine, "shared_server": map[string]any{"library_section_ids": ids}}
		writeErr = p.plexServer().UpdateShare(ctx, plan.Machine, plan.ShareID, body)
	}
	after, err := p.prepareEditPlex(ctx, r)
	if err != nil {
		return editProviderResult{"unknown", "REMOTE_UNVERIFIED"}, nil
	}
	if r.Action == "update_libraries" && editPlexProtection(s.plex) != editPlexProtection(after.plex) {
		return editProviderResult{"unknown", "REMOTE_POLICY_CHANGED"}, nil
	}
	result := p.reconcileEditPlex(r, after)
	if result.Outcome == "updated" || result.Outcome == "deleted" {
		return result, nil
	}
	if writeErr != nil {
		return editProviderResult{"unknown", "REMOTE_UNVERIFIED"}, nil
	}
	return editProviderResult{"failed", "REMOTE_NOT_APPLIED"}, nil
}

func editPlexProtection(s *editPlexState) string {
	if s == nil {
		return ""
	}
	return editHash(struct {
		Owner, Recipient, Machine, Share, State string
		Friend, Known, Downloads                bool
		Attrs                                   []xml.Attr
	}{s.Owner, s.Recipient, s.Plan.Machine, s.Plan.ShareID, s.Plan.State, s.Friend, s.Plan.DownloadsKnown, s.Plan.AllowDownloads, s.Attributes})
}

var errEditPlexDynamicAll = errors.New("PLEX_DYNAMIC_ALL_UNSUPPORTED")
