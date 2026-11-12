package main

import (
	"app/server/providers/plex"
	"context"
	"errors"
	"slices"
	"strconv"
	"strings"
)

var errPlexShare = errors.New("Plex sharing state could not be verified")

// Cloud section IDs are not PMS library keys. Never infer this mapping from a
// title, a matching number, or a request's supplied cloud ID.
type plexShareSection struct {
	Key     string
	CloudID string
}
type plexSharePreflight struct {
	Machine        string
	Account        string
	ShareID        string
	State          string // unobserved, pending or accepted; unobserved is not verified absence.
	Sections       []plexShareSection
	LibraryIDs     []string
	AllLibraries   bool
	DownloadsKnown bool
	AllowDownloads bool
	// Friend reports that the account is in the owner's plex.tv user list
	// (a friend), whether or not it currently shares this server.
	Friend bool
}

func plexNumericID(value string) bool {
	n, err := strconv.ParseInt(value, 10, 64)
	return err == nil && n > 0 && strconv.FormatInt(n, 10) == value
}

// Read-only preflight; no capability is enabled and no remote request is replayed.
// A server/user reference and detailed share must agree before accepted access is
// reported. Sent invitations not represented here remain unobserved, not absent.
func (p *serverConnection) inspectPlexShare(ctx context.Context, account string, grant InvitationGrant) (plexSharePreflight, error) {
	result := plexSharePreflight{Account: account, State: "unobserved", Sections: []plexShareSection{}, LibraryIDs: []string{}}
	if p.config.Type != "plex" || !plexNumericID(account) || grant.AllLibraries == (len(grant.LibraryIDs) > 0) || len(grant.LibraryIDs) > 10000 {
		return result, plexShareInvalid("INPUT")
	}
	identity, err := p.plexIdentity(ctx)
	if err != nil || !validProvisionedID(identity.Machine) {
		return result, plexShareInvalid("SERVER_IDENTITY")
	}
	result.Machine = identity.Machine
	local, err := p.plexLibraries(ctx)
	if err != nil {
		return result, plexShareInvalid("LOCAL_LIBRARIES")
	}
	localKeys := map[string]bool{}
	for _, library := range local {
		if !plexNumericID(library.ID) || localKeys[library.ID] {
			return result, plexShareInvalid("LOCAL_LIBRARY_ID")
		}
		localKeys[library.ID] = true
	}
	cloud, cloudErr := p.plexServer().CloudServer(ctx, identity.Machine)
	if cloudErr != nil || len(cloud.Servers) != 1 || cloud.Servers[0].Machine != identity.Machine {
		return result, plexShareInvalid("CLOUD_SERVER")
	}
	mapping := map[string]string{}
	cloudIDs := map[string]bool{}
	for _, section := range cloud.Servers[0].Sections {
		if !plexNumericID(section.ID) || !plexNumericID(section.Key) || mapping[section.Key] != "" || cloudIDs[section.ID] {
			return result, plexShareInvalid("CLOUD_SECTIONS")
		}
		mapping[section.Key] = section.ID
		cloudIDs[section.ID] = true
	}
	keys := slices.Clone(grant.LibraryIDs)
	if grant.AllLibraries {
		for key := range localKeys {
			keys = append(keys, key)
		}
		// Every library on the server must be shareable (checked below). plex.tv
		// may also list stale libraries the server no longer has; those are
		// never shared, so they are ignored rather than failing the invitation.
	}
	slices.Sort(keys)
	for i, key := range keys {
		if !localKeys[key] || mapping[key] == "" || i > 0 && keys[i-1] == key {
			return result, plexShareInvalid("LIBRARY_NOT_ON_PLEX_TV")
		}
		result.Sections = append(result.Sections, plexShareSection{key, mapping[key]})
	}
	if len(result.Sections) == 0 {
		return result, plexShareInvalid("NO_SECTIONS")
	}
	users, usersErr := p.plexServer().Friends(ctx)
	if usersErr != nil {
		return result, plexShareInvalid("USERS_READ")
	}
	foundUser, foundReference := false, false
	referenceID := ""
	for _, user := range users.Users {
		if user.Attr("id") != account {
			continue
		}
		if foundUser {
			return result, plexShareInvalid("USER_DUPLICATE")
		}
		foundUser = true
		result.Friend = true
		result.AllowDownloads, result.DownloadsKnown = plex.ExplicitBool(user.Attr("allowSync"))
		for _, server := range user.Servers {
			if server.Machine != identity.Machine {
				continue
			}
			if foundReference {
				return result, plexShareInvalid("USER_SERVER_ENTRY")
			}
			foundReference = true
			pending, known := plex.ExplicitBool(server.Pending)
			owned, ownedKnown := plex.ExplicitBool(server.Owned)
			if !known || !ownedKnown || owned || !plexNumericID(server.ID) {
				return result, plexShareInvalid("USER_SERVER_FLAGS")
			}
			referenceID = server.ID
			if pending {
				result.State = "pending"
			} else {
				result.State = "accepted"
			}
		}
	}
	shares, sharesErr := p.plexServer().SharedServers(ctx, identity.Machine)
	if sharesErr != nil {
		return result, plexShareInvalid("SHARES_READ")
	}
	for _, share := range shares.Shares {
		if share.UserID != account {
			continue
		}
		if result.ShareID != "" || !plexNumericID(share.ID) || !foundReference || referenceID != share.ID {
			return result, plexShareInvalid("SHARE_REFERENCE")
		}
		result.ShareID = share.ID
		all, known := plex.ExplicitBool(share.All)
		if !known {
			return result, plexShareInvalid("SHARE_ALL_FLAG")
		}
		result.AllLibraries = all
		seen := map[string]bool{}
		for _, section := range share.Sections {
			shared, known := plex.ExplicitBool(section.Shared)
			if !known || !localKeys[section.Key] || mapping[section.Key] == "" || seen[section.Key] {
				return result, plexShareInvalid("SHARE_SECTION")
			}
			seen[section.Key] = true
			if shared {
				result.LibraryIDs = append(result.LibraryIDs, section.Key)
			}
		}
		slices.Sort(result.LibraryIDs)
	}
	if result.State == "accepted" && (result.ShareID == "" || !result.DownloadsKnown) {
		return result, plexShareInvalid("ACCEPTED_INCOMPLETE")
	}
	return result, nil
}

// Read observation is separate from granting/acceptance. Exact requested access
// is checked explicitly; extra selected libraries and unknown downloads fail.
func plexShareMatches(result plexSharePreflight, grant InvitationGrant) bool {
	if result.State != "accepted" || result.ShareID == "" || !result.DownloadsKnown || result.AllowDownloads != grant.AllowDownloads || result.AllLibraries != grant.AllLibraries {
		return false
	}
	if grant.AllLibraries {
		return len(result.Sections) > 0
	}
	keys := slices.Clone(grant.LibraryIDs)
	slices.Sort(keys)
	return len(keys) > 0 && slices.Equal(keys, result.LibraryIDs) && !strings.Contains(result.ShareID, "/")
}
