package main

import (
	"context"
	"errors"
	"net/http"
	"net/url"
	"strconv"
	"strings"
)

type kavitaAgeRestriction struct {
	AgeRating       int  `json:"ageRating"`
	IncludeUnknowns bool `json:"includeUnknowns"`
}

var errKavitaCredentials = errors.New("Kavita requires a username without @ and a password of at most 256 bytes")

func kavitaLibraryIDs(grant InvitationGrant) ([]int64, error) {
	if grant.AllLibraries || len(grant.LibraryIDs) == 0 {
		return nil, ErrConflict
	}
	ids := []int64{}
	for _, value := range grant.LibraryIDs {
		id, err := strconv.ParseInt(value, 10, 32)
		if err != nil || id < 1 || strconv.FormatInt(id, 10) != value {
			return nil, ErrConflict
		}
		ids = append(ids, id)
	}
	return ids, nil
}

func kavitaRoles(downloads, enabled bool) []string {
	roles := []string{"Pleb", "Change Password"}
	if downloads {
		roles = append(roles, "Download")
	}
	if enabled {
		roles = append(roles, "Login")
	}
	return roles
}

func (p *jsonProvider) kavitaUserMatches(ctx context.Context, id int64, name string, grant InvitationGrant, enabled bool) error {
	user, err := p.inspectKavitaProvisionedUser(ctx, strconv.FormatInt(id, 10), name)
	if err != nil {
		return err
	}
	if !kavitaGrantMatches(user.Kavita, grant, enabled) {
		return ErrConflict
	}
	return nil
}

func (p *jsonProvider) provisionKavita(ctx context.Context, username, password string, grant InvitationGrant, checkpoint func(string, string) error) error {
	if p.config.Type != "kavita" {
		return ErrConflict
	}
	if strings.Contains(username, "@") || len(password) > 256 {
		return errKavitaCredentials
	}
	ids, err := kavitaLibraryIDs(grant)
	if err != nil {
		return err
	}
	if err := checkpoint("inviting", ""); err != nil {
		return err
	}
	// A username-only invitation prevents provider email delivery. Never follow
	// the returned URL: extract its bound token and call the configured API only.
	var invite struct {
		EmailLink string `json:"emailLink"`
		EmailSent bool   `json:"emailSent"`
	}
	age := kavitaAgeRestriction{-1, true}
	body := struct {
		Email          string               `json:"email"`
		Roles          []string             `json:"roles"`
		Libraries      []int64              `json:"libraries"`
		AgeRestriction kavitaAgeRestriction `json:"ageRestriction"`
	}{username, kavitaRoles(grant.AllowDownloads, false)[1:], ids, age}
	base := strings.TrimRight(p.config.URL, "/") + "/api"
	if err := p.jsonRequest(ctx, http.MethodPost, base+"/Account/invite", body, &invite); err != nil {
		return err
	}
	link, err := url.Parse(invite.EmailLink)
	if err != nil || invite.EmailSent || link == nil || link.User != nil || link.Fragment != "" || !strings.HasSuffix(link.Path, "/registration/confirm-email") {
		return ErrConflict
	}
	query, err := url.ParseQuery(link.RawQuery)
	if err != nil || len(query["email"]) != 1 || query.Get("email") != username || len(query["token"]) != 1 || len(query.Get("token")) == 0 || len(query.Get("token")) > 8192 {
		return ErrConflict
	}
	if err := checkpoint("confirming", ""); err != nil {
		return err
	}
	var confirmed struct {
		ID       int64  `json:"id"`
		Username string `json:"username"`
	}
	confirmation := struct {
		Email    string `json:"email"`
		Username string `json:"username"`
		Password string `json:"password"`
		Token    string `json:"token"`
	}{username, username, password, query.Get("token")}
	if err := p.jsonRequest(ctx, http.MethodPost, base+"/Account/confirm-email", confirmation, &confirmed); err != nil {
		return err
	}
	if confirmed.ID < 1 || confirmed.ID > 2147483647 || confirmed.Username != username {
		return ErrConflict
	}
	id := strconv.FormatInt(confirmed.ID, 10)
	if err := checkpoint("configuring", id); err != nil {
		return err
	}
	if err := p.kavitaUserMatches(ctx, confirmed.ID, username, grant, false); err != nil {
		return err
	}
	if err := checkpoint("enabling", id); err != nil {
		return err
	}
	update := struct {
		UserID           int64                `json:"userId"`
		Username         string               `json:"username"`
		Roles            []string             `json:"roles"`
		Libraries        []int64              `json:"libraries"`
		AgeRestriction   kavitaAgeRestriction `json:"ageRestriction"`
		IdentityProvider int                  `json:"identityProvider"`
	}{confirmed.ID, username, kavitaRoles(grant.AllowDownloads, true)[1:], ids, age, 0}
	if err := p.jsonRequest(ctx, http.MethodPost, base+"/Account/update", update, nil); err != nil {
		return err
	}
	if err := p.kavitaUserMatches(ctx, confirmed.ID, username, grant, true); err != nil {
		return err
	}
	return checkpoint("remote_completed", id)
}
