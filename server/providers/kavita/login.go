package kavita

import (
	"context"
	"errors"
	"net/http"
	"strconv"

	"app/server/providers/provider"
)

// VerifyLogin checks a user's own username and password with Kavita. Kavita
// has no sign-out call, so the session it opens expires on its own; its
// tokens are never kept or returned.
func (s *Server) VerifyLogin(ctx context.Context, username, password string) (provider.VerifiedLogin, error) {
	var answer struct {
		ID       *int64 `json:"id"`
		Username string `json:"username"`
	}
	err := s.transport.JSON(ctx, http.MethodPost, s.url+"/api/Account/login", nil, map[string]string{"username": username, "password": password, "apiKey": ""}, &answer)
	if err != nil {
		return provider.VerifiedLogin{}, provider.LoginRefused(err)
	}
	if answer.ID == nil || *answer.ID < 1 {
		return provider.VerifiedLogin{}, errors.New("server login answer lacks a user ID")
	}
	return provider.VerifiedLogin{ID: strconv.FormatInt(*answer.ID, 10), Name: answer.Username}, nil
}
