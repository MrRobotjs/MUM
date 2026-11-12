package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// overseerrClient is a compiled read client for one Overseerr instance attached
// to a Plex server. Redirects are refused so the API key never leaves the
// configured origin, and every response is size-bounded.
type overseerrClient struct {
	base   string
	key    string
	client *http.Client
}

func validateOverseerrConfig(rawURL, key string) error {
	u, err := url.Parse(rawURL)
	if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") || u.User != nil || u.RawQuery != "" || u.Fragment != "" || len(rawURL) > 512 {
		return errors.New("use an HTTP or HTTPS Overseerr URL without credentials, query or fragment")
	}
	if strings.TrimSpace(key) == "" || len(key) > 4096 || strings.ContainsAny(key, "\r\n") {
		return errors.New("a valid Overseerr API key is required")
	}
	return nil
}

func newOverseerrClient(rawURL, key string, client *http.Client) (*overseerrClient, error) {
	rawURL = strings.TrimRight(strings.TrimSpace(rawURL), "/")
	if err := validateOverseerrConfig(rawURL, key); err != nil {
		return nil, err
	}
	if client == nil {
		client = &http.Client{Timeout: 8 * time.Second}
	}
	copied := *client
	copied.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	return &overseerrClient{base: rawURL, key: key, client: &copied}, nil
}

func (c *overseerrClient) get(ctx context.Context, path string, query url.Values, out any) error {
	target := c.base + path
	if len(query) > 0 {
		target += "?" + query.Encode()
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		return err
	}
	req.Header.Set("X-Api-Key", c.key)
	req.Header.Set("Accept", "application/json")
	response, err := c.client.Do(req)
	if err != nil {
		return errors.New("Overseerr request failed or timed out")
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return &providerHTTPError{StatusCode: response.StatusCode}
	}
	const max = 4 << 20
	body, err := io.ReadAll(io.LimitReader(response.Body, max+1))
	if err != nil || len(body) > max {
		return errors.New("Overseerr response exceeds size limit or could not be read")
	}
	if err = json.Unmarshal(body, out); err != nil {
		return errors.New("Overseerr returned malformed JSON")
	}
	return nil
}

// overseerrMessage maps upstream failures to fixed text; upstream bodies are
// never echoed because they can carry configuration details.
func overseerrMessage(err error) string {
	var status *providerHTTPError
	if errors.As(err, &status) {
		switch status.StatusCode {
		case 401:
			return "Invalid Overseerr API key"
		case 403:
			return "The Overseerr API key lacks user management permission"
		}
		return "Overseerr returned HTTP " + strconv.Itoa(status.StatusCode)
	}
	if err == nil {
		return ""
	}
	return "Overseerr is unreachable or returned an unexpected response"
}

type overseerrPage struct {
	PageInfo *struct {
		Results *int `json:"results"`
	} `json:"pageInfo"`
	Results *[]json.RawMessage `json:"results"`
}

// test verifies the public status endpoint and an authenticated user read,
// which is the permission link refresh needs.
func (c *overseerrClient) test(ctx context.Context) (string, int, error) {
	var status struct {
		Version string `json:"version"`
	}
	if err := c.get(ctx, "/api/v1/status", nil, &status); err != nil {
		return "", 0, err
	}
	if status.Version == "" || len(status.Version) > 64 {
		return "", 0, errors.New("Overseerr status lacks a version")
	}
	var page overseerrPage
	if err := c.get(ctx, "/api/v1/user", url.Values{"take": {"1"}, "skip": {"0"}}, &page); err != nil {
		return "", 0, err
	}
	if page.PageInfo == nil || page.PageInfo.Results == nil || *page.PageInfo.Results < 0 || page.Results == nil {
		return "", 0, errors.New("Overseerr user page is incomplete")
	}
	return status.Version, *page.PageInfo.Results, nil
}

type overseerrUser struct {
	ID       int64  `json:"id"`
	PlexID   *int64 `json:"plexId"`
	Username string `json:"username"`
	Display  string `json:"displayName"`
	Email    string `json:"email"`
}

const overseerrUserLimit = 10000

// users reads every Overseerr user. A missing page, a short page before the
// reported total, duplicates or an oversized directory fail the whole read:
// an incomplete snapshot must never look like "nobody is linked".
func (c *overseerrClient) users(ctx context.Context) ([]overseerrUser, error) {
	all := []overseerrUser{}
	ids, plexIDs := map[int64]bool{}, map[int64]bool{}
	total := -1
	for skip := 0; total < 0 || skip < total; {
		var page overseerrPage
		if err := c.get(ctx, "/api/v1/user", url.Values{"take": {"100"}, "skip": {strconv.Itoa(skip)}, "sort": {"created"}}, &page); err != nil {
			return nil, err
		}
		if page.PageInfo == nil || page.PageInfo.Results == nil || page.Results == nil {
			return nil, errors.New("Overseerr user page is incomplete")
		}
		if total < 0 {
			total = *page.PageInfo.Results
			if total < 0 || total > overseerrUserLimit {
				return nil, errors.New("Overseerr user directory is too large")
			}
		} else if *page.PageInfo.Results != total {
			return nil, errors.New("Overseerr users changed during the read")
		}
		if len(*page.Results) == 0 && skip < total {
			return nil, errors.New("Overseerr user pages ended early")
		}
		for _, raw := range *page.Results {
			var user overseerrUser
			if err := json.Unmarshal(raw, &user); err != nil || user.ID < 1 || ids[user.ID] || len(user.Username) > 255 || len(user.Display) > 255 || len(user.Email) > 320 {
				return nil, errors.New("Overseerr user record is invalid")
			}
			ids[user.ID] = true
			if user.PlexID != nil {
				if *user.PlexID < 1 || plexIDs[*user.PlexID] {
					return nil, errors.New("Overseerr Plex account reference is ambiguous")
				}
				plexIDs[*user.PlexID] = true
			}
			all = append(all, user)
		}
		skip += len(*page.Results)
		if skip > total {
			return nil, errors.New("Overseerr returned more users than reported")
		}
	}
	return all, nil
}

func (u overseerrUser) name() string {
	if u.Display != "" {
		return u.Display
	}
	return u.Username
}

// overseerrRequestDTO keeps only the fields the profile card renders.
type overseerrRequestDTO struct {
	ID        int64             `json:"id"`
	Status    int               `json:"status"`
	Type      string            `json:"type"`
	CreatedAt string            `json:"createdAt"`
	Media     overseerrMediaDTO `json:"media"`
}
type overseerrMediaDTO struct {
	MediaType string               `json:"mediaType"`
	TMDBID    int64                `json:"tmdbId"`
	Status    int                  `json:"status"`
	Details   *overseerrDetailsDTO `json:"details,omitempty"`
}
type overseerrDetailsDTO struct {
	Title         string  `json:"title,omitempty"`
	Name          string  `json:"name,omitempty"`
	OriginalTitle string  `json:"originalTitle,omitempty"`
	OriginalName  string  `json:"originalName,omitempty"`
	ReleaseDate   string  `json:"releaseDate,omitempty"`
	FirstAirDate  string  `json:"firstAirDate,omitempty"`
	PosterPath    string  `json:"posterPath,omitempty"`
	BackdropPath  string  `json:"backdropPath,omitempty"`
	Overview      string  `json:"overview,omitempty"`
	VoteAverage   float64 `json:"voteAverage,omitempty"`
}

const overseerrRecentRequests = 5

// recentRequests returns a sanitized first page of one user's requests. Media
// details are best effort: a failed detail read leaves the request untitled.
func (c *overseerrClient) recentRequests(ctx context.Context, user int64) ([]overseerrRequestDTO, map[string]any, error) {
	var page struct {
		PageInfo *struct {
			Results *int `json:"results"`
			Pages   int  `json:"pages"`
		} `json:"pageInfo"`
		Results *[]struct {
			ID        int64  `json:"id"`
			Status    int    `json:"status"`
			Type      string `json:"type"`
			CreatedAt string `json:"createdAt"`
			Media     *struct {
				MediaType string `json:"mediaType"`
				TMDBID    int64  `json:"tmdbId"`
				Status    int    `json:"status"`
			} `json:"media"`
		} `json:"results"`
	}
	query := url.Values{"take": {strconv.Itoa(overseerrRecentRequests)}, "skip": {"0"}, "filter": {"all"}, "sort": {"added"}, "requestedBy": {strconv.FormatInt(user, 10)}}
	if err := c.get(ctx, "/api/v1/request", query, &page); err != nil {
		return nil, nil, err
	}
	if page.PageInfo == nil || page.PageInfo.Results == nil || page.Results == nil || len(*page.Results) > overseerrRecentRequests {
		return nil, nil, errors.New("Overseerr request page is incomplete")
	}
	out := []overseerrRequestDTO{}
	for _, row := range *page.Results {
		if row.ID < 1 || len(row.Type) > 16 || len(row.CreatedAt) > 64 {
			return nil, nil, errors.New("Overseerr request record is invalid")
		}
		item := overseerrRequestDTO{ID: row.ID, Status: row.Status, Type: row.Type, CreatedAt: row.CreatedAt}
		if row.Media != nil && (row.Media.MediaType == "movie" || row.Media.MediaType == "tv") && row.Media.TMDBID > 0 {
			item.Media = overseerrMediaDTO{MediaType: row.Media.MediaType, TMDBID: row.Media.TMDBID, Status: row.Media.Status}
			var details overseerrDetailsDTO
			if c.get(ctx, "/api/v1/"+row.Media.MediaType+"/"+strconv.FormatInt(row.Media.TMDBID, 10), nil, &details) == nil {
				details.trim()
				item.Media.Details = &details
			}
		}
		out = append(out, item)
	}
	total := *page.PageInfo.Results
	pagination := map[string]any{"current_page": 1, "total_pages": page.PageInfo.Pages, "total_results": total, "results_per_page": overseerrRecentRequests, "has_next": total > overseerrRecentRequests, "has_prev": false}
	return out, pagination, nil
}

// Upstream detail text is bounded before it reaches a browser.
func (d *overseerrDetailsDTO) trim() {
	for _, field := range []*string{&d.Title, &d.Name, &d.OriginalTitle, &d.OriginalName, &d.ReleaseDate, &d.FirstAirDate, &d.PosterPath, &d.BackdropPath} {
		if len(*field) > 255 {
			*field = ""
		}
	}
	if len(d.Overview) > 2000 {
		d.Overview = strings.ToValidUTF8(d.Overview[:2000], "")
	}
	// Poster paths are rendered as TMDB image paths, never as arbitrary URLs.
	for _, path := range []*string{&d.PosterPath, &d.BackdropPath} {
		if *path != "" && (!strings.HasPrefix(*path, "/") || strings.ContainsAny(*path, ":?#\\") || strings.Contains(*path, "//")) {
			*path = ""
		}
	}
}
