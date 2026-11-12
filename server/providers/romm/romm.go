// Package romm is MUM's RomM module: platform and user reads with access
// resolved from permission groups and overrides, all-platform/download
// provisioning, recorded-account recovery, and flag-based disable, enable
// and remote deletion. RomM creates accounts enabled in its default group, and
// full session termination is not verified.
package romm

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"slices"
	"strconv"
	"strings"

	"app/server/providers/provider"
)

var Definition = provider.Definition{
	ID:             "romm",
	Name:           "RomM",
	Description:    "RomM sync and all-platform/download provisioning/recovery; creation starts enabled in its default group, and full session termination is not verified",
	DownloadLabels: true,
}

var errCredentials = &provider.CredentialsError{Code: "INVALID_ROMM_CREDENTIALS", Message: "RomM requires a lowercase ASCII username of 3–255 letters, digits, underscores or hyphens and a printable ASCII password of 12–72 bytes"}

// Server is one configured RomM server.
type Server struct {
	url, apiKey string
	transport   provider.Transport
}

func New(cfg provider.Config) *Server {
	return &Server{url: strings.TrimRight(cfg.URL, "/"), apiKey: cfg.APIKey, transport: cfg.Transport}
}

func (s *Server) authorize(header http.Header) { header.Set("Authorization", "Bearer "+s.apiKey) }

func (s *Server) get(ctx context.Context, endpoint string, out any) error {
	return s.transport.JSON(ctx, http.MethodGet, s.url+endpoint, s.authorize, nil, out)
}

func (s *Server) send(ctx context.Context, method, endpoint string, body, out any) error {
	return s.transport.JSON(ctx, method, s.url+endpoint, s.authorize, body, out)
}

func (s *Server) form(ctx context.Context, id string, form url.Values) error {
	if !RecordedID(id) {
		return provider.ErrConflict
	}
	return s.transport.Form(ctx, http.MethodPut, s.url+"/api/users/"+id, s.authorize, form)
}

// Account rules.

// ValidUsername accepts 3–255 lowercase ASCII letters, digits, '_' or '-'.
func ValidUsername(name string) bool {
	if len(name) < 3 || len(name) > 255 {
		return false
	}
	for _, c := range []byte(name) {
		if !(c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || c == '_' || c == '-') {
			return false
		}
	}
	return true
}

// ValidCredentials also requires a printable ASCII password of 12–72 bytes.
func ValidCredentials(name, password string) bool {
	if !ValidUsername(name) || len(password) < 12 || len(password) > 72 || strings.TrimSpace(password) == "" {
		return false
	}
	for _, c := range []byte(password) {
		if c < 32 || c > 126 {
			return false
		}
	}
	return true
}

// RecordedID reports whether id is RomM's canonical positive integer ID.
func RecordedID(id string) bool {
	n, err := strconv.ParseInt(id, 10, 64)
	return err == nil && n > 0 && strconv.FormatInt(n, 10) == id
}

// ValidGrant: RomM accounts are only provisioned with every platform and
// downloads, the access its permission model can grant exactly.
func (s *Server) ValidGrant(grant provider.Grant) bool {
	return grant.AllLibraries && len(grant.LibraryIDs) == 0 && grant.AllowDownloads
}

func (s *Server) ValidRecordedID(id string) bool    { return RecordedID(id) }
func (s *Server) ValidRemoteName(name string) bool  { return ValidUsername(name) }
func (s *Server) PasswordMaxBytes() int             { return 72 }
func (s *Server) PasswordASCIIOnly() bool           { return true }
func (s *Server) ContentRestrictionsReported() bool { return true }
func (s *Server) CheckCredentials(name, pw string) error {
	if !ValidCredentials(name, pw) {
		return errCredentials
	}
	return nil
}

// Permission policy.

var (
	PermissionEntities = []string{"platforms", "roms", "collections", "playlists", "firmware", "assets", "devices", "users", "tasks", "logs", "streaming", "emulation"}
	PermissionActions  = []string{"read", "write", "delete"}
	OwnableEntities    = []string{"collections", "playlists", "assets", "devices", "streaming", "emulation"}
)

type Grant struct {
	Entity  string `json:"entity"`
	Action  string `json:"action"`
	OwnOnly *bool  `json:"own_only"`
}
type Override struct {
	Entity  string `json:"entity"`
	Action  string `json:"action"`
	Granted *bool  `json:"granted"`
	OwnOnly *bool  `json:"own_only"`
}
type Hidden struct {
	Entity string `json:"entity"`
	ID     *int64 `json:"entity_id"`
}
type PermissionGroup struct {
	ID          *int64    `json:"id"`
	Default     *bool     `json:"is_default"`
	Grants      *[]Grant  `json:"grants"`
	Hidden      *[]Hidden `json:"hidden"`
	Age         *int      `json:"age_limit"`
	HideUnrated *bool     `json:"hide_unrated_roms"`
}
type UserPermissions struct {
	UserID      *int64      `json:"user_id"`
	GroupID     *int64      `json:"permission_group_id"`
	Overrides   *[]Override `json:"overrides"`
	Hidden      *[]Hidden   `json:"hidden"`
	Age         *int        `json:"age_limit"`
	HideUnrated *bool       `json:"hide_unrated_roms"`
}
type UserSnapshot struct {
	ID      *int64 `json:"id"`
	Name    string `json:"username"`
	Email   string `json:"email"`
	Enabled *bool  `json:"enabled"`
	Role    string `json:"role"`
	GroupID *int64 `json:"permission_group_id"`
}

// requiredFields: nullable policy fields must still be present. An omitted
// membership must not silently inherit a more permissive default group.
func requiredFields(data []byte, names ...string) bool {
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

func (u *UserSnapshot) UnmarshalJSON(data []byte) error {
	type snapshot UserSnapshot
	var value snapshot
	if !requiredFields(data, "permission_group_id") {
		return provider.ErrConflict
	}
	if err := json.Unmarshal(data, &value); err != nil {
		return err
	}
	*u = UserSnapshot(value)
	return nil
}
func (g *PermissionGroup) UnmarshalJSON(data []byte) error {
	type group PermissionGroup
	var value group
	if !requiredFields(data, "age_limit") {
		return provider.ErrConflict
	}
	if err := json.Unmarshal(data, &value); err != nil {
		return err
	}
	*g = PermissionGroup(value)
	return nil
}
func (p *UserPermissions) UnmarshalJSON(data []byte) error {
	type policy UserPermissions
	var value policy
	if !requiredFields(data, "permission_group_id", "age_limit", "hide_unrated_roms") {
		return provider.ErrConflict
	}
	if err := json.Unmarshal(data, &value); err != nil {
		return err
	}
	*p = UserPermissions(value)
	return nil
}

func sameVocabulary(actual, expected []string) bool {
	a := slices.Clone(actual)
	b := slices.Clone(expected)
	slices.Sort(a)
	slices.Sort(b)
	return slices.Equal(a, b)
}
func validGrant(entity, action string, ownOnly bool) bool {
	return slices.Contains(PermissionEntities, entity) && slices.Contains(PermissionActions, action) && (!ownOnly || slices.Contains(OwnableEntities, entity))
}
func ageValid(age *int) bool { return age == nil || *age >= 0 && *age <= 21 }
func groupIDEqual(first, second *int64) bool {
	return first == nil && second == nil || first != nil && second != nil && *first == *second
}

// Reads.

func (s *Server) Libraries(ctx context.Context) ([]provider.Library, error) {
	var rows []struct {
		ID    *int64 `json:"id"`
		Name  string `json:"name"`
		Count *int64 `json:"rom_count"`
	}
	if err := s.get(ctx, "/api/platforms", &rows); err != nil {
		return nil, err
	}
	if rows == nil {
		return nil, errors.New("missing RomM platform array")
	}
	result := []provider.Library{}
	for _, l := range rows {
		if l.ID == nil {
			return nil, errors.New("missing RomM platform ID")
		}
		result = append(result, provider.Library{ID: strconv.FormatInt(*l.ID, 10), Name: l.Name, Type: "rom", ItemCount: l.Count})
	}
	return result, nil
}

func (s *Server) Users(ctx context.Context) ([]provider.User, error) {
	platforms, err := s.Libraries(ctx)
	if err != nil {
		return nil, err
	}
	if err := provider.CheckLibraries(platforms); err != nil {
		return nil, err
	}
	return s.UsersWithLibraries(ctx, platforms)
}

// UsersWithLibraries resolves each user's platform and download access from
// their group grants, overrides and hidden entries, given platforms the caller
// has just read. It performs GET requests only, so MUM can read a complete
// bounded snapshot before starting its writer transaction. Library and
// download policy come from grants, never from a role name.
func (s *Server) UsersWithLibraries(ctx context.Context, platforms []provider.Library) ([]provider.User, error) {
	var users []UserSnapshot
	if err := s.get(ctx, "/api/users", &users); err != nil {
		return nil, err
	}
	if users == nil || len(users) > 100 {
		return nil, provider.ErrConflict
	}
	result := []provider.User{}
	if len(users) == 0 {
		return result, nil
	}
	seen := map[int64]bool{}
	for _, user := range users {
		if user.ID == nil || *user.ID < 1 || seen[*user.ID] || user.Name == "" || user.Enabled == nil || (user.Role != "user" && user.Role != "admin") || user.GroupID != nil && *user.GroupID < 1 {
			return nil, provider.ErrConflict
		}
		seen[*user.ID] = true
	}
	byGroup, defaultID, err := s.readGroups(ctx)
	if err != nil {
		return nil, err
	}
	platformIDs := []string{}
	seenPlatforms := map[int64]bool{}
	for _, platform := range platforms {
		id, err := strconv.ParseInt(platform.ID, 10, 64)
		if err != nil || id < 1 || strconv.FormatInt(id, 10) != platform.ID || seenPlatforms[id] {
			return nil, provider.ErrConflict
		}
		seenPlatforms[id] = true
		platformIDs = append(platformIDs, platform.ID)
	}
	for _, user := range users {
		if user.Role == "admin" {
			result = append(result, provider.User{ID: strconv.FormatInt(*user.ID, 10), Name: user.Name, Email: user.Email, Active: *user.Enabled, AllLibraries: true, LibraryIDs: []string{}, Access: &provider.UserAccess{LibrariesKnown: true, DownloadsKnown: true, AllowDownloads: true}})
			continue
		}
		var policy UserPermissions
		if err := s.get(ctx, "/api/permissions/users/"+strconv.FormatInt(*user.ID, 10), &policy); err != nil {
			return nil, err
		}
		if policy.UserID == nil || *policy.UserID != *user.ID || !groupIDEqual(policy.GroupID, user.GroupID) || policy.Overrides == nil || policy.Hidden == nil || !ageValid(policy.Age) {
			return nil, provider.ErrConflict
		}
		groupID := defaultID
		if policy.GroupID != nil {
			groupID = *policy.GroupID
		}
		group, ok := byGroup[groupID]
		if !ok {
			return nil, provider.ErrConflict
		}
		grants := map[string]bool{}
		for _, grant := range *group.Grants {
			if grant.OwnOnly == nil || !validGrant(grant.Entity, grant.Action, *grant.OwnOnly) {
				return nil, provider.ErrConflict
			}
			key := grant.Entity + "." + grant.Action
			if _, duplicate := grants[key]; duplicate {
				return nil, provider.ErrConflict
			}
			grants[key] = true
		}
		seenOverrides := map[string]bool{}
		for _, override := range *policy.Overrides {
			if override.Granted == nil || override.OwnOnly == nil || !validGrant(override.Entity, override.Action, *override.Granted && *override.OwnOnly) {
				return nil, provider.ErrConflict
			}
			key := override.Entity + "." + override.Action
			if seenOverrides[key] {
				return nil, provider.ErrConflict
			}
			seenOverrides[key] = true
			grants[key] = *override.Granted
		}
		hiddenPlatforms := map[int64]bool{}
		contentRestricted := false
		for _, hiddenList := range [][]Hidden{*group.Hidden, *policy.Hidden} {
			seenHidden := map[string]bool{}
			for _, hidden := range hiddenList {
				if hidden.ID == nil || *hidden.ID < 1 || (hidden.Entity != "platforms" && hidden.Entity != "roms") {
					return nil, provider.ErrConflict
				}
				key := hidden.Entity + "." + strconv.FormatInt(*hidden.ID, 10)
				if seenHidden[key] {
					return nil, provider.ErrConflict
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
		result = append(result, provider.User{ID: strconv.FormatInt(*user.ID, 10), Name: user.Name, Email: user.Email, Active: *user.Enabled, AllLibraries: all, LibraryIDs: allowed, Access: &provider.UserAccess{LibrariesKnown: true, DownloadsKnown: true, AllowDownloads: grants["roms.read"], ContentRestricted: contentRestricted}})
	}
	return result, nil
}

// readGroups verifies the permission vocabulary (even on an empty server, as
// writes depend on it) and returns the groups by ID and the default group ID.
func (s *Server) readGroups(ctx context.Context) (map[int64]PermissionGroup, int64, error) {
	var catalog struct {
		Entities []string `json:"entities"`
		Actions  []string `json:"actions"`
		Ownable  []string `json:"ownable_entities"`
	}
	if err := s.get(ctx, "/api/permissions/catalog", &catalog); err != nil {
		return nil, 0, err
	}
	if !sameVocabulary(catalog.Entities, PermissionEntities) || !sameVocabulary(catalog.Actions, PermissionActions) || !sameVocabulary(catalog.Ownable, OwnableEntities) {
		return nil, 0, provider.ErrConflict
	}
	var groups []PermissionGroup
	if err := s.get(ctx, "/api/permissions/groups", &groups); err != nil {
		return nil, 0, err
	}
	if groups == nil || len(groups) > 1000 {
		return nil, 0, provider.ErrConflict
	}
	byGroup := map[int64]PermissionGroup{}
	var defaultID int64
	for _, group := range groups {
		if group.ID == nil || *group.ID < 1 || group.Default == nil || group.Grants == nil || group.Hidden == nil || group.HideUnrated == nil || !ageValid(group.Age) {
			return nil, 0, provider.ErrConflict
		}
		if _, duplicate := byGroup[*group.ID]; duplicate {
			return nil, 0, provider.ErrConflict
		}
		byGroup[*group.ID] = group
		if *group.Default {
			if defaultID != 0 {
				return nil, 0, provider.ErrConflict
			}
			defaultID = *group.ID
		}
	}
	return byGroup, defaultID, nil
}
