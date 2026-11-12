package main

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"slices"
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
func (p *serverConnection) prepareBulkUser(ctx context.Context, r bulkProviderRequest) (bulkProviderSnapshot, error) {
	if r.Action != "delete_users" && r.Action != "update_libraries" {
		return bulkProviderSnapshot{}, ErrConflict
	}
	if r.Action == "update_libraries" {
		// A module that cannot edit library access cannot take part. Plex bulk
		// edits use the core's sharing workflow (prepareBulkPlex).
		if m := p.module(); m != nil && p.config.Type != "plex" {
			if _, edits := m.(libraryAccessEditor); !edits {
				return bulkProviderSnapshot{}, fmt.Errorf("BULK_LIBRARY_UNSUPPORTED")
			}
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
	u, err := p.inspectProvisionedUser(ctx, r.ID, r.Name)
	if err != nil {
		return bulkProviderSnapshot{}, err
	}
	s := bulkProviderSnapshot{Group: bulkHash([]string{p.config.Type, p.config.URL, r.ID}), Absent: u.Absent, user: u}
	s.Revision = bulkHash(u)
	return s, nil
}
func (p *serverConnection) bulkGrantMatches(ctx context.Context, r bulkProviderRequest, u remoteReview) bool {
	if m, ok := p.module().(libraryGrantMatcher); ok {
		return m.LibraryGrantMatches(ctx, u, r.AllLibraries, r.LibraryIDs)
	}
	if m, ok := p.module().(libraryAccessEditor); ok {
		all, ids, known := m.LibraryAccess(u)
		return known && all == r.AllLibraries && (all || bulkIDsEqual(ids, r.LibraryIDs))
	}
	return false
}
func bulkIDsEqual(a, b []string) bool {
	a = slices.Clone(a)
	b = slices.Clone(b)
	slices.Sort(a)
	slices.Sort(b)
	return slices.Equal(a, b)
}
func (p *serverConnection) bulkWriteGrant(ctx context.Context, r bulkProviderRequest, u remoteReview) error {
	ids := slices.Clone(r.LibraryIDs)
	if ids == nil {
		ids = []string{}
	}
	if m, ok := p.module().(libraryAccessEditor); ok {
		return m.WriteLibraryAccess(ctx, u, r.AllLibraries, ids)
	}
	return ErrConflict
}
func (p *serverConnection) executeBulkUser(ctx context.Context, r bulkProviderRequest, s bulkProviderSnapshot, checkpoint func(string) error) (bulkProviderResult, error) {
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
		if m, ok := p.module().(nameDeleter); ok {
			checked, e := p.prepareBulkUser(ctx, r)
			u := checked.user
			if e != nil || u.Absent || !u.Disabled {
				return bulkProviderResult{"failed", "REMOTE_CHANGED"}, ErrConflict
			}
			err = m.DeleteVerifiedByName(ctx, u)
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
		if observed.Absent || p.bulkGrantProtection(observed) != p.bulkGrantProtection(fresh.user) {
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
func (p *serverConnection) reconcileBulkUser(ctx context.Context, r bulkProviderRequest) (bulkProviderResult, error) {
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
func (p *serverConnection) bulkGrantProtection(u remoteReview) string {
	if m, ok := p.module().(libraryAccessEditor); ok {
		u.Detail = m.StateWithoutLibraryAccess(u)
	}
	return bulkHash(u)
}
