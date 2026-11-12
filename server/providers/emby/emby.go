// Package emby is MUM's Emby module. The API it shares with Jellyfin is in
// package mediabrowser; this package holds what is Emby's own: name-only
// account creation, the extra policy restrictions MUM applies and verifies,
// and the password endpoint.
package emby

import (
	"context"
	"errors"
	"net/http"
	"net/url"

	"app/server/providers/mediabrowser"
	"app/server/providers/provider"
)

var Definition = provider.Definition{
	ID:             "emby",
	Name:           "Emby",
	Description:    "Emby synchronization and local-user provisioning; newly created accounts may be accessible before password and policy setup",
	DownloadLabels: true,
}

// Server is one configured Emby server.
type Server struct {
	*mediabrowser.Server
}

// ActivitySnapshot reads the server's current sessions.
func (s *Server) ActivitySnapshot(ctx context.Context) (provider.ActivitySnapshot, error) {
	return s.Sessions(ctx, "emby", "application/json")
}

// LiveConnection describes the server's session socket.
func (s *Server) LiveConnection(device string) (provider.LiveConnection, error) {
	return s.Live(device, "")
}

func New(cfg provider.Config) *Server {
	return &Server{mediabrowser.New(cfg, true)}
}

func (s *Server) InspectAccount(ctx context.Context, id, name string) (provider.Account, error) {
	return s.Inspect(ctx, id, name, nil)
}

// applyRestrictions hides the account remotely and turns off sharing,
// subtitle management and media conversion.
func applyRestrictions(policy map[string]any) {
	policy["IsHiddenRemotely"] = true
	for _, key := range []string{"EnablePublicSharing", "EnableSubtitleManagement", "EnableMediaConversion"} {
		policy[key] = false
	}
}

// RestrictionsMatch reports whether an observed policy keeps the restrictions
// MUM applies to Emby accounts.
func RestrictionsMatch(policy map[string]any) bool {
	return policy["IsHiddenRemotely"] == true && policy["EnablePublicSharing"] == false && policy["EnableSubtitleManagement"] == false && policy["EnableMediaConversion"] == false
}

// verify re-inspects the account and reports whether the grant and
// restrictions match; err is a failed inspection.
func (s *Server) verify(ctx context.Context, id, name string, grant provider.Grant, disabled bool) (bool, error) {
	user, err := s.InspectAccount(ctx, id, name)
	if err != nil {
		return false, err
	}
	policy := mediabrowser.PolicyOf(user)
	return !user.Absent && mediabrowser.GrantMatches(policy, grant, disabled) && RestrictionsMatch(policy), nil
}

func (s *Server) setPassword(ctx context.Context, id, password string) error {
	return s.Request(ctx, http.MethodPost, "/Users/"+url.PathEscape(id)+"/Password", map[string]any{"NewPw": password, "ResetPassword": false}, nil)
}

// ProvisionAccount creates the account by name (Emby's create request takes no
// password or disabled policy, so it cannot create a disabled account
// atomically), records the returned ID, writes the grant and restrictions
// while disabled, sets the password, then enables it, verifying each stage.
func (s *Server) ProvisionAccount(ctx context.Context, username, password string, grant provider.Grant, checkpoint func(stage, remoteID string) error) error {
	if !grant.AllLibraries && len(grant.LibraryIDs) == 0 {
		return errors.New("unsupported provisioning grant")
	}
	if err := checkpoint("creating", ""); err != nil {
		return err
	}
	var created struct {
		ID     string `json:"Id"`
		Name   string
		Policy map[string]any
	}
	if err := s.Request(ctx, http.MethodPost, "/Users/New", map[string]string{"Name": username}, &created); err != nil {
		return err
	}
	if !provider.ValidID(created.ID) {
		return errors.New("invalid created user identity")
	}
	if err := checkpoint("configuring", created.ID); err != nil {
		return err
	}
	if created.Name != username || created.Policy == nil || created.Policy["IsAdministrator"] != false {
		return errors.New("created user identity or policy is unsafe")
	}
	if _, ok := created.Policy["IsDisabled"].(bool); !ok {
		return errors.New("created user disabled policy missing")
	}
	policy := created.Policy
	mediabrowser.ApplyGrant(policy, grant)
	applyRestrictions(policy)
	if err := s.SetPolicy(ctx, created.ID, policy); err != nil {
		return err
	}
	if ok, err := s.verify(ctx, created.ID, username, grant, true); err != nil {
		return err
	} else if !ok {
		return errors.New("disabled user policy verification failed")
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
	policy["IsDisabled"] = false
	if err := s.SetPolicy(ctx, created.ID, policy); err != nil {
		return err
	}
	if ok, err := s.verify(ctx, created.ID, username, grant, false); err != nil {
		return err
	} else if !ok {
		return errors.New("created user policy verification failed")
	}
	return checkpoint("remote_completed", created.ID)
}

// ResumeAccount finishes an interrupted setup: write the grant and
// restrictions while disabled and verify, set the password, then enable and
// verify.
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
	applyRestrictions(policy)
	if err := s.SetPolicy(ctx, user.ID, policy); err != nil {
		return err
	}
	if ok, err := s.verify(ctx, user.ID, target.RemoteName, target.Grant, true); err != nil {
		return err
	} else if !ok {
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
	policy["IsDisabled"] = false
	if err := s.SetPolicy(ctx, user.ID, policy); err != nil {
		return err
	}
	if ok, err := s.verify(ctx, user.ID, target.RemoteName, target.Grant, false); err != nil {
		return err
	} else if !ok {
		return provider.ErrConflict
	}
	return checkpoint("verified")
}
