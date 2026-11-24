package tofa

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"

	"app/server/providers/provider"
)

var episodeStillPath = regexp.MustCompile(`^images/stills/[A-Za-z0-9_-]{1,128}\.(jpg|jpeg|png|webp|gif)$`)

func (s *Server) CatalogueImage(ctx context.Context, item, tag string) (string, []byte, error) {
	if !uuid.MatchString(item) || (tag != "poster" && !episodeStillPath.MatchString(tag)) {
		return "", nil, provider.ErrCatalogueUnsupported
	}
	path := "/api/v1/artwork/" + item + "/poster"
	if tag != "poster" {
		path = "/cache/" + tag
	}
	target, err := url.Parse(s.url + path)
	if err != nil || target.User != nil {
		return "", nil, errors.New("invalid Tofa image request")
	}
	origin := *target
	client := *s.transport.Client
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	guard := func() error {
		if s.transport.Guard != nil {
			return s.transport.Guard(ctx)
		}
		return nil
	}
	for redirects := 0; redirects <= 2; redirects++ {
		if err := guard(); err != nil {
			return "", nil, err
		}
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, target.String(), nil)
		if err != nil {
			return "", nil, errors.New("invalid Tofa image request")
		}
		req.Header.Set("Authorization", "Bearer "+s.key)
		req.Header.Set("Accept", "image/*")
		response, err := client.Do(req)
		if authErr := guard(); authErr != nil {
			if response != nil {
				response.Body.Close()
			}
			return "", nil, authErr
		}
		if err != nil {
			if response != nil {
				response.Body.Close()
			}
			return "", nil, provider.ErrRequestFailed
		}
		if response.StatusCode >= 300 && response.StatusCode < 400 {
			next, locErr := response.Location()
			response.Body.Close()
			if locErr != nil || next.User != nil || next.Scheme != origin.Scheme || !strings.EqualFold(next.Host, origin.Host) || next.Fragment != "" {
				return "", nil, errors.New("unsafe Tofa image redirect")
			}
			target = next
			continue
		}
		if response.StatusCode != http.StatusOK {
			response.Body.Close()
			return "", nil, &provider.HTTPError{StatusCode: response.StatusCode}
		}
		kind := strings.ToLower(strings.TrimSpace(strings.Split(response.Header.Get("Content-Type"), ";")[0]))
		if !provider.ImageType(kind) {
			response.Body.Close()
			return "", nil, provider.ErrUnsupportedType
		}
		body, readErr := io.ReadAll(io.LimitReader(response.Body, provider.CatalogueImageMax+1))
		response.Body.Close()
		if readErr != nil || len(body) == 0 || len(body) > provider.CatalogueImageMax {
			return "", nil, provider.ErrUnreadableBody
		}
		if err := guard(); err != nil {
			return "", nil, err
		}
		return kind, body, nil
	}
	return "", nil, errors.New("too many Tofa image redirects")
}
