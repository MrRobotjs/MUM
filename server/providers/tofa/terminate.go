package tofa

import (
	"context"
	"errors"
	"net/http"

	"app/server/providers/provider"
)

// TerminateSession stops one active Tofa playback session. Tofa does not
// support a viewer message on this endpoint.
func (s *Server) TerminateSession(ctx context.Context, session, message string) error {
	if !uuid.MatchString(session) {
		return provider.ErrSessionGone
	}
	if message != "" {
		return provider.ErrTerminateRefused
	}
	err := s.transport.JSON(ctx, http.MethodDelete, s.url+"/api/v1/system/playback/sessions/"+session, func(h http.Header) { h.Set("Authorization", "Bearer "+s.key) }, nil, nil)
	var status *provider.HTTPError
	if errors.As(err, &status) {
		switch status.StatusCode {
		case http.StatusNotFound:
			return provider.ErrSessionGone
		case http.StatusUnauthorized, http.StatusForbidden:
			return provider.ErrTerminateRefused
		}
	}
	return err
}
