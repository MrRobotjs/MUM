package main

import (
	"context"
	"maps"
	"net/http"
	"net/url"
	"slices"
)

// enableRecordedUser reverses a flag-based disable for an account inspected as
// disabled. Every other observed policy field is written back unchanged and,
// where the provider exposes it, verified afterwards. Komga is unsupported:
// its cleanup removed media access, and restoring it would invent a grant.
func (p *jsonProvider) enableRecordedUser(ctx context.Context, user remoteReview) error {
	switch p.config.Type {
	case "jellyfin", "emby":
		if user.Policy == nil {
			return ErrConflict
		}
		user.Policy["IsDisabled"] = false
		return p.mediaUserRequest(ctx, http.MethodPost, "/Users/"+url.PathEscape(user.ID)+"/Policy", user.Policy, nil)
	case "kavita":
		return p.enableKavitaUser(ctx, user)
	case "audiobookshelf":
		return p.enableABSUser(ctx, user)
	case "romm":
		return p.enableRomMUser(ctx, user)
	}
	return ErrConflict
}

func (p *jsonProvider) enableKavitaUser(ctx context.Context, original remoteReview) error {
	if original.Kavita == nil {
		return ErrConflict
	}
	user := *original.Kavita
	roles := slices.Clone(user.Roles)
	if !slices.Contains(roles, "Login") {
		roles = append(roles, "Login")
	}
	if err := p.updateKavitaUser(ctx, user, roles, user.Libraries); err != nil {
		return err
	}
	verified, err := p.inspectKavitaProvisionedUser(ctx, original.ID, original.Name)
	if err != nil {
		return err
	}
	if verified.Absent || verified.Disabled || verified.Kavita == nil || verified.Kavita.Age != user.Age {
		return ErrConflict
	}
	actualRoles, expectedRoles := slices.Clone(verified.Kavita.Roles), slices.Clone(roles)
	slices.Sort(actualRoles)
	slices.Sort(expectedRoles)
	actualLibraries, expectedLibraries := slices.Clone(verified.Kavita.Libraries), slices.Clone(user.Libraries)
	slices.Sort(actualLibraries)
	slices.Sort(expectedLibraries)
	if !slices.Equal(actualRoles, expectedRoles) || !slices.Equal(actualLibraries, expectedLibraries) {
		return ErrConflict
	}
	return nil
}

func (p *jsonProvider) enableABSUser(ctx context.Context, original remoteReview) error {
	if original.ABS == nil {
		return ErrConflict
	}
	if err := p.absRequest(ctx, http.MethodPatch, "/users/"+url.PathEscape(original.ID), struct {
		Active bool `json:"isActive"`
	}{true}, nil); err != nil {
		return err
	}
	verified, err := p.inspectABSUser(ctx, original.ID, original.Name)
	if err != nil {
		return err
	}
	if verified.Absent || verified.Disabled || verified.ABS == nil || !maps.Equal(original.ABS.Permissions, verified.ABS.Permissions) {
		return ErrConflict
	}
	for _, pair := range [][2][]string{{original.ABS.Libraries, verified.ABS.Libraries}, {original.ABS.Tags, verified.ABS.Tags}} {
		before, after := slices.Clone(pair[0]), slices.Clone(pair[1])
		slices.Sort(before)
		slices.Sort(after)
		if !slices.Equal(before, after) {
			return ErrConflict
		}
	}
	return nil
}

func (p *jsonProvider) enableRomMUser(ctx context.Context, user remoteReview) error {
	if user.RomM == nil {
		return ErrConflict
	}
	if err := p.rommForm(ctx, user.ID, url.Values{"enabled": {"true"}}); err != nil {
		return err
	}
	verified, err := p.inspectRomMUser(ctx, user.ID, user.Name)
	if err != nil {
		return err
	}
	if verified.Absent || verified.Disabled || !rommContentEqual(verified.RomM, user.RomM) {
		return ErrConflict
	}
	return nil
}
