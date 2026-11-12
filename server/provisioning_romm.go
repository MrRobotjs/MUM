package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"strconv"
	"strings"
)

var errRomMCredentials = errors.New("RomM requires a lowercase ASCII username of 3–255 letters, digits, underscores or hyphens and a printable ASCII password of 12–72 bytes")

func validRomMUsername(name string) bool {
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
func validRomMCredentials(name, password string) bool {
	if !validRomMUsername(name) || len(password) < 12 || len(password) > 72 || strings.TrimSpace(password) == "" {
		return false
	}
	for _, c := range []byte(password) {
		if c < 32 || c > 126 {
			return false
		}
	}
	return true
}
func validRomMInvitationGrant(grant InvitationGrant) bool {
	return grant.AllLibraries && len(grant.LibraryIDs) == 0 && grant.AllowDownloads
}
func rommRecordedID(id string) bool {
	n, err := strconv.ParseInt(id, 10, 64)
	return err == nil && n > 0 && strconv.FormatInt(n, 10) == id
}

type rommReviewUser struct {
	User   rommUserSnapshot
	Policy rommUserPermissions
	Group  rommPermissionGroup
}

// Decode the complete identity and provenance fields from the same row.
func (p *jsonProvider) rommIdentity(ctx context.Context, id, name string) (rommUserSnapshot, bool, error) {
	var users []json.RawMessage
	if err := p.localJSON(ctx, "/api/users", &users); err != nil {
		return rommUserSnapshot{}, false, err
	}
	if users == nil || len(users) > 100 {
		return rommUserSnapshot{}, false, ErrConflict
	}
	seen := map[int64]bool{}
	var found rommUserSnapshot
	exists := false
	for _, raw := range users {
		var u rommUserSnapshot
		if err := json.Unmarshal(raw, &u); err != nil {
			return found, false, ErrConflict
		}
		if u.ID == nil || *u.ID < 1 || seen[*u.ID] || u.Name == "" || u.Enabled == nil || (u.Role != "user" && u.Role != "admin") {
			return found, false, ErrConflict
		}
		seen[*u.ID] = true
		if strconv.FormatInt(*u.ID, 10) != id {
			continue
		}
		var auth struct {
			HasPassword *bool `json:"has_password"`
			OIDCEmail   *bool `json:"email_managed_by_oidc"`
		}
		if json.Unmarshal(raw, &auth) != nil || u.Name != name || u.Role != "user" || auth.HasPassword == nil || !*auth.HasPassword || auth.OIDCEmail == nil || *auth.OIDCEmail {
			return found, false, ErrConflict
		}
		found = u
		exists = true
	}
	return found, exists, nil
}
func (p *jsonProvider) inspectRomMUser(ctx context.Context, id, name string) (remoteReview, error) {
	if p.config.Type != "romm" || !rommRecordedID(id) || !validRomMUsername(name) {
		return remoteReview{}, ErrConflict
	}
	groups, defaultID, err := p.readRomMGroups(ctx)
	if err != nil {
		return remoteReview{}, err
	}
	// Validate the complete read contract as well as the exact recorded identity.
	// A failed or partial endpoint must never establish absence or restricted access.
	if _, err := p.readRomMUsers(ctx); err != nil {
		return remoteReview{}, err
	}
	user, exists, err := p.rommIdentity(ctx, id, name)
	if err != nil {
		return remoteReview{}, err
	}
	if !exists {
		return remoteReview{ID: id, Name: name, Absent: true}, nil
	}
	var policy rommUserPermissions
	if err := p.localJSON(ctx, "/api/permissions/users/"+id, &policy); err != nil {
		return remoteReview{}, err
	}
	if policy.UserID == nil || strconv.FormatInt(*policy.UserID, 10) != id || !rommGroupIDEqual(user.GroupID, policy.GroupID) || policy.Overrides == nil || policy.Hidden == nil || !rommAgeValid(policy.Age) {
		return remoteReview{}, ErrConflict
	}
	groupID := defaultID
	if user.GroupID != nil {
		groupID = *user.GroupID
	}
	group, ok := groups[groupID]
	if !ok || !rommReviewPolicyValid(policy, group) {
		return remoteReview{}, ErrConflict
	}
	observed := rommReviewUser{user, policy, group}
	return remoteReview{ID: id, Name: name, RomM: &observed, Disabled: !*user.Enabled}, nil
}

// These are separate upstream reads. Validate the exact final policy too,
// rather than relying on the earlier synchronization read to validate it.
func rommReviewPolicyValid(policy rommUserPermissions, group rommPermissionGroup) bool {
	if policy.Overrides == nil || policy.Hidden == nil || group.Grants == nil || group.Hidden == nil {
		return false
	}
	grants := map[string]bool{}
	for _, g := range *group.Grants {
		key := g.Entity + "." + g.Action
		if grants[key] || g.OwnOnly == nil || !validRomMGrant(g.Entity, g.Action, *g.OwnOnly) {
			return false
		}
		grants[key] = true
	}
	overrides := map[string]bool{}
	for _, o := range *policy.Overrides {
		key := o.Entity + "." + o.Action
		if overrides[key] || o.Granted == nil || o.OwnOnly == nil || !validRomMGrant(o.Entity, o.Action, *o.Granted && *o.OwnOnly) {
			return false
		}
		overrides[key] = true
	}
	for _, list := range [][]rommHidden{*policy.Hidden, *group.Hidden} {
		seen := map[string]bool{}
		for _, h := range list {
			if h.ID == nil || *h.ID < 1 || (h.Entity != "platforms" && h.Entity != "roms") {
				return false
			}
			key := h.Entity + "." + strconv.FormatInt(*h.ID, 10)
			if seen[key] {
				return false
			}
			seen[key] = true
		}
	}
	return true
}

// Override every known entity/action. Group grants cannot accidentally add
// editing, administration, firmware, streaming or emulation capabilities.
// RomM still grants its unconditional self-service scopes to ordinary users.
func rommOverrides(read bool) []rommOverride {
	result := []rommOverride{}
	for _, entity := range rommPermissionEntities {
		for _, action := range rommPermissionActions {
			granted := read && action == "read" && (entity == "roms" || entity == "platforms")
			own := false
			result = append(result, rommOverride{entity, action, &granted, &own})
		}
	}
	return result
}
func rommOverridesMatch(actual []rommOverride, read bool) bool {
	expected := rommOverrides(read)
	if len(actual) != len(expected) {
		return false
	}
	seen := map[string]bool{}
	for _, o := range actual {
		key := o.Entity + "." + o.Action
		if seen[key] || o.Granted == nil || o.OwnOnly == nil || *o.OwnOnly || !validRomMGrant(o.Entity, o.Action, false) {
			return false
		}
		seen[key] = true
		wanted := read && o.Action == "read" && (o.Entity == "roms" || o.Entity == "platforms")
		if *o.Granted != wanted {
			return false
		}
	}
	return true
}
func rommContentEqual(a, b *rommReviewUser) bool {
	if a == nil || b == nil || !rommGroupIDEqual(a.User.GroupID, b.User.GroupID) || a.Group.ID == nil || b.Group.ID == nil || *a.Group.ID != *b.Group.ID {
		return false
	}
	equalAge := func(x, y *int) bool { return x == nil && y == nil || x != nil && y != nil && *x == *y }
	equalBool := func(x, y *bool) bool { return x == nil && y == nil || x != nil && y != nil && *x == *y }
	if !equalAge(a.Policy.Age, b.Policy.Age) || !equalAge(a.Group.Age, b.Group.Age) || !equalBool(a.Policy.HideUnrated, b.Policy.HideUnrated) || !equalBool(a.Group.HideUnrated, b.Group.HideUnrated) {
		return false
	}
	for _, pair := range [][2]*[]rommHidden{{a.Policy.Hidden, b.Policy.Hidden}, {a.Group.Hidden, b.Group.Hidden}} {
		if pair[0] == nil || pair[1] == nil || len(*pair[0]) != len(*pair[1]) {
			return false
		}
		values := map[string]bool{}
		for _, h := range *pair[0] {
			if h.ID == nil {
				return false
			}
			key := h.Entity + "." + strconv.FormatInt(*h.ID, 10)
			if values[key] {
				return false
			}
			values[key] = true
		}
		for _, h := range *pair[1] {
			if h.ID == nil {
				return false
			}
			key := h.Entity + "." + strconv.FormatInt(*h.ID, 10)
			if !values[key] {
				return false
			}
			delete(values, key)
		}
	}
	return true
}
func rommUnrestrictedContent(u *rommReviewUser) bool {
	return u != nil && u.Policy.Hidden != nil && len(*u.Policy.Hidden) == 0 && u.Group.Hidden != nil && len(*u.Group.Hidden) == 0 && u.Policy.Age == nil && u.Group.Age == nil && u.Policy.HideUnrated == nil && u.Group.HideUnrated != nil && !*u.Group.HideUnrated
}
func rommWriteMatches(u remoteReview, read, enabled bool, original *rommReviewUser) bool {
	return !u.Absent && u.RomM != nil && *u.RomM.User.Enabled == enabled && rommOverridesMatch(*u.RomM.Policy.Overrides, read) && rommContentEqual(u.RomM, original)
}
func (p *jsonProvider) rommForm(ctx context.Context, id string, form url.Values) error {
	if p.config.Type != "romm" || !rommRecordedID(id) {
		return ErrConflict
	}
	return p.jsonRequest(ctx, http.MethodPut, strings.TrimRight(p.config.URL, "/")+"/api/users/"+id, form, nil)
}
func (p *jsonProvider) writeRomMOverrides(ctx context.Context, id string, read bool) error {
	if p.config.Type != "romm" || !rommRecordedID(id) {
		return ErrConflict
	}
	body := struct {
		Overrides []rommOverride `json:"overrides"`
	}{rommOverrides(read)}
	return p.jsonRequest(ctx, http.MethodPut, strings.TrimRight(p.config.URL, "/")+"/api/permissions/users/"+id, body, nil)
}
func (p *jsonProvider) disableRomMUser(ctx context.Context, user remoteReview) error {
	if user.RomM == nil {
		return ErrConflict
	}
	if err := p.rommForm(ctx, user.ID, url.Values{"enabled": {"false"}}); err != nil {
		return err
	}
	verified, err := p.inspectRomMUser(ctx, user.ID, user.Name)
	if err != nil {
		return err
	}
	if verified.Absent || !verified.Disabled || !rommContentEqual(verified.RomM, user.RomM) {
		return ErrConflict
	}
	return nil
}

// The invitation layer validates explicit all-platform/download grants and
// credentials before reserving work; checkpoint callbacks persist authority guards.
func (p *jsonProvider) provisionRomMUser(ctx context.Context, name, password string, grant InvitationGrant, checkpoint func(string, string) error) error {
	if p.config.Type != "romm" || !validRomMInvitationGrant(grant) {
		return ErrConflict
	}
	if !validRomMCredentials(name, password) {
		return errRomMCredentials
	}
	groups, defaultID, err := p.readRomMGroups(ctx)
	if err != nil {
		return err
	}
	group, ok := groups[defaultID]
	if !ok || group.Hidden == nil || len(*group.Hidden) != 0 || group.Age != nil || group.HideUnrated == nil || *group.HideUnrated {
		return ErrConflict
	}
	users, err := p.readRomMUsers(ctx)
	if err != nil {
		return err
	}
	for _, user := range users {
		if strings.EqualFold(user.Name, name) {
			return ErrConflict
		}
	}
	if err := checkpoint("creating", ""); err != nil {
		return err
	}
	var created struct {
		ID *int64 `json:"id"`
	}
	body := struct {
		Username string `json:"username"`
		Email    string `json:"email"`
		Password string `json:"password"`
		Role     string `json:"role"`
	}{name, "", randomToken(), "user"}
	// Explicit lowercase JSON keys; the RomM create schema does not accept a
	// disable flag or group/permission fields.
	if err := p.jsonRequest(ctx, http.MethodPost, strings.TrimRight(p.config.URL, "/")+"/api/users", body, &created); err != nil {
		return err
	}
	if created.ID == nil || *created.ID < 1 {
		return ErrConflict
	}
	id := strconv.FormatInt(*created.ID, 10)
	if err := checkpoint("configuring", id); err != nil {
		return err
	}
	user, err := p.inspectRomMUser(ctx, id, name)
	if err != nil {
		return err
	}
	if user.Absent || !rommUnrestrictedContent(user.RomM) {
		return ErrConflict
	}
	return p.configureRomMUser(ctx, user, password, func(stage string) error { return checkpoint(stage, id) })
}
func (p *jsonProvider) configureRomMUser(ctx context.Context, user remoteReview, password string, checkpoint func(string) error) error {
	if user.RomM == nil || !validRomMCredentials(user.Name, password) {
		return ErrConflict
	}
	original := user.RomM
	if err := checkpoint("configuring"); err != nil {
		return err
	}
	if err := p.disableRomMUser(ctx, user); err != nil {
		return err
	}
	if err := checkpoint("configuring"); err != nil {
		return err
	}
	if err := p.writeRomMOverrides(ctx, user.ID, false); err != nil {
		return err
	}
	current, err := p.inspectRomMUser(ctx, user.ID, user.Name)
	if err != nil {
		return err
	}
	if !rommWriteMatches(current, false, false, original) {
		return ErrConflict
	}
	if err := checkpoint("setting_password"); err != nil {
		return err
	}
	if err := p.rommForm(ctx, user.ID, url.Values{"password": {password}}); err != nil {
		return err
	}
	if err := checkpoint("configuring"); err != nil {
		return err
	}
	current, err = p.inspectRomMUser(ctx, user.ID, user.Name)
	if err != nil {
		return err
	}
	if !rommWriteMatches(current, false, false, original) {
		return ErrConflict
	}
	if err := p.writeRomMOverrides(ctx, user.ID, true); err != nil {
		return err
	}
	current, err = p.inspectRomMUser(ctx, user.ID, user.Name)
	if err != nil {
		return err
	}
	if !rommWriteMatches(current, true, false, original) {
		return ErrConflict
	}
	if err := checkpoint("enabling"); err != nil {
		return err
	}
	current, err = p.inspectRomMUser(ctx, user.ID, user.Name)
	if err != nil {
		return err
	}
	if !rommWriteMatches(current, true, false, original) {
		return ErrConflict
	}
	if err := p.rommForm(ctx, user.ID, url.Values{"enabled": {"true"}}); err != nil {
		return err
	}
	verified, err := p.inspectRomMUser(ctx, user.ID, user.Name)
	if err != nil {
		return err
	}
	if !rommWriteMatches(verified, true, true, original) {
		return ErrConflict
	}
	return checkpoint("remote_completed")
}
