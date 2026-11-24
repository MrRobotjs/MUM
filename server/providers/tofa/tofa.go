// Package tofa implements the read-only account sync for a Tofa server.
package tofa

import (
	"context"
	"errors"
	"net/http"
	"regexp"
	"strings"
	"time"

	"app/server/providers/provider"
)

var Definition = provider.Definition{ID: "tofa", Name: "Tofa", Description: "Synchronize user accounts from a Tofa media server."}
var uuid = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)

type Server struct {
	url, key  string
	transport provider.Transport
}

func New(cfg provider.Config) *Server {
	return &Server{strings.TrimRight(cfg.URL, "/"), cfg.APIKey, cfg.Transport}
}
func (s *Server) get(ctx context.Context, path string, out any) error {
	return s.transport.JSON(ctx, http.MethodGet, s.url+path, func(h http.Header) { h.Set("Authorization", "Bearer "+s.key) }, nil, out)
}

func (s *Server) Health(ctx context.Context) (provider.Info, error) {
	var info struct {
		Version string `json:"version"`
	}
	if err := s.get(ctx, "/api/v1/system/info", &info); err != nil {
		return provider.Info{}, err
	}
	if !provider.ValidText(info.Version, 128) {
		return provider.Info{}, errors.New("invalid Tofa server information")
	}
	return provider.Info{Name: "Tofa", Version: info.Version}, nil
}

func (s *Server) Test(ctx context.Context) (provider.Info, error) {
	info, err := s.Health(ctx)
	if err != nil {
		return provider.Info{}, err
	}
	if _, err := s.Users(ctx); err != nil {
		return provider.Info{}, err
	}
	return info, nil
}

// Libraries requests all server libraries rather than the administrator's
// active profile, whose access may be narrower than the server's catalogue.
func (s *Server) Libraries(ctx context.Context) ([]provider.Library, error) {
	var rows []struct {
		ID          string `json:"id"`
		Name        string `json:"name"`
		MediaType   string `json:"media_type"`
		LibraryKind string `json:"library_kind"`
	}
	if err := s.get(ctx, "/api/v1/libraries?all=true", &rows); err != nil {
		return nil, err
	}
	if rows == nil || len(rows) > 10000 {
		return nil, errors.New("invalid Tofa library snapshot")
	}
	result := make([]provider.Library, 0, len(rows))
	seen := make(map[string]bool, len(rows))
	for _, row := range rows {
		id := strings.ToLower(row.ID)
		if !uuid.MatchString(row.ID) || !provider.ValidText(row.Name, 255) || seen[id] {
			return nil, errors.New("invalid Tofa library snapshot")
		}
		kind := row.MediaType
		switch kind {
		case "movie", "other":
		case "tv":
			kind = "show"
		default:
			return nil, errors.New("unsupported Tofa library type")
		}
		if row.LibraryKind == "mixed" {
			kind = "mixed"
		}
		seen[id] = true
		result = append(result, provider.Library{ID: id, Name: row.Name, Type: kind})
	}
	return result, nil
}

func (s *Server) Users(ctx context.Context) ([]provider.User, error) {
	var rows []struct {
		ID          string          `json:"id"`
		Username    string          `json:"username"`
		Disabled    *bool           `json:"disabled"`
		Removed     bool            `json:"removed"`
		Email       *string         `json:"email"`
		CreatedAt   *string         `json:"created_at"`
		Preferences *map[string]any `json:"preferences"`
	}
	if err := s.get(ctx, "/api/v1/users", &rows); err != nil {
		return nil, err
	}
	if rows == nil || len(rows) > 10000 {
		return nil, errors.New("invalid Tofa user snapshot")
	}
	result := make([]provider.User, 0, len(rows))
	seen := make(map[string]bool, len(rows))
	for _, u := range rows {
		id := strings.ToLower(u.ID)
		if !uuid.MatchString(u.ID) || !provider.ValidText(u.Username, 255) || u.Disabled == nil || u.Preferences == nil || seen[id] {
			return nil, errors.New("invalid Tofa user snapshot")
		}
		seen[id] = true
		item := provider.User{ID: id, Name: u.Username, Active: !*u.Disabled && !u.Removed, Access: &provider.UserAccess{LibrariesKnown: false}}
		if u.Email != nil && provider.ValidText(*u.Email, 255) {
			item.Email = *u.Email
		}
		if u.CreatedAt != nil {
			if when, err := time.Parse(time.RFC3339, *u.CreatedAt); err == nil {
				item.Profile = &provider.UserProfile{JoinDate: when.UTC().Format(time.RFC3339)}
			}
		}
		result = append(result, item)
	}
	return result, nil
}
