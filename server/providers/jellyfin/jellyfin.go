// Package jellyfin is MUM's Jellyfin module. The API it shares with Emby is in
// package mediabrowser; this package holds what is Jellyfin's own: account
// creation with a bootstrap password, the authentication-provider policy check
// and the password endpoint.
package jellyfin

import (
	"context"
	"errors"
	"net/http"
	"net/url"
	"strings"

	"app/server/providers/mediabrowser"
	"app/server/providers/provider"
)

var Definition = provider.Definition{
	ID:             "jellyfin",
	Name:           "Jellyfin",
	Description:    "Jellyfin server connection, library and user synchronization",
	DownloadLabels: true,
}

// Server is one configured Jellyfin server.
type Server struct {
	*mediabrowser.Server
}

// ActivitySnapshot reads the server's current sessions.
func (s *Server) ActivitySnapshot(ctx context.Context) (provider.ActivitySnapshot, error) {
	return s.Sessions(ctx, "jellyfin", `application/json; profile="PascalCase"`)
}

// LiveConnection describes the server's session socket.
func (s *Server) LiveConnection(device string) (provider.LiveConnection, error) {
	return s.Live(device, "/socket")
}

func New(cfg provider.Config) *Server {
	return &Server{mediabrowser.New(cfg, false)}
}

// authenticationProviders requires the provider IDs Jellyfin needs to log the
// account in and reset its password.
func authenticationProviders(policy map[string]any) bool {
	for _, key := range []string{"AuthenticationProviderId", "PasswordResetProviderId"} {
		if value, ok := policy[key].(string); !ok || value == "" {
			return false
		}
	}
	return true
}

func (s *Server) InspectAccount(ctx context.Context, id, name string) (provider.Account, error) {
	return s.Inspect(ctx, id, name, authenticationProviders)
}

func (s *Server) setPassword(ctx context.Context, id string, body map[string]any) error {
	return s.Request(ctx, http.MethodPost, "/Users/Password?userId="+url.QueryEscape(id), body, nil)
}

// ProvisionAccount creates the account with a random bootstrap password,
// writes the grant while disabled, replaces the password, then enables it.
// Each checkpoint commits before the next remote write. A failed request is
// never retried: its remote outcome may be uncertain, and MUM keeps the
// reservation for administrator review.
func (s *Server) ProvisionAccount(ctx context.Context, username, password string, grant provider.Grant, checkpoint func(stage, remoteID string) error) error {
	if !grant.AllLibraries && len(grant.LibraryIDs) == 0 {
		return errors.New("unsupported provisioning grant")
	}
	bootstrapPassword := provider.RandomToken()
	if err := checkpoint("creating", ""); err != nil {
		return err
	}
	var created struct {
		ID string `json:"Id"`
	}
	if err := s.Request(ctx, http.MethodPost, "/Users/New", map[string]string{"Name": username, "Password": bootstrapPassword}, &created); err != nil {
		return err
	}
	if !provider.ValidID(created.ID) {
		return errors.New("invalid created user identity")
	}
	if err := checkpoint("configuring", created.ID); err != nil {
		return err
	}
	var user struct {
		Policy map[string]any `json:"Policy"`
	}
	if err := s.Request(ctx, http.MethodGet, "/Users/"+url.PathEscape(created.ID), nil, &user); err != nil {
		return err
	}
	policy := user.Policy
	if policy == nil {
		return errors.New("created user policy missing")
	}
	for _, name := range []string{"AuthenticationProviderId", "PasswordResetProviderId"} {
		if value, ok := policy[name].(string); !ok || strings.TrimSpace(value) == "" {
			return errors.New("created user authentication policy missing")
		}
	}
	mediabrowser.ApplyGrant(policy, grant)
	if err := s.SetPolicy(ctx, created.ID, policy); err != nil {
		return err
	}
	if err := checkpoint("setting_password", created.ID); err != nil {
		return err
	}
	if err := s.setPassword(ctx, created.ID, map[string]any{"CurrentPw": bootstrapPassword, "NewPw": password, "ResetPassword": false}); err != nil {
		return err
	}
	if err := checkpoint("enabling", created.ID); err != nil {
		return err
	}
	policy["IsDisabled"] = false
	if err := s.SetPolicy(ctx, created.ID, policy); err != nil {
		return err
	}
	return checkpoint("remote_completed", created.ID)
}

// ResumeAccount finishes an interrupted setup: write the grant while
// disabled, set the password, then enable and verify.
func (s *Server) ResumeAccount(ctx context.Context, target provider.Resume, checkpoint func(stage string) error) error {
	user, err := s.InspectAccount(ctx, target.RemoteID, target.RemoteName)
	if err != nil {
		return err
	}
	if user.Absent {
		return provider.ErrConflict
	}
	if err := checkpoint("configuring"); err != nil {
		return err
	}
	policy := mediabrowser.PolicyOf(user)
	mediabrowser.ApplyGrant(policy, target.Grant)
	if err := s.SetPolicy(ctx, user.ID, policy); err != nil {
		return err
	}
	if err := checkpoint("password"); err != nil {
		return err
	}
	if err := s.setPassword(ctx, user.ID, map[string]any{"NewPw": target.Password, "ResetPassword": false}); err != nil {
		return err
	}
	if err := checkpoint("enabling"); err != nil {
		return err
	}
	policy["IsDisabled"] = false
	if err := s.SetPolicy(ctx, user.ID, policy); err != nil {
		return err
	}
	verified, err := s.InspectAccount(ctx, user.ID, target.RemoteName)
	if err != nil {
		return err
	}
	if verified.Absent || !mediabrowser.GrantMatches(mediabrowser.PolicyOf(verified), target.Grant, false) {
		return provider.ErrConflict
	}
	return checkpoint("verified")
}
