package mediabrowser

import (
	"context"
	"errors"
	"net/http"
	"net/url"

	"app/server/providers/provider"
)

// Jellyfin Quick Connect: the user approves a short code in a Jellyfin app
// where they are already signed in, and MUM learns which user approved it.
// None of these calls sends the server API key.

func identifyClient(header http.Header) {
	header.Set("Authorization", loginClient)
	header.Set("X-Emby-Authorization", loginClient)
}

func httpStatus(err error) int {
	var status *provider.HTTPError
	if errors.As(err, &status) {
		return status.StatusCode
	}
	return 0
}

// StartQuickConnect asks the server for a new Quick Connect request.
func (s *Server) StartQuickConnect(ctx context.Context) (provider.QuickConnectRequest, error) {
	var answer struct {
		Secret string `json:"Secret"`
		Code   string `json:"Code"`
	}
	err := s.transport.JSON(ctx, http.MethodPost, s.base+"/QuickConnect/Initiate", identifyClient, nil, &answer)
	if httpStatus(err) == http.StatusUnauthorized {
		return provider.QuickConnectRequest{}, provider.ErrQuickConnectOff
	}
	if err != nil {
		return provider.QuickConnectRequest{}, err
	}
	if answer.Secret == "" || len(answer.Secret) > 512 || answer.Code == "" || len(answer.Code) > 32 {
		return provider.QuickConnectRequest{}, errors.New("Quick Connect answer lacks a code")
	}
	return provider.QuickConnectRequest{Secret: answer.Secret, Code: answer.Code}, nil
}

// CheckQuickConnect reports whether the user has approved the request.
func (s *Server) CheckQuickConnect(ctx context.Context, secret string) (bool, error) {
	var answer struct {
		Authenticated bool `json:"Authenticated"`
	}
	err := s.transport.JSON(ctx, http.MethodGet, s.base+"/QuickConnect/Connect?secret="+url.QueryEscape(secret), identifyClient, nil, &answer)
	if httpStatus(err) == http.StatusNotFound {
		return false, provider.ErrQuickConnectExpired
	}
	return answer.Authenticated, err
}

// FinishQuickConnect completes an approved request, returns the user who
// approved it and immediately ends the session the server opened for it.
func (s *Server) FinishQuickConnect(ctx context.Context, secret string) (provider.VerifiedLogin, error) {
	var answer struct {
		User *struct {
			ID   string `json:"Id"`
			Name string `json:"Name"`
		} `json:"User"`
		AccessToken string `json:"AccessToken"`
	}
	err := s.transport.JSON(ctx, http.MethodPost, s.base+"/Users/AuthenticateWithQuickConnect", identifyClient, map[string]string{"Secret": secret}, &answer)
	if status := httpStatus(err); status == http.StatusBadRequest || status == http.StatusUnauthorized || status == http.StatusForbidden || status == http.StatusNotFound {
		return provider.VerifiedLogin{}, provider.ErrQuickConnectExpired
	}
	if err != nil {
		return provider.VerifiedLogin{}, err
	}
	if answer.AccessToken != "" {
		s.endSession(ctx, answer.AccessToken)
	}
	if answer.User == nil || CanonicalUserID(answer.User.ID) == "" {
		return provider.VerifiedLogin{}, errors.New("Quick Connect answer lacks a user ID")
	}
	return provider.VerifiedLogin{ID: CanonicalUserID(answer.User.ID), Name: answer.User.Name}, nil
}
