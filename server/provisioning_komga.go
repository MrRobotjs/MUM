package main

import (
	"context"
	"errors"
	"net/http"
	"net/mail"
	"net/url"
	"slices"
	"strings"
)

var errKomgaCredentials = errors.New("Komga requires an email identity and a password of 12–72 UTF-8 bytes")

type komgaAgeRestriction struct {
	Age         int32  `json:"age"`
	Restriction string `json:"restriction"`
}
type komgaReviewUser struct {
	Roles, Libraries, LabelsAllow, LabelsExclude []string
	All                                          bool
	Age                                          *komgaAgeRestriction
}
type komgaWireUser struct {
	ID            string    `json:"id"`
	Email         string    `json:"email"`
	Roles         *[]string `json:"roles"`
	All           *bool     `json:"sharedAllLibraries"`
	Libraries     *[]string `json:"sharedLibrariesIds"`
	LabelsAllow   *[]string `json:"labelsAllow"`
	LabelsExclude *[]string `json:"labelsExclude"`
	Age           *struct {
		Age         *int32  `json:"age"`
		Restriction *string `json:"restriction"`
	} `json:"ageRestriction"`
}
type komgaLibraryGrant struct {
	All bool     `json:"all"`
	IDs []string `json:"libraryIds"`
}

func validKomgaEmail(identity string) bool {
	address, err := mail.ParseAddress(identity)
	at := strings.LastIndex(identity, "@")
	return err == nil && address.Address == identity && at > 0 && strings.Contains(identity[at+1:], ".")
}
func (p *jsonProvider) komgaRequest(ctx context.Context, method, endpoint string, body, out any) error {
	return p.jsonRequest(ctx, method, strings.TrimRight(p.config.URL, "/")+"/api/v2/users"+endpoint, body, out)
}
func (p *jsonProvider) inspectKomgaUser(ctx context.Context, id, email string) (remoteReview, error) {
	if !validProvisionedID(id) || !validKomgaEmail(email) {
		return remoteReview{}, ErrConflict
	}
	var users []komgaWireUser
	if err := p.komgaRequest(ctx, http.MethodGet, "", nil, &users); err != nil {
		return remoteReview{}, err
	}
	if users == nil || len(users) > 10000 {
		return remoteReview{}, ErrConflict
	}
	seen := map[string]bool{}
	result := remoteReview{ID: id, Name: email, Absent: true}
	for _, user := range users {
		if !validProvisionedID(user.ID) || seen[user.ID] {
			return remoteReview{}, ErrConflict
		}
		seen[user.ID] = true
		if user.ID != id {
			continue
		}
		if user.Email != email || user.Roles == nil || user.All == nil || user.Libraries == nil || user.LabelsAllow == nil || user.LabelsExclude == nil {
			return remoteReview{}, ErrConflict
		}
		roles := map[string]bool{}
		for _, role := range *user.Roles {
			if roles[role] {
				return remoteReview{}, ErrConflict
			}
			roles[role] = true
			switch role {
			case "USER", "FILE_DOWNLOAD", "PAGE_STREAMING", "KOBO_SYNC", "KOREADER_SYNC":
			default:
				return remoteReview{}, ErrConflict
			}
		}
		if !roles["USER"] {
			return remoteReview{}, ErrConflict
		}
		for _, values := range [][]string{*user.Libraries, *user.LabelsAllow, *user.LabelsExclude} {
			seenValues := map[string]bool{}
			for _, value := range values {
				if value == "" || seenValues[value] {
					return remoteReview{}, ErrConflict
				}
				seenValues[value] = true
			}
		}
		observed := komgaReviewUser{slices.Clone(*user.Roles), slices.Clone(*user.Libraries), slices.Clone(*user.LabelsAllow), slices.Clone(*user.LabelsExclude), *user.All, nil}
		if user.Age != nil {
			if user.Age.Age == nil || user.Age.Restriction == nil || (*user.Age.Restriction != "ALLOW_ONLY" && *user.Age.Restriction != "EXCLUDE") {
				return remoteReview{}, ErrConflict
			}
			observed.Age = &komgaAgeRestriction{*user.Age.Age, *user.Age.Restriction}
		}
		result = remoteReview{ID: id, Name: email, Komga: &observed, Disabled: len(observed.Roles) == 1 && !observed.All && len(observed.Libraries) == 0}
	}
	return result, nil
}
func komgaRoles(grant InvitationGrant, enabled bool) []string {
	roles := []string{"USER"}
	if enabled {
		roles = append(roles, "PAGE_STREAMING")
		if grant.AllowDownloads {
			roles = append(roles, "FILE_DOWNLOAD")
		}
	}
	return roles
}
func komgaContentEqual(first, second *komgaReviewUser) bool {
	if first == nil || second == nil {
		return false
	}
	if (first.Age == nil) != (second.Age == nil) || first.Age != nil && *first.Age != *second.Age {
		return false
	}
	a := slices.Clone(first.LabelsAllow)
	b := slices.Clone(second.LabelsAllow)
	slices.Sort(a)
	slices.Sort(b)
	if !slices.Equal(a, b) {
		return false
	}
	a = slices.Clone(first.LabelsExclude)
	b = slices.Clone(second.LabelsExclude)
	slices.Sort(a)
	slices.Sort(b)
	return slices.Equal(a, b)
}
func komgaGrantMatches(user remoteReview, grant InvitationGrant, enabled bool, content *komgaReviewUser) bool {
	if user.Absent || user.Komga == nil {
		return false
	}
	expectedRoles := komgaRoles(grant, enabled)
	actualRoles := slices.Clone(user.Komga.Roles)
	slices.Sort(expectedRoles)
	slices.Sort(actualRoles)
	all := false
	ids := []string{}
	if enabled {
		all = grant.AllLibraries
		ids = slices.Clone(grant.LibraryIDs)
	}
	actualIDs := slices.Clone(user.Komga.Libraries)
	slices.Sort(ids)
	slices.Sort(actualIDs)
	if !slices.Equal(expectedRoles, actualRoles) || user.Komga.All != all || !slices.Equal(ids, actualIDs) {
		return false
	}
	if content == nil {
		return user.Komga.Age == nil && len(user.Komga.LabelsAllow) == 0 && len(user.Komga.LabelsExclude) == 0
	}
	return komgaContentEqual(user.Komga, content)
}
func (p *jsonProvider) applyKomgaGrant(ctx context.Context, id string, grant InvitationGrant, enabled bool) error {
	all := false
	ids := []string{}
	if enabled {
		all = grant.AllLibraries
		ids = grant.LibraryIDs
	}
	body := struct {
		Roles     []string          `json:"roles"`
		Libraries komgaLibraryGrant `json:"sharedLibraries"`
	}{komgaRoles(grant, enabled)[1:], komgaLibraryGrant{all, ids}}
	return p.komgaRequest(ctx, http.MethodPatch, "/"+url.PathEscape(id), body, nil)
}
func (p *jsonProvider) disableKomgaUser(ctx context.Context, original remoteReview) error {
	if original.Komga == nil {
		return ErrConflict
	}
	if err := p.applyKomgaGrant(ctx, original.ID, InvitationGrant{}, false); err != nil {
		return err
	}
	verified, err := p.inspectKomgaUser(ctx, original.ID, original.Name)
	if err != nil {
		return err
	}
	if !komgaGrantMatches(verified, InvitationGrant{}, false, original.Komga) {
		return ErrConflict
	}
	return nil
}
func (p *jsonProvider) provisionKomgaUser(ctx context.Context, email, password string, grant InvitationGrant, checkpoint func(string, string) error) error {
	if p.config.Type != "komga" || !grant.AllLibraries && len(grant.LibraryIDs) == 0 {
		return ErrConflict
	}
	if !validKomgaEmail(email) || len(password) < 12 || len(password) > 72 {
		return errKomgaCredentials
	}
	if err := checkpoint("creating", ""); err != nil {
		return err
	}
	body := struct {
		Email     string            `json:"email"`
		Password  string            `json:"password"`
		Roles     []string          `json:"roles"`
		Libraries komgaLibraryGrant `json:"sharedLibraries"`
	}{email, randomToken(), []string{}, komgaLibraryGrant{false, []string{}}}
	var created komgaWireUser
	if err := p.komgaRequest(ctx, http.MethodPost, "", body, &created); err != nil {
		return err
	}
	if !validProvisionedID(created.ID) {
		return ErrConflict
	}
	if err := checkpoint("configuring", created.ID); err != nil {
		return err
	}
	if created.Email != email {
		return ErrConflict
	}
	user, err := p.inspectKomgaUser(ctx, created.ID, email)
	if err != nil {
		return err
	}
	if !komgaGrantMatches(user, grant, false, nil) {
		return ErrConflict
	}
	if err := checkpoint("setting_password", created.ID); err != nil {
		return err
	}
	if err := p.komgaRequest(ctx, http.MethodPatch, "/"+url.PathEscape(created.ID)+"/password", struct {
		Password string `json:"password"`
	}{password}, nil); err != nil {
		return err
	}
	if err := checkpoint("enabling", created.ID); err != nil {
		return err
	}
	current, err := p.inspectKomgaUser(ctx, created.ID, email)
	if err != nil {
		return err
	}
	if !komgaGrantMatches(current, grant, false, nil) {
		return ErrConflict
	}
	if err := p.applyKomgaGrant(ctx, created.ID, grant, true); err != nil {
		return err
	}
	verified, err := p.inspectKomgaUser(ctx, created.ID, email)
	if err != nil {
		return err
	}
	if !komgaGrantMatches(verified, grant, true, nil) {
		return ErrConflict
	}
	return checkpoint("remote_completed", created.ID)
}
func (p *jsonProvider) resumeKomgaUser(ctx context.Context, target resumeTarget, checkpoint func(string) error) error {
	user, err := p.inspectKomgaUser(ctx, target.Step.RemoteID, target.Step.RemoteName)
	if err != nil {
		return err
	}
	if user.Absent || user.Komga == nil {
		return ErrConflict
	}
	if err := checkpoint("configuring"); err != nil {
		return err
	}
	if err := p.applyKomgaGrant(ctx, user.ID, target.Grant, false); err != nil {
		return err
	}
	revoked, err := p.inspectKomgaUser(ctx, user.ID, user.Name)
	if err != nil {
		return err
	}
	if !komgaGrantMatches(revoked, target.Grant, false, user.Komga) {
		return ErrConflict
	}
	if err := checkpoint("password"); err != nil {
		return err
	}
	if err := p.komgaRequest(ctx, http.MethodPatch, "/"+url.PathEscape(user.ID)+"/password", struct {
		Password string `json:"password"`
	}{target.Password}, nil); err != nil {
		return err
	}
	if err := checkpoint("enabling"); err != nil {
		return err
	}
	current, err := p.inspectKomgaUser(ctx, user.ID, user.Name)
	if err != nil {
		return err
	}
	if !komgaGrantMatches(current, target.Grant, false, user.Komga) {
		return ErrConflict
	}
	if err := p.applyKomgaGrant(ctx, user.ID, target.Grant, true); err != nil {
		return err
	}
	verified, err := p.inspectKomgaUser(ctx, user.ID, user.Name)
	if err != nil {
		return err
	}
	if !komgaGrantMatches(verified, target.Grant, true, user.Komga) {
		return ErrConflict
	}
	return checkpoint("verified")
}
