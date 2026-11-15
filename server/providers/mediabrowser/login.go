package mediabrowser

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"time"

	"app/server/providers/provider"
)

// loginClient identifies MUM to the server when it checks a user's own login.
// Jellyfin reads Authorization, Emby X-Emby-Authorization; both carry it.
const loginClient = `MediaBrowser Client="MUM", Device="MUM", DeviceId="mum-sign-in", Version="1"`

// CanonicalUserID is the form user IDs are compared in: the servers write the
// same GUID with or without dashes and in either case.
func CanonicalUserID(id string) string {
	return strings.ToLower(strings.ReplaceAll(id, "-", ""))
}

// VerifyLogin checks a user's own username and password with the server and
// immediately ends the session the server opened for it. The server API key
// is not sent, and the session token is never returned.
func (s *Server) VerifyLogin(ctx context.Context, username, password string) (provider.VerifiedLogin, error) {
	var answer struct {
		User *struct {
			ID   string `json:"Id"`
			Name string `json:"Name"`
		} `json:"User"`
		AccessToken string `json:"AccessToken"`
	}
	identify := func(header http.Header) {
		header.Set("Authorization", loginClient)
		header.Set("X-Emby-Authorization", loginClient)
	}
	err := s.transport.JSON(ctx, http.MethodPost, s.base+"/Users/AuthenticateByName", identify, map[string]string{"Username": username, "Pw": password}, &answer)
	if err != nil {
		return provider.VerifiedLogin{}, provider.LoginRefused(err)
	}
	if answer.AccessToken != "" {
		s.endSession(ctx, answer.AccessToken)
	}
	if answer.User == nil || CanonicalUserID(answer.User.ID) == "" {
		return provider.VerifiedLogin{}, errors.New("server login answer lacks a user ID")
	}
	return provider.VerifiedLogin{ID: CanonicalUserID(answer.User.ID), Name: answer.User.Name}, nil
}

// endSession signs the user's new server session out again. It is best effort:
// the login has already been verified, and a failure leaves only a session the
// server will expire.
func (s *Server) endSession(ctx context.Context, token string) {
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer cancel()
	_ = s.transport.JSON(ctx, http.MethodPost, s.base+"/Sessions/Logout", func(header http.Header) {
		header.Set("X-Emby-Token", token)
		header.Set("Authorization", loginClient+`, Token="`+token+`"`)
	}, nil, nil)
}
