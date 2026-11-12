package main

import (
	"context"
	"encoding/json"
	"slices"
	"strconv"
)

var rommPermissionEntities = []string{"platforms", "roms", "collections", "playlists", "firmware", "assets", "devices", "users", "tasks", "logs", "streaming", "emulation"}
var rommPermissionActions = []string{"read", "write", "delete"}
var rommOwnableEntities = []string{"collections", "playlists", "assets", "devices", "streaming", "emulation"}

type rommGrant struct {
	Entity  string `json:"entity"`
	Action  string `json:"action"`
	OwnOnly *bool  `json:"own_only"`
}
type rommOverride struct {
	Entity  string `json:"entity"`
	Action  string `json:"action"`
	Granted *bool  `json:"granted"`
	OwnOnly *bool  `json:"own_only"`
}
type rommHidden struct {
	Entity string `json:"entity"`
	ID     *int64 `json:"entity_id"`
}
type rommPermissionGroup struct {
	ID          *int64        `json:"id"`
	Default     *bool         `json:"is_default"`
	Grants      *[]rommGrant  `json:"grants"`
	Hidden      *[]rommHidden `json:"hidden"`
	Age         *int          `json:"age_limit"`
	HideUnrated *bool         `json:"hide_unrated_roms"`
}
type rommUserPermissions struct {
	UserID      *int64          `json:"user_id"`
	GroupID     *int64          `json:"permission_group_id"`
	Overrides   *[]rommOverride `json:"overrides"`
	Hidden      *[]rommHidden   `json:"hidden"`
	Age         *int            `json:"age_limit"`
	HideUnrated *bool           `json:"hide_unrated_roms"`
}

// Nullable policy fields must still be present. An omitted membership must not
// accidentally inherit a more permissive default group.
func rommRequiredFields(data []byte, names ...string) bool {
	var fields map[string]json.RawMessage
	if json.Unmarshal(data, &fields) != nil {
		return false
	}
	for _, name := range names {
		if _, ok := fields[name]; !ok {
			return false
		}
	}
	return true
}

type rommUserSnapshot struct {
	ID      *int64 `json:"id"`
	Name    string `json:"username"`
	Email   string `json:"email"`
	Enabled *bool  `json:"enabled"`
	Role    string `json:"role"`
	GroupID *int64 `json:"permission_group_id"`
}

func (u *rommUserSnapshot) UnmarshalJSON(data []byte) error {
	type snapshot rommUserSnapshot
	var value snapshot
	if !rommRequiredFields(data, "permission_group_id") {
		return ErrConflict
	}
	if err := json.Unmarshal(data, &value); err != nil {
		return err
	}
	*u = rommUserSnapshot(value)
	return nil
}
func (g *rommPermissionGroup) UnmarshalJSON(data []byte) error {
	type group rommPermissionGroup
	var value group
	if !rommRequiredFields(data, "age_limit") {
		return ErrConflict
	}
	if err := json.Unmarshal(data, &value); err != nil {
		return err
	}
	*g = rommPermissionGroup(value)
	return nil
}
func (p *rommUserPermissions) UnmarshalJSON(data []byte) error {
	type policy rommUserPermissions
	var value policy
	if !rommRequiredFields(data, "permission_group_id", "age_limit", "hide_unrated_roms") {
		return ErrConflict
	}
	if err := json.Unmarshal(data, &value); err != nil {
		return err
	}
	*p = rommUserPermissions(value)
	return nil
}

func rommSameVocabulary(actual, expected []string) bool {
	a := slices.Clone(actual)
	b := slices.Clone(expected)
	slices.Sort(a)
	slices.Sort(b)
	return slices.Equal(a, b)
}
func validRomMGrant(entity, action string, ownOnly bool) bool {
	return slices.Contains(rommPermissionEntities, entity) && slices.Contains(rommPermissionActions, action) && (!ownOnly || slices.Contains(rommOwnableEntities, entity))
}
func rommAgeValid(age *int) bool { return age == nil || *age >= 0 && *age <= 21 }
func rommGroupIDEqual(first, second *int64) bool {
	return first == nil && second == nil || first != nil && second != nil && *first == *second
}

func (p *jsonProvider) readRomMUsers(ctx context.Context) ([]ProviderUser, error) {
	platforms, err := p.Libraries(ctx)
	if err != nil {
		return nil, err
	}
	return p.resolveRomMUsers(ctx, platforms)
}

// Fetch a complete bounded snapshot before the caller starts its writer
// transaction. Library/download policy is read from grants, never from a role
// name or account existence. This function performs GET requests only.
func (p *jsonProvider) resolveRomMUsers(ctx context.Context, platforms []ProviderLibrary) ([]ProviderUser, error) {
	var users []rommUserSnapshot
	if err := p.localJSON(ctx, "/api/users", &users); err != nil {
		return nil, err
	}
	if users == nil || len(users) > 100 {
		return nil, ErrConflict
	}
	result := []ProviderUser{}
	if len(users) == 0 {
		return result, nil
	}
	seen := map[int64]bool{}
	for _, user := range users {
		if user.ID == nil || *user.ID < 1 || seen[*user.ID] || user.Name == "" || user.Enabled == nil || (user.Role != "user" && user.Role != "admin") || user.GroupID != nil && *user.GroupID < 1 {
			return nil, ErrConflict
		}
		seen[*user.ID] = true
	}
	byGroup, defaultID, err := p.readRomMGroups(ctx)
	if err != nil {
		return nil, err
	}
	platformIDs := []string{}
	seenPlatforms := map[int64]bool{}
	for _, platform := range platforms {
		id, err := strconv.ParseInt(platform.ID, 10, 64)
		if err != nil || id < 1 || strconv.FormatInt(id, 10) != platform.ID || seenPlatforms[id] {
			return nil, ErrConflict
		}
		seenPlatforms[id] = true
		platformIDs = append(platformIDs, platform.ID)
	}
	for _, user := range users {
		if user.Role == "admin" {
			result = append(result, ProviderUser{ID: strconv.FormatInt(*user.ID, 10), Name: user.Name, Email: user.Email, Active: *user.Enabled, AllLibraries: true, LibraryIDs: []string{}, Access: &ProviderUserAccess{LibrariesKnown: true, DownloadsKnown: true, AllowDownloads: true}})
			continue
		}
		var policy rommUserPermissions
		if err := p.localJSON(ctx, "/api/permissions/users/"+strconv.FormatInt(*user.ID, 10), &policy); err != nil {
			return nil, err
		}
		if policy.UserID == nil || *policy.UserID != *user.ID || !rommGroupIDEqual(policy.GroupID, user.GroupID) || policy.Overrides == nil || policy.Hidden == nil || !rommAgeValid(policy.Age) {
			return nil, ErrConflict
		}
		groupID := defaultID
		if policy.GroupID != nil {
			groupID = *policy.GroupID
		}
		group, ok := byGroup[groupID]
		if !ok {
			return nil, ErrConflict
		}
		grants := map[string]bool{}
		for _, grant := range *group.Grants {
			if grant.OwnOnly == nil || !validRomMGrant(grant.Entity, grant.Action, *grant.OwnOnly) {
				return nil, ErrConflict
			}
			key := grant.Entity + "." + grant.Action
			if _, duplicate := grants[key]; duplicate {
				return nil, ErrConflict
			}
			grants[key] = true
		}
		seenOverrides := map[string]bool{}
		for _, override := range *policy.Overrides {
			if override.Granted == nil || override.OwnOnly == nil || !validRomMGrant(override.Entity, override.Action, *override.Granted && *override.OwnOnly) {
				return nil, ErrConflict
			}
			key := override.Entity + "." + override.Action
			if seenOverrides[key] {
				return nil, ErrConflict
			}
			seenOverrides[key] = true
			grants[key] = *override.Granted
		}
		hiddenPlatforms := map[int64]bool{}
		contentRestricted := false
		for _, hiddenList := range [][]rommHidden{*group.Hidden, *policy.Hidden} {
			seenHidden := map[string]bool{}
			for _, hidden := range hiddenList {
				if hidden.ID == nil || *hidden.ID < 1 || (hidden.Entity != "platforms" && hidden.Entity != "roms") {
					return nil, ErrConflict
				}
				key := hidden.Entity + "." + strconv.FormatInt(*hidden.ID, 10)
				if seenHidden[key] {
					return nil, ErrConflict
				}
				seenHidden[key] = true
				if hidden.Entity == "platforms" {
					hiddenPlatforms[*hidden.ID] = true
				}
				contentRestricted = true
			}
		}
		age := group.Age
		if policy.Age != nil {
			age = policy.Age
		}
		hideUnrated := *group.HideUnrated
		if policy.HideUnrated != nil {
			hideUnrated = *policy.HideUnrated
		}
		contentRestricted = contentRestricted || age != nil || hideUnrated
		allowed := []string{}
		all := grants["roms.read"] && len(hiddenPlatforms) == 0
		if grants["roms.read"] && !all {
			for _, id := range platformIDs {
				parsed, _ := strconv.ParseInt(id, 10, 64)
				if !hiddenPlatforms[parsed] {
					allowed = append(allowed, id)
				}
			}
		}
		result = append(result, ProviderUser{ID: strconv.FormatInt(*user.ID, 10), Name: user.Name, Email: user.Email, Active: *user.Enabled, AllLibraries: all, LibraryIDs: allowed, Access: &ProviderUserAccess{LibrariesKnown: true, DownloadsKnown: true, AllowDownloads: grants["roms.read"], ContentRestricted: contentRestricted}})
	}
	return validateUsers(result)
}

// The write adapter must verify the permission vocabulary even on an empty server.
func (p *jsonProvider) readRomMGroups(ctx context.Context) (map[int64]rommPermissionGroup, int64, error) {
	var catalog struct {
		Entities []string `json:"entities"`
		Actions  []string `json:"actions"`
		Ownable  []string `json:"ownable_entities"`
	}
	if err := p.localJSON(ctx, "/api/permissions/catalog", &catalog); err != nil {
		return nil, 0, err
	}
	if !rommSameVocabulary(catalog.Entities, rommPermissionEntities) || !rommSameVocabulary(catalog.Actions, rommPermissionActions) || !rommSameVocabulary(catalog.Ownable, rommOwnableEntities) {
		return nil, 0, ErrConflict
	}
	var groups []rommPermissionGroup
	if err := p.localJSON(ctx, "/api/permissions/groups", &groups); err != nil {
		return nil, 0, err
	}
	if groups == nil || len(groups) > 1000 {
		return nil, 0, ErrConflict
	}
	byGroup := map[int64]rommPermissionGroup{}
	var defaultID int64
	for _, group := range groups {
		if group.ID == nil || *group.ID < 1 || group.Default == nil || group.Grants == nil || group.Hidden == nil || group.HideUnrated == nil || !rommAgeValid(group.Age) {
			return nil, 0, ErrConflict
		}
		if _, duplicate := byGroup[*group.ID]; duplicate {
			return nil, 0, ErrConflict
		}
		byGroup[*group.ID] = group
		if *group.Default {
			if defaultID != 0 {
				return nil, 0, ErrConflict
			}
			defaultID = *group.ID
		}
	}
	return byGroup, defaultID, nil
}
