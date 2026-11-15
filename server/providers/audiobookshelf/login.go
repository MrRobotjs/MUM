package audiobookshelf

import (
	"context"
	"errors"
	"net/http"
	"time"

	"app/server/providers/provider"
)

// VerifyLogin checks a user's own username and password with Audiobookshelf
// and ends the session it opened. Tokens are requested in the body (not as
// cookies) so the session can be ended; they are never returned.
func (s *Server) VerifyLogin(ctx context.Context, username, password string) (provider.VerifiedLogin, error) {
	var answer struct {
		User *struct {
			ID           string `json:"id"`
			Username     string `json:"username"`
			RefreshToken string `json:"refreshToken"`
		} `json:"user"`
	}
	err := s.transport.JSON(ctx, http.MethodPost, s.url+"/login", func(header http.Header) { header.Set("x-return-tokens", "true") },
		map[string]string{"username": username, "password": password}, &answer)
	if err != nil {
		return provider.VerifiedLogin{}, provider.LoginRefused(err)
	}
	if answer.User != nil && answer.User.RefreshToken != "" {
		end, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
		defer cancel()
		token := answer.User.RefreshToken
		_ = s.transport.JSON(end, http.MethodPost, s.url+"/logout", func(header http.Header) { header.Set("x-refresh-token", token) }, nil, nil)
	}
	if answer.User == nil || answer.User.ID == "" {
		return provider.VerifiedLogin{}, errors.New("server login answer lacks a user ID")
	}
	return provider.VerifiedLogin{ID: answer.User.ID, Name: answer.User.Username}, nil
}
