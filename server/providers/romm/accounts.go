package romm

import (
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	"app/server/providers/provider"
)

// Observed is a RomM account's observed user row, permission policy and
// group; it is the Detail of the provider.Account this module returns.
type Observed struct {
	User   UserSnapshot
	Policy UserPermissions
	Group  PermissionGroup
}

func observed(a provider.Account) *Observed {
	o, _ := a.Detail.(*Observed)
	return o
}

// identity decodes the complete identity and provenance fields from the same
// row as the recorded ID.
func (s *Server) identity(ctx context.Context, id, name string) (UserSnapshot, bool, error) {
	var users []json.RawMessage
	if err := s.get(ctx, "/api/users", &users); err != nil {
		return UserSnapshot{}, false, err
	}
	if users == nil || len(users) > 100 {
		return UserSnapshot{}, false, provider.ErrConflict
	}
	seen := map[int64]bool{}
	var found UserSnapshot
	exists := false
	for _, raw := range users {
		var u UserSnapshot
		if err := json.Unmarshal(raw, &u); err != nil {
			return found, false, provider.ErrConflict
		}
		if u.ID == nil || *u.ID < 1 || seen[*u.ID] || u.Name == "" || u.Enabled == nil || (u.Role != "user" && u.Role != "admin") {
			return found, false, provider.ErrConflict
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
			return found, false, provider.ErrConflict
		}
		found = u
		exists = true
	}
	return found, exists, nil
}

// InspectAccount reads the recorded account with its policy and group. The
// complete user read contract is validated too: a failed or partial endpoint
// must never establish absence or restricted access.
func (s *Server) InspectAccount(ctx context.Context, id, name string) (provider.Account, error) {
	if !RecordedID(id) || !ValidUsername(name) {
		return provider.Account{}, provider.ErrConflict
	}
	groups, defaultID, err := s.readGroups(ctx)
	if err != nil {
		return provider.Account{}, err
	}
	if _, err := s.Users(ctx); err != nil {
		return provider.Account{}, err
	}
	user, exists, err := s.identity(ctx, id, name)
	if err != nil {
		return provider.Account{}, err
	}
	if !exists {
		return provider.Account{ID: id, Name: name, Absent: true}, nil
	}
	var policy UserPermissions
	if err := s.get(ctx, "/api/permissions/users/"+id, &policy); err != nil {
		return provider.Account{}, err
	}
	if policy.UserID == nil || strconv.FormatInt(*policy.UserID, 10) != id || !groupIDEqual(user.GroupID, policy.GroupID) || policy.Overrides == nil || policy.Hidden == nil || !ageValid(policy.Age) {
		return provider.Account{}, provider.ErrConflict
	}
	groupID := defaultID
	if user.GroupID != nil {
		groupID = *user.GroupID
	}
	group, ok := groups[groupID]
	if !ok || !reviewPolicyValid(policy, group) {
		return provider.Account{}, provider.ErrConflict
	}
	return provider.Account{ID: id, Name: name, Detail: &Observed{user, policy, group}, Disabled: !*user.Enabled}, nil
}

// reviewPolicyValid validates the exact final policy: these are separate
// upstream reads from the synchronization read.
func reviewPolicyValid(policy UserPermissions, group PermissionGroup) bool {
	if policy.Overrides == nil || policy.Hidden == nil || group.Grants == nil || group.Hidden == nil {
		return false
	}
	grants := map[string]bool{}
	for _, g := range *group.Grants {
		key := g.Entity + "." + g.Action
		if grants[key] || g.OwnOnly == nil || !validGrant(g.Entity, g.Action, *g.OwnOnly) {
			return false
		}
		grants[key] = true
	}
	overrides := map[string]bool{}
	for _, o := range *policy.Overrides {
		key := o.Entity + "." + o.Action
		if overrides[key] || o.Granted == nil || o.OwnOnly == nil || !validGrant(o.Entity, o.Action, *o.Granted && *o.OwnOnly) {
			return false
		}
		overrides[key] = true
	}
	for _, list := range [][]Hidden{*policy.Hidden, *group.Hidden} {
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

// overrides covers every known entity/action, so group grants cannot add
// editing, administration, firmware, streaming or emulation capabilities.
// RomM still grants its unconditional self-service scopes to ordinary users.
func overrides(read bool) []Override {
	result := []Override{}
	for _, entity := range PermissionEntities {
		for _, action := range PermissionActions {
			granted := read && action == "read" && (entity == "roms" || entity == "platforms")
			own := false
			result = append(result, Override{entity, action, &granted, &own})
		}
	}
	return result
}

// OverridesMatch reports whether actual is exactly the override set MUM
// writes: read access to ROMs and platforms only when read is true.
func OverridesMatch(actual []Override, read bool) bool {
	expected := overrides(read)
	if len(actual) != len(expected) {
		return false
	}
	seen := map[string]bool{}
	for _, o := range actual {
		key := o.Entity + "." + o.Action
		if seen[key] || o.Granted == nil || o.OwnOnly == nil || *o.OwnOnly || !validGrant(o.Entity, o.Action, false) {
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

// ContentEqual reports whether two observations have the same group and the
// same content restrictions (age, unrated, hidden entries).
func ContentEqual(a, b *Observed) bool {
	if a == nil || b == nil || !groupIDEqual(a.User.GroupID, b.User.GroupID) || a.Group.ID == nil || b.Group.ID == nil || *a.Group.ID != *b.Group.ID {
		return false
	}
	equalAge := func(x, y *int) bool { return x == nil && y == nil || x != nil && y != nil && *x == *y }
	equalBool := func(x, y *bool) bool { return x == nil && y == nil || x != nil && y != nil && *x == *y }
	if !equalAge(a.Policy.Age, b.Policy.Age) || !equalAge(a.Group.Age, b.Group.Age) || !equalBool(a.Policy.HideUnrated, b.Policy.HideUnrated) || !equalBool(a.Group.HideUnrated, b.Group.HideUnrated) {
		return false
	}
	for _, pair := range [][2]*[]Hidden{{a.Policy.Hidden, b.Policy.Hidden}, {a.Group.Hidden, b.Group.Hidden}} {
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

func unrestrictedContent(u *Observed) bool {
	return u != nil && u.Policy.Hidden != nil && len(*u.Policy.Hidden) == 0 && u.Group.Hidden != nil && len(*u.Group.Hidden) == 0 && u.Policy.Age == nil && u.Group.Age == nil && u.Policy.HideUnrated == nil && u.Group.HideUnrated != nil && !*u.Group.HideUnrated
}

// WriteMatches reports whether a write left the account present with the
// expected read overrides and enabled flag, and its content unchanged.
func WriteMatches(u provider.Account, read, enabled bool, original *Observed) bool {
	o := observed(u)
	return !u.Absent && o != nil && *o.User.Enabled == enabled && OverridesMatch(*o.Policy.Overrides, read) && ContentEqual(o, original)
}

func (s *Server) writeOverrides(ctx context.Context, id string, read bool) error {
	if !RecordedID(id) {
		return provider.ErrConflict
	}
	body := struct {
		Overrides []Override `json:"overrides"`
	}{overrides(read)}
	return s.send(ctx, http.MethodPut, "/api/permissions/users/"+id, body, nil)
}

func (s *Server) setEnabled(ctx context.Context, user provider.Account, enabled bool) error {
	o := observed(user)
	if o == nil {
		return provider.ErrConflict
	}
	if err := s.form(ctx, user.ID, url.Values{"enabled": {strconv.FormatBool(enabled)}}); err != nil {
		return err
	}
	verified, err := s.InspectAccount(ctx, user.ID, user.Name)
	if err != nil {
		return err
	}
	if verified.Absent || verified.Disabled == enabled || !ContentEqual(observed(verified), o) {
		return provider.ErrConflict
	}
	return nil
}

// DisableAccount clears the enabled flag and verifies the content is unchanged.
func (s *Server) DisableAccount(ctx context.Context, user provider.Account) error {
	return s.setEnabled(ctx, user, false)
}

// EnableAccount reverses a flag-based disable and verifies the content is
// unchanged.
func (s *Server) EnableAccount(ctx context.Context, user provider.Account) error {
	return s.setEnabled(ctx, user, true)
}

// ProvisionAccount creates the account in an unrestricted default group (the
// invitation layer has already validated the all-platform/download grant and
// credentials), then configures it like a resume.
func (s *Server) ProvisionAccount(ctx context.Context, name, password string, grant provider.Grant, checkpoint func(stage, remoteID string) error) error {
	if !s.ValidGrant(grant) {
		return provider.ErrConflict
	}
	if !ValidCredentials(name, password) {
		return errCredentials
	}
	groups, defaultID, err := s.readGroups(ctx)
	if err != nil {
		return err
	}
	group, ok := groups[defaultID]
	if !ok || group.Hidden == nil || len(*group.Hidden) != 0 || group.Age != nil || group.HideUnrated == nil || *group.HideUnrated {
		return provider.ErrConflict
	}
	users, err := s.Users(ctx)
	if err != nil {
		return err
	}
	for _, user := range users {
		if strings.EqualFold(user.Name, name) {
			return provider.ErrConflict
		}
	}
	if err := checkpoint("creating", ""); err != nil {
		return err
	}
	var created struct {
		ID *int64 `json:"id"`
	}
	// Explicit lowercase JSON keys; the RomM create schema does not accept a
	// disable flag or group/permission fields.
	body := struct {
		Username string `json:"username"`
		Email    string `json:"email"`
		Password string `json:"password"`
		Role     string `json:"role"`
	}{name, "", provider.RandomToken(), "user"}
	if err := s.send(ctx, http.MethodPost, "/api/users", body, &created); err != nil {
		return err
	}
	if created.ID == nil || *created.ID < 1 {
		return provider.ErrConflict
	}
	id := strconv.FormatInt(*created.ID, 10)
	if err := checkpoint("configuring", id); err != nil {
		return err
	}
	user, err := s.InspectAccount(ctx, id, name)
	if err != nil {
		return err
	}
	if user.Absent || !unrestrictedContent(observed(user)) {
		return provider.ErrConflict
	}
	return s.configure(ctx, user, password, func(stage string) error { return checkpoint(stage, id) })
}

// ResumeAccount finishes an interrupted setup of a recorded account.
func (s *Server) ResumeAccount(ctx context.Context, target provider.Resume, checkpoint func(stage string) error) error {
	if !s.ValidGrant(target.Grant) || !RecordedID(target.RemoteID) || !ValidCredentials(target.RemoteName, target.Password) {
		return provider.ErrConflict
	}
	user, err := s.InspectAccount(ctx, target.RemoteID, target.RemoteName)
	if err != nil {
		return err
	}
	if user.Absent {
		return provider.ErrConflict
	}
	return s.configure(ctx, user, target.Password, checkpoint)
}

// configure disables the account, writes no-access overrides, sets the
// password, grants read overrides, then enables it, verifying after each
// write that its content restrictions were kept.
func (s *Server) configure(ctx context.Context, user provider.Account, password string, checkpoint func(string) error) error {
	original := observed(user)
	if original == nil || !ValidCredentials(user.Name, password) {
		return provider.ErrConflict
	}
	if err := checkpoint("configuring"); err != nil {
		return err
	}
	if err := s.DisableAccount(ctx, user); err != nil {
		return err
	}
	if err := checkpoint("configuring"); err != nil {
		return err
	}
	if err := s.writeOverrides(ctx, user.ID, false); err != nil {
		return err
	}
	current, err := s.InspectAccount(ctx, user.ID, user.Name)
	if err != nil {
		return err
	}
	if !WriteMatches(current, false, false, original) {
		return provider.ErrConflict
	}
	if err := checkpoint("setting_password"); err != nil {
		return err
	}
	if err := s.form(ctx, user.ID, url.Values{"password": {password}}); err != nil {
		return err
	}
	if err := checkpoint("configuring"); err != nil {
		return err
	}
	current, err = s.InspectAccount(ctx, user.ID, user.Name)
	if err != nil {
		return err
	}
	if !WriteMatches(current, false, false, original) {
		return provider.ErrConflict
	}
	if err := s.writeOverrides(ctx, user.ID, true); err != nil {
		return err
	}
	current, err = s.InspectAccount(ctx, user.ID, user.Name)
	if err != nil {
		return err
	}
	if !WriteMatches(current, true, false, original) {
		return provider.ErrConflict
	}
	if err := checkpoint("enabling"); err != nil {
		return err
	}
	current, err = s.InspectAccount(ctx, user.ID, user.Name)
	if err != nil {
		return err
	}
	if !WriteMatches(current, true, false, original) {
		return provider.ErrConflict
	}
	if err := s.form(ctx, user.ID, url.Values{"enabled": {"true"}}); err != nil {
		return err
	}
	verified, err := s.InspectAccount(ctx, user.ID, user.Name)
	if err != nil {
		return err
	}
	if !WriteMatches(verified, true, true, original) {
		return provider.ErrConflict
	}
	return checkpoint("remote_completed")
}

// DeleteAccount sends one ID-addressed DELETE. MUM has already inspected the
// account as present and disabled, and verifies its absence afterwards.
func (s *Server) DeleteAccount(ctx context.Context, user provider.Account) error {
	if !RecordedID(user.ID) {
		return provider.ErrConflict
	}
	return s.send(ctx, http.MethodDelete, "/api/users/"+url.PathEscape(user.ID), nil, nil)
}
