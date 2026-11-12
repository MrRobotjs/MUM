package main

import (
	"context"
	"encoding/xml"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"slices"
	"strconv"
	"strings"
	"time"
)

func (p *jsonProvider) localJSON(ctx context.Context, endpoint string, out any) error {
	return p.jsonRequest(ctx, http.MethodGet, strings.TrimRight(p.config.URL, "/")+endpoint, nil, out)
}
func (p *jsonProvider) extendedLibraries(ctx context.Context) ([]ProviderLibrary, error) {
	result := []ProviderLibrary{}
	switch p.config.Type {
	case "plex":
		var container struct {
			XMLName   xml.Name `xml:"MediaContainer"`
			Libraries []struct {
				Key   string `xml:"key,attr"`
				Title string `xml:"title,attr"`
				Type  string `xml:"type,attr"`
			} `xml:"Directory"`
		}
		if err := p.plexXML(ctx, strings.TrimRight(p.config.URL, "/")+"/library/sections", &container); err != nil {
			return nil, err
		}
		for _, l := range container.Libraries {
			result = append(result, ProviderLibrary{l.Key, l.Title, l.Type, nil})
		}
	case "komga":
		var rows []struct {
			ID   string `json:"id"`
			Name string `json:"name"`
		}
		if err := p.localJSON(ctx, "/api/v1/libraries", &rows); err != nil {
			return nil, err
		}
		if rows == nil {
			return nil, errors.New("missing Komga library array")
		}
		for _, l := range rows {
			result = append(result, ProviderLibrary{l.ID, l.Name, "comic", nil})
		}
	case "audiobookshelf":
		var response struct {
			Libraries *[]struct {
				ID        string `json:"id"`
				Name      string `json:"name"`
				MediaType string `json:"mediaType"`
			} `json:"libraries"`
		}
		if err := p.localJSON(ctx, "/api/libraries", &response); err != nil {
			return nil, err
		}
		if response.Libraries == nil {
			return nil, errors.New("missing Audiobookshelf libraries")
		}
		for _, l := range *response.Libraries {
			kind := l.MediaType
			if kind == "" {
				kind = "book"
			}
			result = append(result, ProviderLibrary{l.ID, l.Name, kind, nil})
		}
	case "romm":
		var rows []struct {
			ID    *int64 `json:"id"`
			Name  string `json:"name"`
			Count *int64 `json:"rom_count"`
		}
		if err := p.localJSON(ctx, "/api/platforms", &rows); err != nil {
			return nil, err
		}
		if rows == nil {
			return nil, errors.New("missing RomM platform array")
		}
		for _, l := range rows {
			if l.ID == nil {
				return nil, errors.New("missing RomM platform ID")
			}
			result = append(result, ProviderLibrary{fmt.Sprint(*l.ID), l.Name, "rom", l.Count})
		}
	}
	return result, nil
}

func (p *jsonProvider) extendedUsers(ctx context.Context) ([]ProviderUser, error) {
	result := []ProviderUser{}
	switch p.config.Type {
	case "plex":
		return p.plexUsers(ctx)
	case "komga":
		var rows []struct {
			ID        string    `json:"id"`
			Email     string    `json:"email"`
			All       *bool     `json:"sharedAllLibraries"`
			Libraries *[]string `json:"sharedLibrariesIds"`
			Roles     *[]string `json:"roles"`
		}
		if err := p.localJSON(ctx, "/api/v2/users", &rows); err != nil {
			return nil, err
		}
		if rows == nil {
			return nil, errors.New("missing Komga user array")
		}
		for _, u := range rows {
			if u.All == nil || u.Libraries == nil || u.Roles == nil {
				return nil, errors.New("missing Komga library access policy")
			}
			for _, role := range *u.Roles {
				if strings.TrimSpace(role) == "" {
					return nil, errors.New("invalid Komga role observation")
				}
			}
			ids := *u.Libraries
			result = append(result, ProviderUser{u.ID, u.Email, u.Email, slices.Contains(*u.Roles, "ADMIN") || (*u.All || len(ids) > 0) && (slices.Contains(*u.Roles, "PAGE_STREAMING") || slices.Contains(*u.Roles, "FILE_DOWNLOAD") || slices.Contains(*u.Roles, "KOBO_SYNC") || slices.Contains(*u.Roles, "KOREADER_SYNC")), *u.All, ids, &ProviderUserAccess{LibrariesKnown: true, DownloadsKnown: true, AllowDownloads: slices.Contains(*u.Roles, "FILE_DOWNLOAD")}, nil})
		}
	case "audiobookshelf":
		var response struct {
			Users *[]struct {
				ID          string   `json:"id"`
				Name        string   `json:"username"`
				Active      *bool    `json:"isActive"`
				Locked      bool     `json:"isLocked"`
				Libraries   []string `json:"librariesAccessible"`
				Permissions struct {
					All      *bool `json:"accessAllLibraries"`
					Download *bool `json:"download"`
				} `json:"permissions"`
			} `json:"users"`
		}
		if err := p.localJSON(ctx, "/api/users", &response); err != nil {
			return nil, err
		}
		if response.Users == nil {
			return nil, errors.New("missing Audiobookshelf users")
		}
		for _, u := range *response.Users {
			if u.Active == nil || u.Permissions.All == nil {
				return nil, errors.New("missing Audiobookshelf access policy")
			}
			ids := u.Libraries
			if ids == nil {
				ids = []string{}
			}
			access := &ProviderUserAccess{LibrariesKnown: true}
			if u.Permissions.Download != nil {
				access.DownloadsKnown = true
				access.AllowDownloads = *u.Permissions.Download
			}
			result = append(result, ProviderUser{u.ID, u.Name, "", *u.Active && !u.Locked, *u.Permissions.All, ids, access, nil})
		}
	case "romm":
		return p.readRomMUsers(ctx)
	}
	return result, nil
}

type plexServerIdentity struct {
	XMLName xml.Name `xml:"MediaContainer"`
	Machine string   `xml:"machineIdentifier,attr"`
	Name    string   `xml:"friendlyName,attr"`
	Version string   `xml:"version,attr"`
}

func (p *jsonProvider) plexXML(ctx context.Context, target string, out any) error {
	body, err := p.fetch(ctx, http.MethodGet, target, nil)
	if err != nil {
		return err
	}
	if err := xml.Unmarshal(body, out); err != nil {
		return errors.New("invalid Plex XML response")
	}
	return nil
}
func (p *jsonProvider) plexIdentity(ctx context.Context) (plexServerIdentity, error) {
	var identity plexServerIdentity
	err := p.plexXML(ctx, strings.TrimRight(p.config.URL, "/")+"/", &identity)
	if err == nil && identity.Machine == "" {
		err = errors.New("Plex server identity missing")
	}
	return identity, err
}

// plexOwnerAccountID is the server-local account ID Plex Media Server gives
// its owner.
const plexOwnerAccountID = "1"

func (p *jsonProvider) plexUsers(ctx context.Context) ([]ProviderUser, error) {
	identity, err := p.plexIdentity(ctx)
	if err != nil {
		return nil, err
	}
	// Cloud endpoints are fixed by the adapter, not configurable or obtained from
	// upstream redirects. Sensitive share/token attributes are never retained.
	var users struct {
		XMLName xml.Name `xml:"MediaContainer"`
		Users   []struct {
			ID       string `xml:"id,attr"`
			Username string `xml:"username,attr"`
			Title    string `xml:"title,attr"`
			Email    string `xml:"email,attr"`
			Thumb    string `xml:"thumb,attr"`
			Servers  []struct {
				Machine string `xml:"machineIdentifier,attr"`
				Pending string `xml:"pending,attr"`
			} `xml:"Server"`
		} `xml:"User"`
	}
	if err := p.plexXML(ctx, "https://plex.tv/api/users/", &users); err != nil {
		return nil, err
	}
	var grants struct {
		XMLName xml.Name `xml:"MediaContainer"`
		Shares  []struct {
			UserID   string `xml:"userID,attr"`
			All      string `xml:"allLibraries,attr"`
			Accepted string `xml:"acceptedAt,attr"`
			Sections []struct {
				Key    string `xml:"key,attr"`
				Shared string `xml:"shared,attr"`
			} `xml:"Section"`
		} `xml:"SharedServer"`
	}
	if err := p.plexXML(ctx, "https://plex.tv/api/servers/"+url.PathEscape(identity.Machine)+"/shared_servers", &grants); err != nil {
		return nil, err
	}
	// The token's account owns the server: plex.tv only lets the owner read
	// shared_servers above. The owner never appears in that list, so it is
	// read here; a failure fails the snapshot rather than dropping the owner.
	var owner struct {
		XMLName  xml.Name `xml:"user"`
		ID       string   `xml:"id,attr"`
		Username string   `xml:"username,attr"`
		Title    string   `xml:"title,attr"`
		Email    string   `xml:"email,attr"`
		Thumb    string   `xml:"thumb,attr"`
	}
	if err := p.plexXML(ctx, "https://plex.tv/users/account", &owner); err != nil {
		return nil, err
	}
	ownerName := owner.Username
	if ownerName == "" {
		ownerName = owner.Title
	}
	if owner.ID == "" || ownerName == "" {
		return nil, errors.New("Plex owner account is incomplete")
	}
	policy := map[string]ProviderUser{}
	for _, g := range grants.Shares {
		if g.UserID == "" {
			return nil, errors.New("Plex sharing record missing user ID")
		}
		if _, duplicate := policy[g.UserID]; duplicate {
			return nil, errors.New("duplicate Plex sharing record")
		}
		all, known := plexExplicitBool(g.All)
		if !known {
			return nil, errors.New("Plex sharing record missing explicit library policy")
		}
		ids := []string{}
		seen := map[string]bool{}
		for _, s := range g.Sections {
			shared, known := plexExplicitBool(s.Shared)
			if !known || s.Key == "" || seen[s.Key] {
				return nil, errors.New("Plex sharing record has ambiguous library policy")
			}
			seen[s.Key] = true
			if shared {
				if s.Key == "" {
					return nil, errors.New("Plex sharing record missing library key")
				}
				ids = append(ids, s.Key)
			}
		}
		policy[g.UserID] = ProviderUser{AllLibraries: all, LibraryIDs: ids, Profile: &ProviderUserProfile{JoinDate: plexShareJoinDate(g.Accepted)}}
	}
	// Plex Media Server reports its owner as local account 1 (also in playback
	// sessions), so that is the owner's stable identity on this server. The
	// owner has every library; plex.tv supplies no share date for it.
	result := []ProviderUser{{plexOwnerAccountID, ownerName, owner.Email, true, true, []string{}, nil, &ProviderUserProfile{AvatarURL: safePlexUserAvatar(owner.Thumb)}}}
	seenUsers := map[string]bool{plexOwnerAccountID: true}
	for _, u := range users.Users {
		if u.ID == owner.ID {
			continue // the owner is already included as local account 1
		}
		for _, server := range u.Servers {
			if server.Machine != identity.Machine {
				continue
			}
			if u.ID == "" || seenUsers[u.ID] {
				return nil, errors.New("Plex sharing user reference is ambiguous")
			}
			seenUsers[u.ID] = true
			grant, found := policy[u.ID]
			pending, known := plexExplicitBool(server.Pending)
			if !known {
				return nil, errors.New("Plex sharing reference missing explicit acceptance state")
			}
			if !found && !pending {
				return nil, errors.New("Plex sharing data is incomplete")
			}
			name := u.Username
			if name == "" {
				name = u.Title
			}
			if grant.LibraryIDs == nil {
				grant.LibraryIDs = []string{}
			}
			profile := &ProviderUserProfile{AvatarURL: safePlexUserAvatar(u.Thumb)}
			if !pending && grant.Profile != nil {
				profile.JoinDate = grant.Profile.JoinDate
			}
			result = append(result, ProviderUser{u.ID, name, u.Email, !pending, grant.AllLibraries, grant.LibraryIDs, nil, profile})
		}
	}
	return result, nil
}

// Plex's SharedServer.acceptedAt is the share acceptance time in Unix seconds,
// not the cloud account creation time. An absent/invalid timestamp is unknown.
func plexShareJoinDate(value string) string {
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
