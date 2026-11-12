package main

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"slices"
)

type editProviderRequest struct {
	Action, ID, Name string
	AllLibraries     bool
	LibraryIDs       []string
}
type editProviderSnapshot struct {
	Revision, Group, PlexOwner, PlexRecipient string
	Absent                                    bool
	user                                      remoteReview
	plex                                      *editPlexState
}
type editProviderResult struct{ Outcome, Code string }

func editHash(v any) string { b, _ := json.Marshal(v); return fmt.Sprintf("%x", sha256.Sum256(b)) }
func (p *serverConnection) prepareEditUser(ctx context.Context, r editProviderRequest) (editProviderSnapshot, error) {
	if r.Action != "delete_users" && r.Action != "update_libraries" {
		return editProviderSnapshot{}, ErrConflict
	}
	if r.Action == "update_libraries" {
		// A module that cannot edit library access cannot take part. Plex edit
		// edits use the core's sharing workflow (prepareEditPlex).
		if m := p.module(); m != nil && p.config.Type != "plex" {
			if _, edits := m.(libraryAccessEditor); !edits {
				return editProviderSnapshot{}, fmt.Errorf("EDIT_LIBRARY_UNSUPPORTED")
			}
		}
		if r.AllLibraries && len(r.LibraryIDs) > 0 {
			return editProviderSnapshot{}, ErrConflict
		}
		libs, err := p.Libraries(ctx)
		if err != nil {
			return editProviderSnapshot{}, err
		}
		seen := map[string]bool{}
		available := map[string]bool{}
		for _, l := range libs {
			available[l.ID] = true
		}
		for _, id := range r.LibraryIDs {
			if !available[id] || seen[id] {
				return editProviderSnapshot{}, ErrConflict
			}
			seen[id] = true
		}
	}
	if p.config.Type == "plex" {
		return p.prepareEditPlex(ctx, r)
	}
	u, err := p.inspectProvisionedUser(ctx, r.ID, r.Name)
	if err != nil {
		return editProviderSnapshot{}, err
	}
	s := editProviderSnapshot{Group: editHash([]string{p.config.Type, p.config.URL, r.ID}), Absent: u.Absent, user: u}
	s.Revision = editHash(u)
	return s, nil
}
func (p *serverConnection) editGrantMatches(ctx context.Context, r editProviderRequest, u remoteReview) bool {
	if m, ok := p.module().(libraryGrantMatcher); ok {
		return m.LibraryGrantMatches(ctx, u, r.AllLibraries, r.LibraryIDs)
	}
	if m, ok := p.module().(libraryAccessEditor); ok {
		all, ids, known := m.LibraryAccess(u)
		return known && all == r.AllLibraries && (all || editIDsEqual(ids, r.LibraryIDs))
	}
	return false
}
func editIDsEqual(a, b []string) bool {
	a = slices.Clone(a)
	b = slices.Clone(b)
	slices.Sort(a)
	slices.Sort(b)
	return slices.Equal(a, b)
}
func (p *serverConnection) editWriteGrant(ctx context.Context, r editProviderRequest, u remoteReview) error {
	ids := slices.Clone(r.LibraryIDs)
	if ids == nil {
		ids = []string{}
	}
	if m, ok := p.module().(libraryAccessEditor); ok {
		return m.WriteLibraryAccess(ctx, u, r.AllLibraries, ids)
	}
	return ErrConflict
}
func (p *serverConnection) executeEditUser(ctx context.Context, r editProviderRequest, s editProviderSnapshot, checkpoint func(string) error) (editProviderResult, error) {
	fresh, err := p.prepareEditUser(ctx, r)
	if err != nil {
		return editProviderResult{"failed", "REMOTE_INSPECTION_FAILED"}, err
	}
	if fresh.Revision != s.Revision {
		return editProviderResult{"failed", "REMOTE_CHANGED"}, ErrConflict
	}
	if p.config.Type == "plex" {
		return p.executeEditPlex(ctx, r, fresh, checkpoint)
	}
	if fresh.Absent {
		if r.Action == "delete_users" {
			return editProviderResult{"deleted", "REMOTE_ABSENT"}, nil
		}
		return editProviderResult{"failed", "REMOTE_ABSENT"}, nil
	}
	if r.Action == "update_libraries" && p.editGrantMatches(ctx, r, fresh.user) {
		return editProviderResult{"unchanged", "GRANT_UNCHANGED"}, nil
	}
	if checkpoint == nil {
		return editProviderResult{"failed", "CHECKPOINT_REQUIRED"}, ErrConflict
	}
	if r.Action == "delete_users" && !fresh.user.Disabled {
		if err = checkpoint("disable_dispatched"); err != nil {
			return editProviderResult{"failed", "CHECKPOINT_FAILED"}, err
		}
		_ = p.disableProvisionedUser(ctx, fresh.user)
		u, e := p.inspectProvisionedUser(ctx, r.ID, r.Name)
		if e != nil || (!u.Absent && !u.Disabled) {
			return editProviderResult{"unknown", "DISABLE_UNVERIFIED"}, nil
		}
		fresh.user = u
		if u.Absent {
			return editProviderResult{"deleted", "REMOTE_ABSENT"}, nil
		}
	}
	stage := "grant_dispatched"
	if r.Action == "delete_users" {
		stage = "delete_dispatched"
	}
	if err = checkpoint(stage); err != nil {
		return editProviderResult{"failed", "CHECKPOINT_FAILED"}, err
	}
	if r.Action == "delete_users" {
		if m, ok := p.module().(nameDeleter); ok {
			checked, e := p.prepareEditUser(ctx, r)
			u := checked.user
			if e != nil || u.Absent || !u.Disabled {
				return editProviderResult{"failed", "REMOTE_CHANGED"}, ErrConflict
			}
			err = m.DeleteVerifiedByName(ctx, u)
		} else {
			err = p.deleteRecordedUser(ctx, fresh.user)
		}
	} else {
		err = p.editWriteGrant(ctx, r, fresh.user)
	}
	if r.Action == "update_libraries" {
		observed, inspectErr := p.inspectProvisionedUser(ctx, r.ID, r.Name)
		if inspectErr != nil {
			return editProviderResult{"unknown", "REMOTE_UNVERIFIED"}, nil
		}
		if observed.Absent || p.editGrantProtection(observed) != p.editGrantProtection(fresh.user) {
			return editProviderResult{"unknown", "REMOTE_POLICY_CHANGED"}, nil
		}
	}
	result, readErr := p.reconcileEditUser(ctx, r)
	if readErr != nil {
		return editProviderResult{"unknown", "REMOTE_UNVERIFIED"}, nil
	}
	if result.Outcome == "updated" || result.Outcome == "deleted" {
		return result, nil
	}
	if err != nil {
		return editProviderResult{"unknown", "REMOTE_UNVERIFIED"}, nil
	}
	return editProviderResult{"failed", "REMOTE_NOT_APPLIED"}, nil
}
func (p *serverConnection) reconcileEditUser(ctx context.Context, r editProviderRequest) (editProviderResult, error) {
	s, err := p.prepareEditUser(ctx, r)
	if err != nil {
		return editProviderResult{"unknown", "REMOTE_INSPECTION_FAILED"}, err
	}
	if p.config.Type == "plex" {
		return p.reconcileEditPlex(r, s), nil
	}
	if r.Action == "delete_users" && s.Absent {
		return editProviderResult{"deleted", "REMOTE_ABSENT"}, nil
	}
	if r.Action == "update_libraries" && !s.Absent && p.editGrantMatches(ctx, r, s.user) {
		return editProviderResult{"updated", "GRANT_VERIFIED"}, nil
	}
	return editProviderResult{"unknown", "REMOTE_UNVERIFIED"}, nil
}

// editGrantProtection excludes only the intended grant from the exact observed
// identity/policy. Readback must preserve every other observed restriction.
func (p *serverConnection) editGrantProtection(u remoteReview) string {
	if m, ok := p.module().(libraryAccessEditor); ok {
		u.Detail = m.StateWithoutLibraryAccess(u)
	}
	return editHash(u)
}
