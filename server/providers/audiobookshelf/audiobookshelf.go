// Package audiobookshelf is MUM's Audiobookshelf module: connection, library
// and user reads, restricted provisioning, recorded-account recovery, and
// flag-based disable, enable and remote deletion.
package audiobookshelf

import (
	"context"
	"errors"
	"maps"
	"net/http"
	"net/url"
	"slices"
	"strings"

	"app/server/providers/provider"
)

var Definition = provider.Definition{
	ID:             "audiobookshelf",
	Name:           "Audiobookshelf",
	Description:    "Audiobookshelf library/user synchronization, restricted provisioning and recorded-account recovery",
	DownloadLabels: true,
}

var errCredentials = &provider.CredentialsError{Code: "INVALID_AUDIOBOOKSHELF_CREDENTIALS", Message: "Audiobookshelf passwords must contain 12–72 UTF-8 bytes to avoid bcrypt truncation"}

// Server is one configured Audiobookshelf server.
type Server struct {
	url, apiKey string
	transport   provider.Transport
}

func New(cfg provider.Config) *Server {
	return &Server{url: strings.TrimRight(cfg.URL, "/"), apiKey: cfg.APIKey, transport: cfg.Transport}
}

func (s *Server) authorize(header http.Header) { header.Set("Authorization", "Bearer "+s.apiKey) }

func (s *Server) api(ctx context.Context, method, endpoint string, body, out any) error {
	return s.transport.JSON(ctx, method, s.url+"/api"+endpoint, s.authorize, body, out)
}

// Account rules.

func (s *Server) PasswordMaxBytes() int { return 72 }

// CheckCredentials is the early check made when an invitation is redeemed or
// resumed; the 12-byte minimum is enforced when the account is created.
func (s *Server) CheckCredentials(name, password string) error {
	if len(password) > 72 {
		return errCredentials
	}
	return nil
}

// Reads.

func (s *Server) Libraries(ctx context.Context) ([]provider.Library, error) {
	var response struct {
		Libraries *[]struct {
			ID        string `json:"id"`
			Name      string `json:"name"`
			MediaType string `json:"mediaType"`
		} `json:"libraries"`
	}
	if err := s.api(ctx, http.MethodGet, "/libraries", nil, &response); err != nil {
		return nil, err
	}
	if response.Libraries == nil {
		return nil, errors.New("missing Audiobookshelf libraries")
	}
	result := []provider.Library{}
	for _, l := range *response.Libraries {
		kind := l.MediaType
		if kind == "" {
			kind = "book"
		}
		result = append(result, provider.Library{ID: l.ID, Name: l.Name, Type: kind})
	}
	return result, nil
}

func (s *Server) Users(ctx context.Context) ([]provider.User, error) {
	var response struct {
		Users *[]struct {
			ID          string   `json:"id"`
			Name        string   `json:"username"`
			Active      *bool    `json:"isActive"`
			Locked      bool     `json:"isLocked"`
			Libraries   []string `json:"librariesAccessible"`
			Permissions struct {
				All      *bool `json:"accessAllLibraries"`
				Download *bool `json:"download"`
			} `json:"permissions"`
		} `json:"users"`
	}
	if err := s.api(ctx, http.MethodGet, "/users", nil, &response); err != nil {
		return nil, err
	}
	if response.Users == nil {
		return nil, errors.New("missing Audiobookshelf users")
	}
	result := []provider.User{}
	for _, u := range *response.Users {
		if u.Active == nil || u.Permissions.All == nil {
			return nil, errors.New("missing Audiobookshelf access policy")
		}
		ids := u.Libraries
		if ids == nil {
			ids = []string{}
		}
		access := &provider.UserAccess{LibrariesKnown: true}
		if u.Permissions.Download != nil {
			access.DownloadsKnown = true
			access.AllowDownloads = *u.Permissions.Download
		}
		result = append(result, provider.User{ID: u.ID, Name: u.Name, Active: *u.Active && !u.Locked, AllLibraries: *u.Permissions.All, LibraryIDs: ids, Access: access})
	}
	return result, nil
}

// Recorded accounts.

// Observed is an Audiobookshelf account's observed permissions, libraries and
// tags; it is the Detail of the provider.Account this module returns.
type Observed struct {
	Permissions     map[string]bool
	Libraries, Tags []string
}

type wireUser struct {
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

func observed(a provider.Account) *Observed {
	o, _ := a.Detail.(*Observed)
	return o
}

// InspectAccount reads the account with the recorded ID and username. Only a
// plain, unlocked, non-OpenID user with all nine known permissions is
// accepted; a missing account in a complete list is reported Absent.
func (s *Server) InspectAccount(ctx context.Context, id, name string) (provider.Account, error) {
	if !provider.ValidID(id) || name == "" {
		return provider.Account{}, provider.ErrConflict
	}
	var response struct {
		Users *[]wireUser `json:"users"`
	}
	if err := s.api(ctx, http.MethodGet, "/users", nil, &response); err != nil {
		return provider.Account{}, err
	}
	if response.Users == nil || len(*response.Users) > 10000 {
		return provider.Account{}, provider.ErrConflict
	}
	seen := map[string]bool{}
	result := provider.Account{ID: id, Name: name, Absent: true}
	for _, user := range *response.Users {
		if !provider.ValidID(user.ID) || seen[user.ID] {
			return provider.Account{}, provider.ErrConflict
		}
		seen[user.ID] = true
		if user.ID != id {
			continue
		}
		if user.Name != name || user.Type != "user" || user.Active == nil || user.Locked == nil || *user.Locked || user.OIDC == nil || *user.OIDC || user.Libraries == nil || user.Tags == nil || len(user.Permissions) != 9 {
			return provider.Account{}, provider.ErrConflict
		}
		permissions := map[string]bool{}
		for _, key := range []string{"download", "update", "delete", "upload", "createEreader", "accessAllLibraries", "accessAllTags", "accessExplicitContent", "selectedTagsNotAccessible"} {
			value, ok := user.Permissions[key]
			if !ok || value == nil {
				return provider.Account{}, provider.ErrConflict
			}
			permissions[key] = *value
		}
		for _, values := range [][]string{*user.Libraries, *user.Tags} {
			seenValues := map[string]bool{}
			for _, value := range values {
				if value == "" || seenValues[value] {
					return provider.Account{}, provider.ErrConflict
				}
				seenValues[value] = true
			}
		}
		o := Observed{permissions, slices.Clone(*user.Libraries), slices.Clone(*user.Tags)}
		result = provider.Account{ID: id, Name: name, Disabled: !*user.Active, Detail: &o}
	}
	return result, nil
}

func grantPermissions(grant provider.Grant, content *Observed) map[string]bool {
	permissions := map[string]bool{"download": grant.AllowDownloads, "update": false, "delete": false, "upload": false, "createEreader": false, "accessAllLibraries": grant.AllLibraries, "accessAllTags": true, "accessExplicitContent": false, "selectedTagsNotAccessible": false}
	if content != nil {
		for _, key := range []string{"accessAllTags", "accessExplicitContent", "selectedTagsNotAccessible"} {
			permissions[key] = content.Permissions[key]
		}
	}
	return permissions
}

func sortedEqual(a, b []string) bool {
	a, b = slices.Clone(a), slices.Clone(b)
	slices.Sort(a)
	slices.Sort(b)
	return slices.Equal(a, b)
}

func grantMatches(user provider.Account, grant provider.Grant, active bool, content *Observed) bool {
	o := observed(user)
	if user.Absent || o == nil || user.Disabled != !active || !maps.Equal(o.Permissions, grantPermissions(grant, content)) {
		return false
	}
	if !sortedEqual(o.Libraries, grant.LibraryIDs) {
		return false
	}
	tags := []string{}
	if content != nil {
		tags = content.Tags
	}
	return sortedEqual(tags, o.Tags)
}

// unchanged reports whether verified keeps the original's permissions,
// libraries and tags: a disable or enable must change only the active flag.
func unchanged(original, verified *Observed) bool {
	return maps.Equal(original.Permissions, verified.Permissions) && sortedEqual(original.Libraries, verified.Libraries) && sortedEqual(original.Tags, verified.Tags)
}

func (s *Server) setActive(ctx context.Context, id string, active bool) error {
	return s.api(ctx, http.MethodPatch, "/users/"+url.PathEscape(id), struct {
		Active bool `json:"isActive"`
	}{active}, nil)
}

func (s *Server) setPassword(ctx context.Context, id, password string) error {
	return s.api(ctx, http.MethodPatch, "/users/"+url.PathEscape(id), struct {
		Password string `json:"password"`
	}{password}, nil)
}

// DisableAccount clears the active flag and verifies nothing else changed.
func (s *Server) DisableAccount(ctx context.Context, original provider.Account) error {
	o := observed(original)
	if o == nil {
		return provider.ErrConflict
	}
	if err := s.setActive(ctx, original.ID, false); err != nil {
		return err
	}
	verified, err := s.InspectAccount(ctx, original.ID, original.Name)
	if err != nil {
		return err
	}
	v := observed(verified)
	if verified.Absent || !verified.Disabled || v == nil || !unchanged(o, v) {
		return provider.ErrConflict
	}
	return nil
}

// EnableAccount reverses a flag-based disable and verifies nothing else
// changed.
func (s *Server) EnableAccount(ctx context.Context, original provider.Account) error {
	o := observed(original)
	if o == nil {
		return provider.ErrConflict
	}
	if err := s.setActive(ctx, original.ID, true); err != nil {
		return err
	}
	verified, err := s.InspectAccount(ctx, original.ID, original.Name)
	if err != nil {
		return err
	}
	v := observed(verified)
	if verified.Absent || verified.Disabled || v == nil || !unchanged(o, v) {
		return provider.ErrConflict
	}
	return nil
}

// ProvisionAccount creates the account inactive with the frozen grant and a
// random password, verifies it, sets the invitee's password, then activates
// it and verifies again.
func (s *Server) ProvisionAccount(ctx context.Context, username, password string, grant provider.Grant, checkpoint func(stage, remoteID string) error) error {
	if !grant.AllLibraries && len(grant.LibraryIDs) == 0 {
		return provider.ErrConflict
	}
	if len(password) < 12 || len(password) > 72 {
		return errCredentials
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
	}{username, provider.RandomToken(), "user", false, grantPermissions(grant, nil), grant.LibraryIDs, []string{}}
	var created struct {
		User *wireUser `json:"user"`
	}
	if err := s.api(ctx, http.MethodPost, "/users", body, &created); err != nil {
		return err
	}
	if created.User == nil || !provider.ValidID(created.User.ID) {
		return provider.ErrConflict
	}
	id := created.User.ID
	if err := checkpoint("configuring", id); err != nil {
		return err
	}
	if created.User.Name != username {
		return provider.ErrConflict
	}
	user, err := s.InspectAccount(ctx, id, username)
	if err != nil {
		return err
	}
	if !grantMatches(user, grant, false, nil) {
		return provider.ErrConflict
	}
	if err := checkpoint("setting_password", id); err != nil {
		return err
	}
	if err := s.setPassword(ctx, id, password); err != nil {
		return err
	}
	if err := checkpoint("enabling", id); err != nil {
		return err
	}
	current, err := s.InspectAccount(ctx, id, username)
	if err != nil {
		return err
	}
	if !grantMatches(current, grant, false, nil) {
		return provider.ErrConflict
	}
	if err := s.setActive(ctx, id, true); err != nil {
		return err
	}
	verified, err := s.InspectAccount(ctx, id, username)
	if err != nil {
		return err
	}
	if !grantMatches(verified, grant, true, nil) {
		return provider.ErrConflict
	}
	return checkpoint("remote_completed", id)
}

// ResumeAccount finishes an interrupted setup: write the frozen grant while
// inactive (keeping observed tag restrictions), set the password, then
// activate, verifying after each write.
func (s *Server) ResumeAccount(ctx context.Context, target provider.Resume, checkpoint func(stage string) error) error {
	user, err := s.InspectAccount(ctx, target.RemoteID, target.RemoteName)
	if err != nil {
		return err
	}
	o := observed(user)
	if user.Absent || o == nil {
		return provider.ErrConflict
	}
	if err := checkpoint("configuring"); err != nil {
		return err
	}
	body := struct {
		Active      bool            `json:"isActive"`
		Permissions map[string]bool `json:"permissions"`
		Libraries   []string        `json:"librariesAccessible"`
		Tags        []string        `json:"itemTagsSelected"`
	}{false, grantPermissions(target.Grant, o), target.Grant.LibraryIDs, o.Tags}
	if err := s.api(ctx, http.MethodPatch, "/users/"+url.PathEscape(user.ID), body, nil); err != nil {
		return err
	}
	disabled, err := s.InspectAccount(ctx, user.ID, user.Name)
	if err != nil {
		return err
	}
	if !grantMatches(disabled, target.Grant, false, o) {
		return provider.ErrConflict
	}
	if err := checkpoint("password"); err != nil {
		return err
	}
	if err := s.setPassword(ctx, user.ID, target.Password); err != nil {
		return err
	}
	if err := checkpoint("enabling"); err != nil {
		return err
	}
	current, err := s.InspectAccount(ctx, user.ID, user.Name)
	if err != nil {
		return err
	}
	if !grantMatches(current, target.Grant, false, o) {
		return provider.ErrConflict
	}
	if err := s.setActive(ctx, user.ID, true); err != nil {
		return err
	}
	verified, err := s.InspectAccount(ctx, user.ID, user.Name)
	if err != nil {
		return err
	}
	if !grantMatches(verified, target.Grant, true, o) {
		return provider.ErrConflict
	}
	return checkpoint("verified")
}

// DeleteAccount sends one ID-addressed DELETE. MUM has already inspected the
// account as present and disabled, and verifies its absence afterwards.
func (s *Server) DeleteAccount(ctx context.Context, user provider.Account) error {
	return s.api(ctx, http.MethodDelete, "/users/"+url.PathEscape(user.ID), nil, nil)
}

// Library access for bulk edits.

func (s *Server) LibraryAccess(user provider.Account) (all bool, ids []string, ok bool) {
	o := observed(user)
	if o == nil {
		return false, nil, false
	}
	return o.Permissions["accessAllLibraries"], o.Libraries, true
}

// WriteLibraryAccess replaces library access and keeps every other observed
// permission.
func (s *Server) WriteLibraryAccess(ctx context.Context, user provider.Account, all bool, ids []string) error {
	o := observed(user)
	if o == nil {
		return provider.ErrConflict
	}
	permissions := maps.Clone(o.Permissions)
	permissions["accessAllLibraries"] = all
	return s.api(ctx, http.MethodPatch, "/users/"+url.PathEscape(user.ID), map[string]any{"permissions": permissions, "librariesAccessible": ids}, nil)
}

// StateWithoutLibraryAccess is the observed state minus the library grant.
func (s *Server) StateWithoutLibraryAccess(user provider.Account) any {
	o := observed(user)
	if o == nil {
		return nil
	}
	v := *o
	v.Permissions = maps.Clone(v.Permissions)
	delete(v.Permissions, "accessAllLibraries")
	v.Libraries = nil
	return &v
}
