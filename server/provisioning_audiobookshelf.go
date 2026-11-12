package main

import (
	"context"
	"errors"
	"maps"
	"net/http"
	"net/url"
	"slices"
	"strings"
)

var errABSCredentials = errors.New("Audiobookshelf passwords must contain 12–72 UTF-8 bytes to avoid bcrypt truncation")

type absWireUser struct {
	ID          string           `json:"id"`
	Name        string           `json:"username"`
	Type        string           `json:"type"`
	Active      *bool            `json:"isActive"`
	Locked      *bool            `json:"isLocked"`
	OIDC        *bool            `json:"hasOpenIDLink"`
	Permissions map[string]*bool `json:"permissions"`
	Libraries   *[]string        `json:"librariesAccessible"`
	Tags        *[]string        `json:"itemTagsSelected"`
}

type absReviewUser struct {
	Permissions     map[string]bool
	Libraries, Tags []string
}

func (p *jsonProvider) absRequest(ctx context.Context, method, endpoint string, body, out any) error {
	return p.jsonRequest(ctx, method, strings.TrimRight(p.config.URL, "/")+"/api"+endpoint, body, out)
}

func (p *jsonProvider) inspectABSUser(ctx context.Context, id, name string) (remoteReview, error) {
	if !validProvisionedID(id) || name == "" {
		return remoteReview{}, ErrConflict
	}
	var response struct {
		Users *[]absWireUser `json:"users"`
	}
	if err := p.absRequest(ctx, http.MethodGet, "/users", nil, &response); err != nil {
		return remoteReview{}, err
	}
	if response.Users == nil || len(*response.Users) > 10000 {
		return remoteReview{}, ErrConflict
	}
	seen := map[string]bool{}
	result := remoteReview{ID: id, Name: name, Absent: true}
	for _, user := range *response.Users {
		if !validProvisionedID(user.ID) || seen[user.ID] {
			return remoteReview{}, ErrConflict
		}
		seen[user.ID] = true
		if user.ID != id {
			continue
		}
		if user.Name != name || user.Type != "user" || user.Active == nil || user.Locked == nil || *user.Locked || user.OIDC == nil || *user.OIDC || user.Libraries == nil || user.Tags == nil || len(user.Permissions) != 9 {
			return remoteReview{}, ErrConflict
		}
		permissions := map[string]bool{}
		for _, key := range []string{"download", "update", "delete", "upload", "createEreader", "accessAllLibraries", "accessAllTags", "accessExplicitContent", "selectedTagsNotAccessible"} {
			value, ok := user.Permissions[key]
			if !ok || value == nil {
				return remoteReview{}, ErrConflict
			}
			permissions[key] = *value
		}
		for _, values := range [][]string{*user.Libraries, *user.Tags} {
			seenValues := map[string]bool{}
			for _, value := range values {
				if value == "" || seenValues[value] {
					return remoteReview{}, ErrConflict
				}
				seenValues[value] = true
			}
		}
		observed := absReviewUser{permissions, slices.Clone(*user.Libraries), slices.Clone(*user.Tags)}
		result = remoteReview{ID: id, Name: name, Disabled: !*user.Active, ABS: &observed}
	}
	return result, nil
}

func absGrantPermissions(grant InvitationGrant, content *absReviewUser) map[string]bool {
	permissions := map[string]bool{"download": grant.AllowDownloads, "update": false, "delete": false, "upload": false, "createEreader": false, "accessAllLibraries": grant.AllLibraries, "accessAllTags": true, "accessExplicitContent": false, "selectedTagsNotAccessible": false}
	if content != nil {
		for _, key := range []string{"accessAllTags", "accessExplicitContent", "selectedTagsNotAccessible"} {
			permissions[key] = content.Permissions[key]
		}
	}
	return permissions
}

func absGrantMatches(user remoteReview, grant InvitationGrant, active bool, content *absReviewUser) bool {
	if user.Absent || user.ABS == nil || user.Disabled != !active || !maps.Equal(user.ABS.Permissions, absGrantPermissions(grant, content)) {
		return false
	}
	actual := slices.Clone(user.ABS.Libraries)
	wanted := slices.Clone(grant.LibraryIDs)
	slices.Sort(actual)
	slices.Sort(wanted)
	if !slices.Equal(actual, wanted) {
		return false
	}
	tags := []string{}
	if content != nil {
		tags = slices.Clone(content.Tags)
	}
	actualTags := slices.Clone(user.ABS.Tags)
	slices.Sort(tags)
	slices.Sort(actualTags)
	return slices.Equal(tags, actualTags)
}

func (p *jsonProvider) disableABSUser(ctx context.Context, original remoteReview) error {
	if original.ABS == nil {
		return ErrConflict
	}
	if err := p.absRequest(ctx, http.MethodPatch, "/users/"+url.PathEscape(original.ID), struct {
		Active bool `json:"isActive"`
	}{false}, nil); err != nil {
		return err
	}
	verified, err := p.inspectABSUser(ctx, original.ID, original.Name)
	if err != nil {
		return err
	}
	if verified.Absent || !verified.Disabled || verified.ABS == nil || !maps.Equal(original.ABS.Permissions, verified.ABS.Permissions) {
		return ErrConflict
	}
	before := slices.Clone(original.ABS.Libraries)
	after := slices.Clone(verified.ABS.Libraries)
	slices.Sort(before)
	slices.Sort(after)
	if !slices.Equal(before, after) {
		return ErrConflict
	}
	before = slices.Clone(original.ABS.Tags)
	after = slices.Clone(verified.ABS.Tags)
	slices.Sort(before)
	slices.Sort(after)
	if !slices.Equal(before, after) {
		return ErrConflict
	}
	return nil
}

func (p *jsonProvider) provisionABSUser(ctx context.Context, username, password string, grant InvitationGrant, checkpoint func(string, string) error) error {
	if p.config.Type != "audiobookshelf" || !grant.AllLibraries && len(grant.LibraryIDs) == 0 {
		return ErrConflict
	}
	if len(password) < 12 || len(password) > 72 {
		return errABSCredentials
	}
	if err := checkpoint("creating", ""); err != nil {
		return err
	}
	body := struct {
		Name        string          `json:"username"`
		Password    string          `json:"password"`
		Type        string          `json:"type"`
		Active      bool            `json:"isActive"`
		Permissions map[string]bool `json:"permissions"`
		Libraries   []string        `json:"librariesAccessible"`
		Tags        []string        `json:"itemTagsSelected"`
	}{username, randomToken(), "user", false, absGrantPermissions(grant, nil), grant.LibraryIDs, []string{}}
	var created struct {
		User *absWireUser `json:"user"`
	}
	if err := p.absRequest(ctx, http.MethodPost, "/users", body, &created); err != nil {
		return err
	}
	if created.User == nil || !validProvisionedID(created.User.ID) {
		return ErrConflict
	}
	id := created.User.ID
	if err := checkpoint("configuring", id); err != nil {
		return err
	}
	if created.User.Name != username {
		return ErrConflict
	}
	user, err := p.inspectABSUser(ctx, id, username)
	if err != nil {
		return err
	}
	if !absGrantMatches(user, grant, false, nil) {
		return ErrConflict
	}
	if err := checkpoint("setting_password", id); err != nil {
		return err
	}
	endpoint := "/users/" + url.PathEscape(id)
	if err := p.absRequest(ctx, http.MethodPatch, endpoint, struct {
		Password string `json:"password"`
	}{password}, nil); err != nil {
		return err
	}
	if err := checkpoint("enabling", id); err != nil {
		return err
	}
	current, err := p.inspectABSUser(ctx, id, username)
	if err != nil {
		return err
	}
	if !absGrantMatches(current, grant, false, nil) {
		return ErrConflict
	}
	if err := p.absRequest(ctx, http.MethodPatch, endpoint, struct {
		Active bool `json:"isActive"`
	}{true}, nil); err != nil {
		return err
	}
	verified, err := p.inspectABSUser(ctx, id, username)
	if err != nil {
		return err
	}
	if !absGrantMatches(verified, grant, true, nil) {
		return ErrConflict
	}
	return checkpoint("remote_completed", id)
}

func (p *jsonProvider) resumeABSUser(ctx context.Context, target resumeTarget, checkpoint func(string) error) error {
	user, err := p.inspectABSUser(ctx, target.Step.RemoteID, target.Step.RemoteName)
	if err != nil {
		return err
	}
	if user.Absent || user.ABS == nil {
		return ErrConflict
	}
	if err := checkpoint("configuring"); err != nil {
		return err
	}
	body := struct {
		Active      bool            `json:"isActive"`
		Permissions map[string]bool `json:"permissions"`
		Libraries   []string        `json:"librariesAccessible"`
		Tags        []string        `json:"itemTagsSelected"`
	}{false, absGrantPermissions(target.Grant, user.ABS), target.Grant.LibraryIDs, user.ABS.Tags}
	endpoint := "/users/" + url.PathEscape(user.ID)
	if err := p.absRequest(ctx, http.MethodPatch, endpoint, body, nil); err != nil {
		return err
	}
	disabled, err := p.inspectABSUser(ctx, user.ID, user.Name)
	if err != nil {
		return err
	}
	if !absGrantMatches(disabled, target.Grant, false, user.ABS) {
		return ErrConflict
	}
	if err := checkpoint("password"); err != nil {
		return err
	}
	if err := p.absRequest(ctx, http.MethodPatch, endpoint, struct {
		Password string `json:"password"`
	}{target.Password}, nil); err != nil {
		return err
	}
	if err := checkpoint("enabling"); err != nil {
		return err
	}
	current, err := p.inspectABSUser(ctx, user.ID, user.Name)
	if err != nil {
		return err
	}
	if !absGrantMatches(current, target.Grant, false, user.ABS) {
		return ErrConflict
	}
	if err := p.absRequest(ctx, http.MethodPatch, endpoint, struct {
		Active bool `json:"isActive"`
	}{true}, nil); err != nil {
		return err
	}
	verified, err := p.inspectABSUser(ctx, user.ID, user.Name)
	if err != nil {
		return err
	}
	if !absGrantMatches(verified, target.Grant, true, user.ABS) {
		return ErrConflict
	}
	return checkpoint("verified")
}
