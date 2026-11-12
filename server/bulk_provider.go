package main

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"maps"
	"net/http"
	"net/url"
	"slices"
	"strconv"
	"strings"
)

type bulkProviderRequest struct {
	Action, ID, Name string
	AllLibraries     bool
	LibraryIDs       []string
}
type bulkProviderSnapshot struct {
	Revision, Group, PlexOwner, PlexRecipient string
	Absent                                    bool
	user                                      remoteReview
	plex                                      *bulkPlexState
}
type bulkProviderResult struct{ Outcome, Code string }

func bulkHash(v any) string { b, _ := json.Marshal(v); return fmt.Sprintf("%x", sha256.Sum256(b)) }
func (p *jsonProvider) prepareBulkUser(ctx context.Context, r bulkProviderRequest) (bulkProviderSnapshot, error) {
	if r.Action != "delete_users" && r.Action != "update_libraries" {
		return bulkProviderSnapshot{}, ErrConflict
	}
	if r.Action == "update_libraries" {
		if p.config.Type == "romm" {
			return bulkProviderSnapshot{}, fmt.Errorf("BULK_LIBRARY_UNSUPPORTED")
		}
		if r.AllLibraries && len(r.LibraryIDs) > 0 {
			return bulkProviderSnapshot{}, ErrConflict
		}
		libs, err := p.Libraries(ctx)
		if err != nil {
			return bulkProviderSnapshot{}, err
		}
		seen := map[string]bool{}
		available := map[string]bool{}
		for _, l := range libs {
			available[l.ID] = true
		}
		for _, id := range r.LibraryIDs {
			if !available[id] || seen[id] {
				return bulkProviderSnapshot{}, ErrConflict
			}
			seen[id] = true
		}
	}
	if p.config.Type == "plex" {
		return p.prepareBulkPlex(ctx, r)
	}
	if p.config.Type == "kavita" {
		var members []struct {
			ID   int64  `json:"id"`
			Name string `json:"username"`
		}
		if err := p.get(ctx, "/Users?includePending=true", &members); err != nil {
			return bulkProviderSnapshot{}, err
		}
		if members == nil || len(members) > 10000 {
			return bulkProviderSnapshot{}, ErrConflict
		}
		seenNames := map[string]bool{}
		for _, m := range members {
			name := strings.ToLower(m.Name)
			if m.ID < 1 || name == "" || seenNames[name] {
				return bulkProviderSnapshot{}, ErrConflict
			}
			seenNames[name] = true
		}
	}
	u, err := p.inspectProvisionedUser(ctx, r.ID, r.Name)
	if err != nil {
		return bulkProviderSnapshot{}, err
	}
	s := bulkProviderSnapshot{Group: bulkHash([]string{p.config.Type, p.config.URL, r.ID}), Absent: u.Absent, user: u}
	s.Revision = bulkHash(u)
	return s, nil
}
func (p *jsonProvider) bulkGrantMatches(ctx context.Context, r bulkProviderRequest, u remoteReview) bool {
	all := false
	ids := []string{}
	switch p.config.Type {
	case "jellyfin", "emby":
		var ok bool
		all, ok = u.Policy["EnableAllFolders"].(bool)
		if !ok {
			return false
		}
		b, _ := json.Marshal(u.Policy["EnabledFolders"])
		if json.Unmarshal(b, &ids) != nil {
			return false
		}
	case "audiobookshelf":
		if u.ABS == nil {
			return false
		}
		all = u.ABS.Permissions["accessAllLibraries"]
		ids = u.ABS.Libraries
	case "komga":
		if u.Komga == nil {
			return false
		}
		all = u.Komga.All
		ids = u.Komga.Libraries
	case "kavita":
		if u.Kavita == nil {
			return false
		}
		for _, id := range u.Kavita.Libraries {
			ids = append(ids, strconv.FormatInt(id, 10))
		}
		if r.AllLibraries {
			libs, err := p.Libraries(ctx)
			if err != nil {
				return false
			}
			want := []string{}
			for _, l := range libs {
				want = append(want, l.ID)
			}
			return bulkIDsEqual(ids, want)
		}
	default:
		return false
	}
	return all == r.AllLibraries && (all || bulkIDsEqual(ids, r.LibraryIDs))
}
func bulkIDsEqual(a, b []string) bool {
	a = slices.Clone(a)
	b = slices.Clone(b)
	slices.Sort(a)
	slices.Sort(b)
	return slices.Equal(a, b)
}
func (p *jsonProvider) bulkWriteGrant(ctx context.Context, r bulkProviderRequest, u remoteReview) error {
	ids := slices.Clone(r.LibraryIDs)
	if ids == nil {
		ids = []string{}
	}
	switch p.config.Type {
	case "jellyfin", "emby":
		policy := maps.Clone(u.Policy)
		policy["EnableAllFolders"] = r.AllLibraries
		policy["EnabledFolders"] = ids
		return p.mediaUserRequest(ctx, http.MethodPost, "/Users/"+url.PathEscape(r.ID)+"/Policy", policy, nil)
	case "audiobookshelf":
		permissions := maps.Clone(u.ABS.Permissions)
		permissions["accessAllLibraries"] = r.AllLibraries
		return p.absRequest(ctx, http.MethodPatch, "/users/"+url.PathEscape(r.ID), map[string]any{"permissions": permissions, "librariesAccessible": ids}, nil)
	case "komga":
		return p.komgaRequest(ctx, http.MethodPatch, "/"+url.PathEscape(r.ID), map[string]any{"roles": slices.DeleteFunc(slices.Clone(u.Komga.Roles), func(role string) bool { return role == "USER" }), "sharedLibraries": komgaLibraryGrant{r.AllLibraries, ids}}, nil)
	case "kavita":
		if r.AllLibraries {
			libs, err := p.Libraries(ctx)
			if err != nil {
				return err
			}
			ids = []string{}
			for _, l := range libs {
				ids = append(ids, l.ID)
			}
		}
		numbers := []int64{}
		for _, id := range ids {
			n, err := kavitaRecordedID(id)
			if err != nil {
				return err
			}
			numbers = append(numbers, n)
		}
		return p.updateKavitaUser(ctx, *u.Kavita, u.Kavita.Roles, numbers)
	}
	return ErrConflict
}
func (p *jsonProvider) executeBulkUser(ctx context.Context, r bulkProviderRequest, s bulkProviderSnapshot, checkpoint func(string) error) (bulkProviderResult, error) {
	fresh, err := p.prepareBulkUser(ctx, r)
	if err != nil {
		return bulkProviderResult{"failed", "REMOTE_INSPECTION_FAILED"}, err
	}
	if fresh.Revision != s.Revision {
		return bulkProviderResult{"failed", "REMOTE_CHANGED"}, ErrConflict
	}
	if p.config.Type == "plex" {
		return p.executeBulkPlex(ctx, r, fresh, checkpoint)
	}
	if fresh.Absent {
		if r.Action == "delete_users" {
			return bulkProviderResult{"deleted", "REMOTE_ABSENT"}, nil
		}
		return bulkProviderResult{"failed", "REMOTE_ABSENT"}, nil
	}
	if r.Action == "update_libraries" && p.bulkGrantMatches(ctx, r, fresh.user) {
		return bulkProviderResult{"unchanged", "GRANT_UNCHANGED"}, nil
	}
	if checkpoint == nil {
		return bulkProviderResult{"failed", "CHECKPOINT_REQUIRED"}, ErrConflict
	}
	if r.Action == "delete_users" && !fresh.user.Disabled {
		if err = checkpoint("disable_dispatched"); err != nil {
			return bulkProviderResult{"failed", "CHECKPOINT_FAILED"}, err
		}
		_ = p.disableProvisionedUser(ctx, fresh.user)
		u, e := p.inspectProvisionedUser(ctx, r.ID, r.Name)
		if e != nil || (!u.Absent && !u.Disabled) {
			return bulkProviderResult{"unknown", "DISABLE_UNVERIFIED"}, nil
		}
		fresh.user = u
		if u.Absent {
			return bulkProviderResult{"deleted", "REMOTE_ABSENT"}, nil
		}
	}
	stage := "grant_dispatched"
	if r.Action == "delete_users" {
		stage = "delete_dispatched"
	}
	if err = checkpoint(stage); err != nil {
		return bulkProviderResult{"failed", "CHECKPOINT_FAILED"}, err
	}
	if r.Action == "delete_users" {
		if p.config.Type == "kavita" {
			checked, e := p.prepareBulkUser(ctx, r)
			u := checked.user
			if e != nil || u.Absent || !u.Disabled {
				return bulkProviderResult{"failed", "REMOTE_CHANGED"}, ErrConflict
			}
			err = p.jsonRequest(ctx, http.MethodDelete, strings.TrimRight(p.config.URL, "/")+"/api/Users/delete-user?username="+url.QueryEscape(r.Name), nil, nil)
		} else {
			err = p.deleteRecordedUser(ctx, fresh.user)
		}
	} else {
		err = p.bulkWriteGrant(ctx, r, fresh.user)
	}
	if r.Action == "update_libraries" {
		observed, inspectErr := p.inspectProvisionedUser(ctx, r.ID, r.Name)
		if inspectErr != nil {
			return bulkProviderResult{"unknown", "REMOTE_UNVERIFIED"}, nil
		}
		if observed.Absent || bulkGrantProtection(observed) != bulkGrantProtection(fresh.user) {
			return bulkProviderResult{"unknown", "REMOTE_POLICY_CHANGED"}, nil
		}
	}
	result, readErr := p.reconcileBulkUser(ctx, r)
	if readErr != nil {
		return bulkProviderResult{"unknown", "REMOTE_UNVERIFIED"}, nil
	}
	if result.Outcome == "updated" || result.Outcome == "deleted" {
		return result, nil
	}
	if err != nil {
		return bulkProviderResult{"unknown", "REMOTE_UNVERIFIED"}, nil
	}
	return bulkProviderResult{"failed", "REMOTE_NOT_APPLIED"}, nil
}
func (p *jsonProvider) reconcileBulkUser(ctx context.Context, r bulkProviderRequest) (bulkProviderResult, error) {
	s, err := p.prepareBulkUser(ctx, r)
	if err != nil {
		return bulkProviderResult{"unknown", "REMOTE_INSPECTION_FAILED"}, err
	}
	if p.config.Type == "plex" {
		return p.reconcileBulkPlex(r, s), nil
	}
	if r.Action == "delete_users" && s.Absent {
		return bulkProviderResult{"deleted", "REMOTE_ABSENT"}, nil
	}
	if r.Action == "update_libraries" && !s.Absent && p.bulkGrantMatches(ctx, r, s.user) {
		return bulkProviderResult{"updated", "GRANT_VERIFIED"}, nil
	}
	return bulkProviderResult{"unknown", "REMOTE_UNVERIFIED"}, nil
}

// bulkGrantProtection excludes only the intended grant from the exact observed
// identity/policy. Readback must preserve every other observed restriction.
func bulkGrantProtection(u remoteReview) string {
	if u.Policy != nil {
		u.Policy = maps.Clone(u.Policy)
		delete(u.Policy, "EnableAllFolders")
		delete(u.Policy, "EnabledFolders")
	}
	if u.ABS != nil {
		v := *u.ABS
		v.Permissions = maps.Clone(v.Permissions)
		delete(v.Permissions, "accessAllLibraries")
		v.Libraries = nil
		u.ABS = &v
	}
	if u.Komga != nil {
		v := *u.Komga
		v.All = false
		v.Roles = slices.Clone(v.Roles)
		slices.Sort(v.Roles)
		v.Libraries = nil
		u.Komga = &v
	}
	if u.Kavita != nil {
		v := *u.Kavita
		v.Roles = slices.Clone(v.Roles)
		slices.Sort(v.Roles)
		v.Libraries = nil
		u.Kavita = &v
	}
	return bulkHash(u)
}
