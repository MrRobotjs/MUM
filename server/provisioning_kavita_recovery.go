package main

import (
	"context"
	"net/http"
	"slices"
	"strconv"
	"strings"
)

type kavitaReviewUser struct {
	ID        int64
	Name      string
	Roles     []string
	Libraries []int64
	Age       kavitaAgeRestriction
}

func kavitaRecordedID(id string) (int64, error) {
	value, err := strconv.ParseInt(id, 10, 32)
	if err != nil || value < 1 || strconv.FormatInt(value, 10) != id {
		return 0, ErrConflict
	}
	return value, nil
}

func (p *jsonProvider) inspectKavitaProvisionedUser(ctx context.Context, id, name string) (remoteReview, error) {
	value, err := kavitaRecordedID(id)
	if err != nil || name == "" {
		return remoteReview{}, ErrConflict
	}
	var members []struct {
		ID               *int64    `json:"id"`
		Username         string    `json:"username"`
		Pending          *bool     `json:"isPending"`
		IdentityProvider *int      `json:"identityProvider"`
		Roles            *[]string `json:"roles"`
		Libraries        *[]struct {
			ID *int64 `json:"id"`
		} `json:"libraries"`
		Age *struct {
			Rating          *int  `json:"ageRating"`
			IncludeUnknowns *bool `json:"includeUnknowns"`
		} `json:"ageRestriction"`
	}
	// This administrator-only, unpaginated list includes pending accounts. HTTP
	// errors/null/malformed lists never prove absence; no username adoption occurs.
	if err := p.get(ctx, "/Users?includePending=true", &members); err != nil {
		return remoteReview{}, err
	}
	if members == nil || len(members) > 10000 {
		return remoteReview{}, ErrConflict
	}
	seen := map[int64]bool{}
	seenNames := map[string]bool{}
	result := remoteReview{ID: id, Name: name, Absent: true}
	for _, member := range members {
		if member.ID == nil || *member.ID < 1 || *member.ID > 2147483647 || seen[*member.ID] {
			return remoteReview{}, ErrConflict
		}
		seen[*member.ID] = true
		nameKey := strings.ToLower(member.Username)
		if nameKey == "" || seenNames[nameKey] {
			return remoteReview{}, ErrConflict
		}
		seenNames[nameKey] = true
		if *member.ID != value {
			continue
		}
		if member.Username != name || member.Pending == nil || *member.Pending || member.IdentityProvider == nil || *member.IdentityProvider != 0 || member.Roles == nil || member.Libraries == nil || member.Age == nil || member.Age.Rating == nil || member.Age.IncludeUnknowns == nil {
			return remoteReview{}, ErrConflict
		}
		roles := map[string]bool{}
		for _, role := range *member.Roles {
			if roles[role] {
				return remoteReview{}, ErrConflict
			}
			roles[role] = true
			switch role {
			case "Pleb", "Login", "Download", "Change Password", "Bookmark", "Change Restriction", "Read Only", "Promote":
			default:
				return remoteReview{}, ErrConflict
			}
		}
		if !roles["Pleb"] {
			return remoteReview{}, ErrConflict
		}
		libraries := []int64{}
		seenLibraries := map[int64]bool{}
		for _, library := range *member.Libraries {
			if library.ID == nil || *library.ID < 1 || *library.ID > 2147483647 || seenLibraries[*library.ID] {
				return remoteReview{}, ErrConflict
			}
			seenLibraries[*library.ID] = true
			libraries = append(libraries, *library.ID)
		}
		user := kavitaReviewUser{value, name, slices.Clone(*member.Roles), libraries, kavitaAgeRestriction{*member.Age.Rating, *member.Age.IncludeUnknowns}}
		result = remoteReview{ID: id, Name: name, Disabled: !roles["Login"], Kavita: &user}
	}
	return result, nil
}

func kavitaGrantMatches(user *kavitaReviewUser, grant InvitationGrant, enabled bool) bool {
	if user == nil {
		return false
	}
	libraries, err := kavitaLibraryIDs(grant)
	if err != nil {
		return false
	}
	actualLibraries := slices.Clone(user.Libraries)
	slices.Sort(libraries)
	slices.Sort(actualLibraries)
	roles := slices.Clone(user.Roles)
	expectedRoles := kavitaRoles(grant.AllowDownloads, enabled)
	slices.Sort(roles)
	slices.Sort(expectedRoles)
	return slices.Equal(libraries, actualLibraries) && slices.Equal(roles, expectedRoles)
}

func (p *jsonProvider) updateKavitaUser(ctx context.Context, user kavitaReviewUser, roles []string, libraries []int64) error {
	// Kavita adds Pleb itself. Preserve username, identity provider and observed
	// age limits; omit email to avoid an unrelated email-change side effect.
	requested := []string{}
	for _, role := range roles {
		if role != "Pleb" {
			requested = append(requested, role)
		}
	}
	body := struct {
		UserID           int64                `json:"userId"`
		Username         string               `json:"username"`
		Roles            []string             `json:"roles"`
		Libraries        []int64              `json:"libraries"`
		Age              kavitaAgeRestriction `json:"ageRestriction"`
		IdentityProvider int                  `json:"identityProvider"`
	}{user.ID, user.Name, requested, libraries, user.Age, 0}
	return p.jsonRequest(ctx, http.MethodPost, strings.TrimRight(p.config.URL, "/")+"/api/Account/update", body, nil)
}

func (p *jsonProvider) disableKavitaUser(ctx context.Context, original remoteReview) error {
	if original.Kavita == nil {
		return ErrConflict
	}
	user := *original.Kavita
	roles := slices.DeleteFunc(slices.Clone(user.Roles), func(role string) bool { return role == "Login" })
	if err := p.updateKavitaUser(ctx, user, roles, user.Libraries); err != nil {
		return err
	}
	verified, err := p.inspectKavitaProvisionedUser(ctx, original.ID, original.Name)
	if err != nil {
		return err
	}
	if verified.Absent || !verified.Disabled || verified.Kavita == nil || verified.Kavita.Age != user.Age {
		return ErrConflict
	}
	actualRoles := slices.Clone(verified.Kavita.Roles)
	slices.Sort(actualRoles)
	slices.Sort(roles)
	actualLibraries := slices.Clone(verified.Kavita.Libraries)
	expectedLibraries := slices.Clone(user.Libraries)
	slices.Sort(actualLibraries)
	slices.Sort(expectedLibraries)
	if !slices.Equal(actualRoles, roles) || !slices.Equal(actualLibraries, expectedLibraries) {
		return ErrConflict
	}
	return nil
}

func (p *jsonProvider) resumeKavitaUser(ctx context.Context, target resumeTarget, checkpoint func(string) error) error {
	user, err := p.inspectKavitaProvisionedUser(ctx, target.Step.RemoteID, target.Step.RemoteName)
	if err != nil {
		return err
	}
	if user.Absent || user.Kavita == nil {
		return ErrConflict
	}
	ids, err := kavitaLibraryIDs(target.Grant)
	if err != nil {
		return err
	}
	if err := checkpoint("configuring"); err != nil {
		return err
	}
	if err := p.updateKavitaUser(ctx, *user.Kavita, kavitaRoles(target.Grant.AllowDownloads, false), ids); err != nil {
		return err
	}
	disabled, err := p.inspectKavitaProvisionedUser(ctx, user.ID, user.Name)
	if err != nil {
		return err
	}
	if !kavitaGrantMatches(disabled.Kavita, target.Grant, false) || disabled.Kavita.Age != user.Kavita.Age {
		return ErrConflict
	}
	if err := checkpoint("password"); err != nil {
		return err
	}
	// Kavita's administrative reset takes a username, so only the name just
	// verified against the durable ID is used. No invitation/confirmation replay.
	body := struct {
		Username string `json:"userName"`
		Password string `json:"password"`
	}{user.Name, target.Password}
	if err := p.jsonRequest(ctx, http.MethodPost, strings.TrimRight(p.config.URL, "/")+"/api/Account/reset-password", body, nil); err != nil {
		return err
	}
	if err := checkpoint("enabling"); err != nil {
		return err
	}
	// Re-inspect the durable identity after the name-based password operation.
	current, err := p.inspectKavitaProvisionedUser(ctx, user.ID, user.Name)
	if err != nil {
		return err
	}
	if !kavitaGrantMatches(current.Kavita, target.Grant, false) || current.Kavita.Age != user.Kavita.Age {
		return ErrConflict
	}
	if err := p.updateKavitaUser(ctx, *current.Kavita, kavitaRoles(target.Grant.AllowDownloads, true), ids); err != nil {
		return err
	}
	verified, err := p.inspectKavitaProvisionedUser(ctx, user.ID, user.Name)
	if err != nil {
		return err
	}
	if !kavitaGrantMatches(verified.Kavita, target.Grant, true) || verified.Kavita.Age != user.Kavita.Age {
		return ErrConflict
	}
	return checkpoint("verified")
}
