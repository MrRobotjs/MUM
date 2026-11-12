package main

import (
	"context"
	"errors"
	"net/http"
	"net/url"
)

func (p *jsonProvider) provisionUser(ctx context.Context, username, password string, grant InvitationGrant, checkpoint func(string, string) error) error {
	switch p.config.Type {
	case "romm":
		return p.provisionRomMUser(ctx, username, password, grant, checkpoint)
	case "komga":
		return p.provisionKomgaUser(ctx, username, password, grant, checkpoint)
	case "audiobookshelf":
		return p.provisionABSUser(ctx, username, password, grant, checkpoint)
	case "jellyfin":
		return p.provisionJellyfin(ctx, username, password, grant, checkpoint)
	case "kavita":
		return p.provisionKavita(ctx, username, password, grant, checkpoint)
	case "emby":
		return p.provisionEmby(ctx, username, password, grant, checkpoint)
	default:
		return errors.New("unsupported provisioning provider")
	}
}

func applyEmbyRestrictions(policy map[string]any) {
	policy["IsHiddenRemotely"] = true
	for _, key := range []string{"EnablePublicSharing", "EnableSubtitleManagement", "EnableMediaConversion"} {
		policy[key] = false
	}
}

func embyRestrictionsMatch(policy map[string]any) bool {
	return policy["IsHiddenRemotely"] == true && policy["EnablePublicSharing"] == false && policy["EnableSubtitleManagement"] == false && policy["EnableMediaConversion"] == false
}

func (p *jsonProvider) setRecordedPassword(ctx context.Context, id, password string) error {
	endpoint := "/Users/Password?userId=" + url.QueryEscape(id)
	if p.config.Type == "emby" {
		endpoint = "/Users/" + url.PathEscape(id) + "/Password"
	}
	return p.mediaUserRequest(ctx, http.MethodPost, endpoint, map[string]any{"NewPw": password, "ResetPassword": false}, nil)
}

// Emby's create request accepts only a name, not a bootstrap password or disabled
// policy. Persist the returned ID before configuring it; any uncertainty retains
// the reservation for review. The API cannot guarantee atomic disabled creation.
func (p *jsonProvider) provisionEmby(ctx context.Context, username, password string, grant InvitationGrant, checkpoint func(string, string) error) error {
	if p.config.Type != "emby" || (!grant.AllLibraries && len(grant.LibraryIDs) == 0) {
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
	if err := p.mediaUserRequest(ctx, http.MethodPost, "/Users/New", map[string]string{"Name": username}, &created); err != nil {
		return err
	}
	if !validProvisionedID(created.ID) {
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
	applyMediaUserGrant(policy, grant)
	applyEmbyRestrictions(policy)
	endpoint := "/Users/" + url.PathEscape(created.ID)
	if err := p.mediaUserRequest(ctx, http.MethodPost, endpoint+"/Policy", policy, nil); err != nil {
		return err
	}
	disabled, err := p.inspectProvisionedUser(ctx, created.ID, username)
	if err != nil {
		return err
	}
	if disabled.Absent || !mediaUserGrantMatches(disabled.Policy, grant, true) || !embyRestrictionsMatch(disabled.Policy) {
		return errors.New("disabled user policy verification failed")
	}
	if err := checkpoint("setting_password", created.ID); err != nil {
		return err
	}
	if err := p.setRecordedPassword(ctx, created.ID, password); err != nil {
		return err
	}
	if err := checkpoint("enabling", created.ID); err != nil {
		return err
	}
	policy["IsDisabled"] = false
	if err := p.mediaUserRequest(ctx, http.MethodPost, endpoint+"/Policy", policy, nil); err != nil {
		return err
	}
	verified, err := p.inspectProvisionedUser(ctx, created.ID, username)
	if err != nil {
		return err
	}
	if verified.Absent || !mediaUserGrantMatches(verified.Policy, grant, false) || !embyRestrictionsMatch(verified.Policy) {
		return errors.New("created user policy verification failed")
	}
	return checkpoint("remote_completed", created.ID)
}
