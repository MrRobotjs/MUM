package main

import (
	"context"
	"errors"
	"net/http"
	"net/url"
	"slices"
	"strings"
)

// Invitation grants have explicit all-library semantics. An empty selection never
// silently grants access to all libraries.
type InvitationGrant struct {
	ServerID       int64    `json:"server_id"`
	AllLibraries   bool     `json:"all_libraries"`
	LibraryIDs     []string `json:"library_ids"`
	AllowDownloads bool     `json:"allow_downloads"`
}

// Plex is provisioned by sharing the server with the invitee's verified Plex
// account (plex_invitation_share.go), not by creating a local account, so it
// has no recorded-account recovery.
func supportsProvisioning(kind string) bool {
	return kind == "plex" || supportsRecordedRecovery(kind)
}

func supportsRecordedRecovery(kind string) bool {
	return kind == "jellyfin" || kind == "emby" || kind == "kavita" || kind == "audiobookshelf" || kind == "komga" || kind == "romm"
}

func validProvisionedID(id string) bool {
	if id == "" || len(id) > 255 {
		return false
	}
	for _, c := range []byte(id) {
		if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '-' || c == '_') {
			return false
		}
	}
	return true
}

func (p *jsonProvider) mediaUserRequest(ctx context.Context, method, endpoint string, body, out any) error {
	base := strings.TrimRight(p.config.URL, "/")
	if p.config.Type == "emby" && !strings.HasSuffix(base, "/emby") {
		base += "/emby"
	}
	return p.jsonRequest(ctx, method, base+endpoint, body, out)
}

// Each checkpoint commits before the next remote side effect. A failed request
// is never retried: its remote outcome may be uncertain. The caller retains the
// invitation reservation and the inactive local profile for administrator review.
func (p *jsonProvider) provisionJellyfin(ctx context.Context, username, password string, grant InvitationGrant, checkpoint func(string, string) error) error {
	if p.config.Type != "jellyfin" || (!grant.AllLibraries && len(grant.LibraryIDs) == 0) {
		return errors.New("unsupported provisioning grant")
	}
	bootstrapPassword := randomToken()
	if err := checkpoint("creating", ""); err != nil {
		return err
	}
	var created struct {
		ID string `json:"Id"`
	}
	if err := p.mediaUserRequest(ctx, http.MethodPost, "/Users/New", map[string]string{"Name": username, "Password": bootstrapPassword}, &created); err != nil {
		return err
	}
	if !validProvisionedID(created.ID) {
		return errors.New("invalid created user identity")
	}
	if err := checkpoint("configuring", created.ID); err != nil {
		return err
	}
	endpoint := "/Users/" + url.PathEscape(created.ID)
	var user struct {
		Policy map[string]any `json:"Policy"`
	}
	if err := p.mediaUserRequest(ctx, http.MethodGet, endpoint, nil, &user); err != nil {
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
	applyMediaUserGrant(policy, grant)
	if err := p.mediaUserRequest(ctx, http.MethodPost, endpoint+"/Policy", policy, nil); err != nil {
		return err
	}
	if err := checkpoint("setting_password", created.ID); err != nil {
		return err
	}
	if err := p.mediaUserRequest(ctx, http.MethodPost, "/Users/Password?userId="+url.QueryEscape(created.ID), map[string]any{"CurrentPw": bootstrapPassword, "NewPw": password, "ResetPassword": false}, nil); err != nil {
		return err
	}
	if err := checkpoint("enabling", created.ID); err != nil {
		return err
	}
	policy["IsDisabled"] = false
	if err := p.mediaUserRequest(ctx, http.MethodPost, endpoint+"/Policy", policy, nil); err != nil {
		return err
	}
	return checkpoint("remote_completed", created.ID)
}

func applyMediaUserGrant(policy map[string]any, grant InvitationGrant) {
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

func mediaUserGrantMatches(policy map[string]any, grant InvitationGrant, disabled bool) bool {
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
