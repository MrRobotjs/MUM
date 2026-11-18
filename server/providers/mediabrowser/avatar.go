package mediabrowser

import (
	"context"
	"errors"
	"net/http"
	"net/url"

	"app/server/providers/provider"
)

// ErrNoAvatar means the user has no profile picture on the server.
var ErrNoAvatar = errors.New("user has no profile picture")

// maxAvatarBytes bounds one profile picture.
const maxAvatarBytes = 5 << 20

// UserAvatarImage reads a user's profile picture, scaled down by the server,
// for the account pages' linked-account lists. It only reads.
func (s *Server) UserAvatarImage(ctx context.Context, user string) (string, []byte, error) {
	if !ValidToken(user) {
		return "", nil, errors.New("invalid user ID")
	}
	target := s.base + "/Users/" + user + "/Images/Primary?" + url.Values{"maxWidth": {"256"}, "quality": {"90"}}.Encode()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		return "", nil, errors.New("invalid provider request")
	}
	req.Header.Set("Accept", "image/*")
	s.authorize(req.Header)
	kind, body, err := s.transport.Fetch(req, maxAvatarBytes, provider.ImageType)
	var status *provider.HTTPError
	switch {
	case errors.As(err, &status) && status.StatusCode == http.StatusNotFound:
		return "", nil, ErrNoAvatar
	case errors.Is(err, provider.ErrUnsupportedType):
		return "", nil, errors.New("provider returned an unsupported image type")
	case errors.Is(err, provider.ErrUnreadableBody):
		return "", nil, errors.New("provider image exceeds size limit or could not be read")
	case err != nil:
		return "", nil, err
	}
	return kind, body, nil
}
