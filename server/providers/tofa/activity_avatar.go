package tofa

import (
	"app/server/providers/provider"
	"context"
	"net/http"
	"regexp"
	"strings"
)

// UserAvatarImage uses the account's primary profile, not an arbitrary
// household member's playback profile.
func (s *Server) UserAvatarImage(ctx context.Context, user string) (string, []byte, error) {
	if !uuid.MatchString(user) {
		return "", nil, provider.ErrCatalogueUnsupported
	}
	var profiles []struct {
		User    string  `json:"user_id"`
		Primary *bool   `json:"is_primary"`
		Avatar  *string `json:"avatar_ref"`
	}
	if err := s.get(ctx, "/api/v1/users/"+user+"/profiles", &profiles); err != nil {
		return "", nil, err
	}
	if profiles == nil || len(profiles) > 1000 {
		return "", nil, provider.ErrCatalogueUnsupported
	}
	avatar := ""
	found := false
	for _, p := range profiles {
		if p.Primary != nil && *p.Primary {
			if found || !strings.EqualFold(p.User, user) {
				return "", nil, provider.ErrCatalogueUnsupported
			}
			found = true
			if p.Avatar != nil {
				avatar = *p.Avatar
			}
		}
	}
	return s.ActivityAvatarImage(ctx, avatar)
}

var presetAvatar = regexp.MustCompile(`^preset:[A-Za-z0-9_-]{1,64}$`)

func ValidActivityAvatar(descriptor string) bool { return presetAvatar.MatchString(descriptor) }

// profileAvatar only accepts a preset belonging to the exact session user and
// profile. Provider failures leave artwork absent; authority failures stop work.
func (s *Server) profileAvatar(ctx context.Context, user, profile string) (string, error) {
	var profiles []struct {
		ID     string  `json:"id"`
		User   string  `json:"user_id"`
		Avatar *string `json:"avatar_ref"`
	}
	if err := s.get(ctx, "/api/v1/users/"+user+"/profiles", &profiles); err != nil {
		if ctx.Err() != nil {
			return "", ctx.Err()
		}
		if s.transport.Guard != nil {
			if e := s.transport.Guard(ctx); e != nil {
				return "", e
			}
		}
		return "", nil
	}
	if profiles == nil || len(profiles) > 1000 {
		return "", nil
	}
	found := false
	avatar := ""
	for _, p := range profiles {
		if strings.EqualFold(p.ID, profile) {
			if found || !strings.EqualFold(p.User, user) {
				return "", nil
			}
			found = true
			if p.Avatar != nil && ValidActivityAvatar(*p.Avatar) {
				avatar = *p.Avatar
			}
		}
	}
	return avatar, nil
}

func (s *Server) ActivityAvatarImage(ctx context.Context, descriptor string) (string, []byte, error) {
	if !ValidActivityAvatar(descriptor) {
		return "", nil, provider.ErrCatalogueUnsupported
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, s.url+"/api/v1/profiles/avatars/"+strings.TrimPrefix(descriptor, "preset:")+".png", nil)
	if err != nil {
		return "", nil, provider.ErrCatalogueUnsupported
	}
	req.Header.Set("Accept", "image/png")
	req.Header.Set("Authorization", "Bearer "+s.key)
	client := *s.transport.Client
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	transport := s.transport
	transport.Client = &client
	return transport.Fetch(req, provider.CatalogueImageMax, func(kind string) bool { return kind == "image/png" })
}
