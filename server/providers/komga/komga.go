// Package komga is MUM's Komga module: connection, library and user reads,
// email-identity provisioning, recorded-account recovery, media-access
// revocation and remote deletion. Komga has no account-disable flag, so
// cleanup removes media access only and login can remain available.
package komga

import (
	"context"
	"errors"
	"net/http"
	"net/mail"
	"net/url"
	"slices"
	"strings"

	"app/server/providers/provider"
)

var Definition = provider.Definition{
	ID:             "komga",
	Name:           "Komga",
	Description:    "Komga synchronization, email-identity provisioning and media-access revocation/recovery; login can remain available",
	DownloadLabels: true,
}

var errCredentials = &provider.CredentialsError{Code: "INVALID_KOMGA_CREDENTIALS", Message: "Komga requires an email identity and a password of 12–72 UTF-8 bytes"}

// Server is one configured Komga server.
type Server struct {
	url, apiKey string
	transport   provider.Transport
}

func New(cfg provider.Config) *Server {
	return &Server{url: strings.TrimRight(cfg.URL, "/"), apiKey: cfg.APIKey, transport: cfg.Transport}
}

func (s *Server) authorize(header http.Header) { header.Set("X-API-Key", s.apiKey) }

func (s *Server) get(ctx context.Context, endpoint string, out any) error {
	return s.transport.JSON(ctx, http.MethodGet, s.url+endpoint, s.authorize, nil, out)
}

func (s *Server) users(ctx context.Context, method, endpoint string, body, out any) error {
	return s.transport.JSON(ctx, method, s.url+"/api/v2/users"+endpoint, s.authorize, body, out)
}

// ValidEmail reports whether identity is a plain email address with a dotted
// domain, the only identity Komga accepts.
func ValidEmail(identity string) bool {
	address, err := mail.ParseAddress(identity)
	at := strings.LastIndex(identity, "@")
	return err == nil && address.Address == identity && at > 0 && strings.Contains(identity[at+1:], ".")
}

// Account rules MUM applies before and during provisioning.

func (s *Server) ValidRemoteName(name string) bool { return ValidEmail(name) }
func (s *Server) PasswordMaxBytes() int            { return 72 }

// CleanupScope is "media": revoking an account removes its media access but
// cannot disable the login.
func (s *Server) CleanupScope() string { return "media" }

// CheckCredentials is the early check made when an invitation is redeemed or
// resumed; the 12-byte minimum is enforced when the account is created.
func (s *Server) CheckCredentials(name, password string) error {
	if !ValidEmail(name) || len(password) > 72 {
		return errCredentials
	}
	return nil
}

// Reads.

func (s *Server) Libraries(ctx context.Context) ([]provider.Library, error) {
	var rows []struct {
		ID   string `json:"id"`
		Name string `json:"name"`
	}
	if err := s.get(ctx, "/api/v1/libraries", &rows); err != nil {
		return nil, err
	}
	if rows == nil {
		return nil, errors.New("missing Komga library array")
	}
	result := []provider.Library{}
	for _, l := range rows {
		result = append(result, provider.Library{ID: l.ID, Name: l.Name, Type: "comic"})
	}
	return result, nil
}

func (s *Server) Users(ctx context.Context) ([]provider.User, error) {
	var rows []struct {
		ID        string    `json:"id"`
		Email     string    `json:"email"`
		All       *bool     `json:"sharedAllLibraries"`
		Libraries *[]string `json:"sharedLibrariesIds"`
		Roles     *[]string `json:"roles"`
	}
	if err := s.get(ctx, "/api/v2/users", &rows); err != nil {
		return nil, err
	}
	if rows == nil {
		return nil, errors.New("missing Komga user array")
	}
	result := []provider.User{}
	for _, u := range rows {
		if u.All == nil || u.Libraries == nil || u.Roles == nil {
			return nil, errors.New("missing Komga library access policy")
		}
		for _, role := range *u.Roles {
			if strings.TrimSpace(role) == "" {
				return nil, errors.New("invalid Komga role observation")
			}
		}
		roles, ids := *u.Roles, *u.Libraries
		// Active means the user can read something: an admin, or any library
		// access together with a reading role.
		active := slices.Contains(roles, "ADMIN") || (*u.All || len(ids) > 0) && (slices.Contains(roles, "PAGE_STREAMING") || slices.Contains(roles, "FILE_DOWNLOAD") || slices.Contains(roles, "KOBO_SYNC") || slices.Contains(roles, "KOREADER_SYNC"))
		result = append(result, provider.User{
			ID: u.ID, Name: u.Email, Email: u.Email, Active: active, AllLibraries: *u.All, LibraryIDs: ids,
			Access: &provider.UserAccess{LibrariesKnown: true, DownloadsKnown: true, AllowDownloads: slices.Contains(roles, "FILE_DOWNLOAD")},
		})
	}
	return result, nil
}

// Recorded accounts.

type AgeRestriction struct {
	Age         int32  `json:"age"`
	Restriction string `json:"restriction"`
}

// Observed is a Komga account's observed access and content restrictions;
// it is the Detail of the provider.Account this module returns.
type Observed struct {
	Roles, Libraries, LabelsAllow, LabelsExclude []string
	All                                          bool
	Age                                          *AgeRestriction
}

type wireUser struct {
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

// LibraryGrant is Komga's sharedLibraries request body.
type LibraryGrant struct {
	All bool     `json:"all"`
	IDs []string `json:"libraryIds"`
}

func observed(a provider.Account) *Observed {
	o, _ := a.Detail.(*Observed)
	return o
}

// InspectAccount reads the account with the recorded ID and email. An account
// that is missing from a complete, valid list is reported Absent; any
// unexpected role, duplicate or mismatch is a conflict.
func (s *Server) InspectAccount(ctx context.Context, id, email string) (provider.Account, error) {
	if !provider.ValidID(id) || !ValidEmail(email) {
		return provider.Account{}, provider.ErrConflict
	}
	var users []wireUser
	if err := s.users(ctx, http.MethodGet, "", nil, &users); err != nil {
		return provider.Account{}, err
	}
	if users == nil || len(users) > 10000 {
		return provider.Account{}, provider.ErrConflict
	}
	seen := map[string]bool{}
	result := provider.Account{ID: id, Name: email, Absent: true}
	for _, user := range users {
		if !provider.ValidID(user.ID) || seen[user.ID] {
			return provider.Account{}, provider.ErrConflict
		}
		seen[user.ID] = true
		if user.ID != id {
			continue
		}
		if user.Email != email || user.Roles == nil || user.All == nil || user.Libraries == nil || user.LabelsAllow == nil || user.LabelsExclude == nil {
			return provider.Account{}, provider.ErrConflict
		}
		roles := map[string]bool{}
		for _, role := range *user.Roles {
			if roles[role] {
				return provider.Account{}, provider.ErrConflict
			}
			roles[role] = true
			switch role {
			case "USER", "FILE_DOWNLOAD", "PAGE_STREAMING", "KOBO_SYNC", "KOREADER_SYNC":
			default:
				return provider.Account{}, provider.ErrConflict
			}
		}
		if !roles["USER"] {
			return provider.Account{}, provider.ErrConflict
		}
		for _, values := range [][]string{*user.Libraries, *user.LabelsAllow, *user.LabelsExclude} {
			seenValues := map[string]bool{}
			for _, value := range values {
				if value == "" || seenValues[value] {
					return provider.Account{}, provider.ErrConflict
				}
				seenValues[value] = true
			}
		}
		o := Observed{slices.Clone(*user.Roles), slices.Clone(*user.Libraries), slices.Clone(*user.LabelsAllow), slices.Clone(*user.LabelsExclude), *user.All, nil}
		if user.Age != nil {
			if user.Age.Age == nil || user.Age.Restriction == nil || (*user.Age.Restriction != "ALLOW_ONLY" && *user.Age.Restriction != "EXCLUDE") {
				return provider.Account{}, provider.ErrConflict
			}
			o.Age = &AgeRestriction{*user.Age.Age, *user.Age.Restriction}
		}
		result = provider.Account{ID: id, Name: email, Detail: &o, Disabled: len(o.Roles) == 1 && !o.All && len(o.Libraries) == 0}
	}
	return result, nil
}

func roles(grant provider.Grant, enabled bool) []string {
	result := []string{"USER"}
	if enabled {
		result = append(result, "PAGE_STREAMING")
		if grant.AllowDownloads {
			result = append(result, "FILE_DOWNLOAD")
		}
	}
	return result
}

func contentEqual(first, second *Observed) bool {
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

// grantMatches checks roles and library access exactly, and that content
// restrictions equal content (or are empty when content is nil).
func grantMatches(user provider.Account, grant provider.Grant, enabled bool, content *Observed) bool {
	o := observed(user)
	if user.Absent || o == nil {
		return false
	}
	expectedRoles := roles(grant, enabled)
	actualRoles := slices.Clone(o.Roles)
	slices.Sort(expectedRoles)
	slices.Sort(actualRoles)
	all := false
	ids := []string{}
	if enabled {
		all = grant.AllLibraries
		ids = slices.Clone(grant.LibraryIDs)
	}
	actualIDs := slices.Clone(o.Libraries)
	slices.Sort(ids)
	slices.Sort(actualIDs)
	if !slices.Equal(expectedRoles, actualRoles) || o.All != all || !slices.Equal(ids, actualIDs) {
		return false
	}
	if content == nil {
		return o.Age == nil && len(o.LabelsAllow) == 0 && len(o.LabelsExclude) == 0
	}
	return contentEqual(o, content)
}

func (s *Server) applyGrant(ctx context.Context, id string, grant provider.Grant, enabled bool) error {
	all := false
	ids := []string{}
	if enabled {
		all = grant.AllLibraries
		ids = grant.LibraryIDs
	}
	body := struct {
		Roles     []string     `json:"roles"`
		Libraries LibraryGrant `json:"sharedLibraries"`
	}{roles(grant, enabled)[1:], LibraryGrant{all, ids}}
	return s.users(ctx, http.MethodPatch, "/"+url.PathEscape(id), body, nil)
}

func (s *Server) setPassword(ctx context.Context, id, password string) error {
	return s.users(ctx, http.MethodPatch, "/"+url.PathEscape(id)+"/password", struct {
		Password string `json:"password"`
	}{password}, nil)
}

// DisableAccount removes media access and verifies that nothing else changed.
func (s *Server) DisableAccount(ctx context.Context, original provider.Account) error {
	o := observed(original)
	if o == nil {
		return provider.ErrConflict
	}
	if err := s.applyGrant(ctx, original.ID, provider.Grant{}, false); err != nil {
		return err
	}
	verified, err := s.InspectAccount(ctx, original.ID, original.Name)
	if err != nil {
		return err
	}
	if !grantMatches(verified, provider.Grant{}, false, o) {
		return provider.ErrConflict
	}
	return nil
}

// ProvisionAccount creates the account with no access and a random password,
// verifies it, sets the invitee's password, then grants access and verifies
// again. checkpoint records each stage (and the remote ID once known) before
// the next remote write.
func (s *Server) ProvisionAccount(ctx context.Context, email, password string, grant provider.Grant, checkpoint func(stage, remoteID string) error) error {
	if !grant.AllLibraries && len(grant.LibraryIDs) == 0 {
		return provider.ErrConflict
	}
	if !ValidEmail(email) || len(password) < 12 || len(password) > 72 {
		return errCredentials
	}
	if err := checkpoint("creating", ""); err != nil {
		return err
	}
	body := struct {
		Email     string       `json:"email"`
		Password  string       `json:"password"`
		Roles     []string     `json:"roles"`
		Libraries LibraryGrant `json:"sharedLibraries"`
	}{email, provider.RandomToken(), []string{}, LibraryGrant{false, []string{}}}
	var created wireUser
	if err := s.users(ctx, http.MethodPost, "", body, &created); err != nil {
		return err
	}
	if !provider.ValidID(created.ID) {
		return provider.ErrConflict
	}
	if err := checkpoint("configuring", created.ID); err != nil {
		return err
	}
	if created.Email != email {
		return provider.ErrConflict
	}
	user, err := s.InspectAccount(ctx, created.ID, email)
	if err != nil {
		return err
	}
	if !grantMatches(user, grant, false, nil) {
		return provider.ErrConflict
	}
	if err := checkpoint("setting_password", created.ID); err != nil {
		return err
	}
	if err := s.setPassword(ctx, created.ID, password); err != nil {
		return err
	}
	if err := checkpoint("enabling", created.ID); err != nil {
		return err
	}
	current, err := s.InspectAccount(ctx, created.ID, email)
	if err != nil {
		return err
	}
	if !grantMatches(current, grant, false, nil) {
		return provider.ErrConflict
	}
	if err := s.applyGrant(ctx, created.ID, grant, true); err != nil {
		return err
	}
	verified, err := s.InspectAccount(ctx, created.ID, email)
	if err != nil {
		return err
	}
	if !grantMatches(verified, grant, true, nil) {
		return provider.ErrConflict
	}
	return checkpoint("remote_completed", created.ID)
}

// ResumeAccount finishes an interrupted setup of a recorded account: revoke,
// set the password, then grant, verifying after each write.
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
	if err := s.applyGrant(ctx, user.ID, target.Grant, false); err != nil {
		return err
	}
	revoked, err := s.InspectAccount(ctx, user.ID, user.Name)
	if err != nil {
		return err
	}
	if !grantMatches(revoked, target.Grant, false, o) {
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
	if err := s.applyGrant(ctx, user.ID, target.Grant, true); err != nil {
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
	return s.users(ctx, http.MethodDelete, "/"+url.PathEscape(user.ID), nil, nil)
}

// Library access for bulk edits.

func (s *Server) LibraryAccess(user provider.Account) (all bool, ids []string, ok bool) {
	o := observed(user)
	if o == nil {
		return false, nil, false
	}
	return o.All, o.Libraries, true
}

// WriteLibraryAccess replaces library access and keeps every observed role.
func (s *Server) WriteLibraryAccess(ctx context.Context, user provider.Account, all bool, ids []string) error {
	o := observed(user)
	if o == nil {
		return provider.ErrConflict
	}
	return s.users(ctx, http.MethodPatch, "/"+url.PathEscape(user.ID), map[string]any{"roles": slices.DeleteFunc(slices.Clone(o.Roles), func(role string) bool { return role == "USER" }), "sharedLibraries": LibraryGrant{all, ids}}, nil)
}

// StateWithoutLibraryAccess is the observed state minus the library grant, so
// MUM can check that a bulk library edit changed nothing else.
func (s *Server) StateWithoutLibraryAccess(user provider.Account) any {
	o := observed(user)
	if o == nil {
		return nil
	}
	v := *o
	v.All = false
	v.Roles = slices.Clone(v.Roles)
	slices.Sort(v.Roles)
	v.Libraries = nil
	return &v
}
