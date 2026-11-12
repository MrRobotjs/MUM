// Package mediabrowser holds what MUM's Jellyfin and Emby modules share. Both
// descend from Media Browser (Jellyfin forked Emby in 2018), so their users,
// user policies, library folders, system information and token header are
// still the same API. Code that differs between them lives in the jellyfin and
// emby packages; move code there if the two servers diverge further.
package mediabrowser

import (
	"context"
	"encoding/json"
	"errors"
	"maps"
	"net/http"
	"net/url"
	"slices"
	"strings"

	"app/server/providers/provider"
)

// Server is the shared part of one configured Jellyfin or Emby server.
type Server struct {
	// root is the configured address, base the API address (Emby's adds /emby).
	root, base, apiKey string
	transport          provider.Transport
}

// New builds the shared server. Emby servers are usually reached under an
// extra /emby path, which is added unless the configured URL already has it.
func New(cfg provider.Config, emby bool) *Server {
	base := strings.TrimRight(cfg.URL, "/")
	if emby && !strings.HasSuffix(base, "/emby") {
		base += "/emby"
	}
	return &Server{root: cfg.URL, base: base, apiKey: cfg.APIKey, transport: cfg.Transport}
}

func (s *Server) authorize(header http.Header) { header.Set("X-Emby-Token", s.apiKey) }

// Request sends one JSON request to an API path such as "/Users".
func (s *Server) Request(ctx context.Context, method, endpoint string, body, out any) error {
	return s.transport.JSON(ctx, method, s.base+endpoint, s.authorize, body, out)
}

// Reads.

func (s *Server) Test(ctx context.Context) (provider.Info, error) {
	var info struct {
		ServerName string
		Version    string
	}
	if err := s.Request(ctx, http.MethodGet, "/System/Info", nil, &info); err != nil {
		return provider.Info{}, err
	}
	if info.ServerName == "" {
		return provider.Info{}, errors.New("provider response lacks server name")
	}
	return provider.Info{Name: info.ServerName, Version: info.Version}, nil
}

func (s *Server) Libraries(ctx context.Context) ([]provider.Library, error) {
	var rows []struct {
		ItemID         string `json:"ItemId"`
		Name           string
		CollectionType string
	}
	if err := s.Request(ctx, http.MethodGet, "/Library/VirtualFolders", nil, &rows); err != nil {
		return nil, err
	}
	if rows == nil {
		return nil, errors.New("provider returned null library list")
	}
	result := []provider.Library{}
	for _, r := range rows {
		kind := strings.ToLower(r.CollectionType)
		if kind == "" {
			kind = "mixed"
		}
		result = append(result, provider.Library{ID: r.ItemID, Name: r.Name, Type: kind})
	}
	return result, nil
}

func (s *Server) Users(ctx context.Context) ([]provider.User, error) {
	var rows []struct {
		ID     string `json:"Id"`
		Name   string
		Policy *struct {
			IsDisabled               *bool
			EnableAllFolders         *bool
			EnabledFolders           []string
			EnableContentDownloading *bool
		}
	}
	if err := s.Request(ctx, http.MethodGet, "/Users", nil, &rows); err != nil {
		return nil, err
	}
	if rows == nil {
		return nil, errors.New("provider returned null user list")
	}
	result := []provider.User{}
	for _, r := range rows {
		if r.Policy == nil || r.Policy.IsDisabled == nil || r.Policy.EnableAllFolders == nil {
			return nil, errors.New("provider returned incomplete user access policy")
		}
		libraries := r.Policy.EnabledFolders
		if libraries == nil {
			libraries = []string{}
		}
		access := &provider.UserAccess{LibrariesKnown: true}
		if r.Policy.EnableContentDownloading != nil {
			access.DownloadsKnown = true
			access.AllowDownloads = *r.Policy.EnableContentDownloading
		}
		result = append(result, provider.User{ID: r.ID, Name: r.Name, Active: !*r.Policy.IsDisabled, AllLibraries: *r.Policy.EnableAllFolders, LibraryIDs: libraries, Access: access})
	}
	return result, nil
}

// Recorded accounts.

// Observed is an account's complete user policy, written back unchanged
// apart from the fields MUM manages; it is the Detail of the accounts these
// modules return.
type Observed struct {
	Policy map[string]any
}

// PolicyOf returns an inspected account's observed policy, or nil.
func PolicyOf(a provider.Account) map[string]any {
	if o, ok := a.Detail.(*Observed); ok {
		return o.Policy
	}
	return nil
}

// Inspect reads the recorded account by ID. A 404 is evidence of absence
// only after the authenticated API answered the connection test, so a broken
// reverse-proxy path can never prove an account is gone. extra lets a module
// add its own policy checks.
func (s *Server) Inspect(ctx context.Context, id, name string, extra func(map[string]any) bool) (provider.Account, error) {
	if !provider.ValidID(id) || name == "" {
		return provider.Account{}, provider.ErrConflict
	}
	if _, err := s.Test(ctx); err != nil {
		return provider.Account{}, err
	}
	var response struct {
		ID     string `json:"Id"`
		Name   string
		Policy map[string]any
	}
	err := s.Request(ctx, http.MethodGet, "/Users/"+url.PathEscape(id), nil, &response)
	var status *provider.HTTPError
	if errors.As(err, &status) && status.StatusCode == 404 {
		return provider.Account{ID: id, Name: name, Absent: true}, nil
	}
	if err != nil {
		return provider.Account{}, err
	}
	if response.ID != id || response.Name != name || response.Policy == nil {
		return provider.Account{}, provider.ErrConflict
	}
	admin, adminOK := response.Policy["IsAdministrator"].(bool)
	disabled, disabledOK := response.Policy["IsDisabled"].(bool)
	if !adminOK || admin || !disabledOK || extra != nil && !extra(response.Policy) {
		return provider.Account{}, provider.ErrConflict
	}
	return provider.Account{ID: id, Name: name, Disabled: disabled, Detail: &Observed{response.Policy}}, nil
}

// SetPolicy writes an account's complete policy.
func (s *Server) SetPolicy(ctx context.Context, id string, policy map[string]any) error {
	return s.Request(ctx, http.MethodPost, "/Users/"+url.PathEscape(id)+"/Policy", policy, nil)
}

// ApplyGrant sets the fields MUM manages for an invitation grant, leaving the
// account disabled and hidden; every other policy field is kept.
func ApplyGrant(policy map[string]any, grant provider.Grant) {
	policy["IsAdministrator"] = false
	policy["IsDisabled"] = true
	policy["IsHidden"] = true
	policy["EnableAllFolders"] = grant.AllLibraries
	policy["EnabledFolders"] = grant.LibraryIDs
	policy["EnableContentDownloading"] = grant.AllowDownloads
	policy["EnableSyncTranscoding"] = grant.AllowDownloads
	policy["EnableMediaPlayback"] = true
	for _, key := range []string{"EnableContentDeletion", "EnableLiveTvAccess", "EnableLiveTvManagement", "EnableRemoteControlOfOtherUsers", "EnableSharedDeviceControl"} {
		policy[key] = false
	}
	policy["EnableContentDeletionFromFolders"] = []string{}
}

// GrantMatches checks an observed (JSON-decoded) policy against a grant.
func GrantMatches(policy map[string]any, grant provider.Grant, disabled bool) bool {
	if policy["IsDisabled"] != disabled || policy["IsAdministrator"] != false || policy["IsHidden"] != true || policy["EnableAllFolders"] != grant.AllLibraries || policy["EnableContentDownloading"] != grant.AllowDownloads || policy["EnableSyncTranscoding"] != grant.AllowDownloads || policy["EnableMediaPlayback"] != true {
		return false
	}
	deletions, ok := policy["EnableContentDeletionFromFolders"].([]any)
	if !ok || len(deletions) != 0 {
		return false
	}
	for _, key := range []string{"EnableContentDeletion", "EnableLiveTvAccess", "EnableLiveTvManagement", "EnableRemoteControlOfOtherUsers", "EnableSharedDeviceControl"} {
		if policy[key] != false {
			return false
		}
	}
	rows, ok := policy["EnabledFolders"].([]any)
	if !ok {
		return false
	}
	actual := []string{}
	for _, row := range rows {
		value, ok := row.(string)
		if !ok {
			return false
		}
		actual = append(actual, value)
	}
	wanted := slices.Clone(grant.LibraryIDs)
	slices.Sort(actual)
	slices.Sort(wanted)
	return slices.Equal(actual, wanted)
}

// DisableAccount sets IsDisabled and writes the observed policy back.
func (s *Server) DisableAccount(ctx context.Context, user provider.Account) error {
	policy := maps.Clone(PolicyOf(user))
	if policy == nil {
		return provider.ErrConflict
	}
	policy["IsDisabled"] = true
	return s.SetPolicy(ctx, user.ID, policy)
}

// EnableAccount clears IsDisabled and writes the observed policy back.
func (s *Server) EnableAccount(ctx context.Context, user provider.Account) error {
	policy := maps.Clone(PolicyOf(user))
	if policy == nil {
		return provider.ErrConflict
	}
	policy["IsDisabled"] = false
	return s.SetPolicy(ctx, user.ID, policy)
}

// DeleteAccount sends one ID-addressed DELETE. MUM has already inspected the
// account as present and disabled, and verifies its absence afterwards.
func (s *Server) DeleteAccount(ctx context.Context, user provider.Account) error {
	return s.Request(ctx, http.MethodDelete, "/Users/"+url.PathEscape(user.ID), nil, nil)
}

// Library access for bulk edits.

func (s *Server) LibraryAccess(user provider.Account) (all bool, ids []string, ok bool) {
	policy := PolicyOf(user)
	all, ok = policy["EnableAllFolders"].(bool)
	if !ok {
		return false, nil, false
	}
	encoded, _ := json.Marshal(policy["EnabledFolders"])
	if json.Unmarshal(encoded, &ids) != nil {
		return false, nil, false
	}
	return all, ids, true
}

// WriteLibraryAccess replaces library access and keeps every other observed
// policy field.
func (s *Server) WriteLibraryAccess(ctx context.Context, user provider.Account, all bool, ids []string) error {
	policy := maps.Clone(PolicyOf(user))
	if policy == nil {
		return provider.ErrConflict
	}
	policy["EnableAllFolders"] = all
	policy["EnabledFolders"] = ids
	return s.SetPolicy(ctx, user.ID, policy)
}

// StateWithoutLibraryAccess is the observed policy minus the library grant.
func (s *Server) StateWithoutLibraryAccess(user provider.Account) any {
	policy := maps.Clone(PolicyOf(user))
	if policy == nil {
		return nil
	}
	delete(policy, "EnableAllFolders")
	delete(policy, "EnabledFolders")
	return &Observed{policy}
}
