package mediabrowser

import (
	"context"
	"net/http"
	"net/url"

	"app/server/providers/provider"
)

// terminateMessageTimeout is how long the player shows the message.
const terminateMessageTimeout = 10000

// TerminateSession shows message (when given) on the session's player, then
// stops its playback. A session the server no longer knows is
// provider.ErrSessionGone; a refused request is provider.ErrTerminateRefused.
func (s *Server) TerminateSession(ctx context.Context, session, message string) error {
	if !provider.ValidText(session, 256) || session == "" {
		return provider.ErrSessionGone
	}
	path := "/Sessions/" + url.PathEscape(session)
	if message != "" {
		body := map[string]any{"Header": "MUM", "Text": message, "TimeoutMs": terminateMessageTimeout}
		if err := terminateError(s.Request(ctx, http.MethodPost, path+"/Message", body, nil)); err != nil {
			return err
		}
	}
	return terminateError(s.Request(ctx, http.MethodPost, path+"/Playing/Stop", nil, nil))
}

func terminateError(err error) error {
	switch httpStatus(err) {
	case http.StatusNotFound:
		return provider.ErrSessionGone
	case http.StatusUnauthorized, http.StatusForbidden:
		return provider.ErrTerminateRefused
	}
	return err
}
