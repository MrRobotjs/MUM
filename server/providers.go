package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"time"
)

type ProviderDefinition struct {
	ID          string
	Name        string
	Description string
}

// Only implemented adapters enter the compiled registry. No Python manifests or
// uploaded code are loaded, and unimplemented capabilities are never advertised.
var compiledProviders = []ProviderDefinition{
	{"jellyfin", "Jellyfin", "Jellyfin server connection, library and user synchronization"},
	{"emby", "Emby", "Emby synchronization and local-user provisioning; newly created accounts may be accessible before password and policy setup"},
	{"kavita", "Kavita", "Kavita synchronization, username-only provisioning with selected libraries and recorded-account recovery"},
	{"plex", "Plex", "Plex library discovery and cloud sharing synchronization"},
	{"audiobookshelf", "Audiobookshelf", "Audiobookshelf library/user synchronization, restricted provisioning and recorded-account recovery"},
	{"komga", "Komga", "Komga synchronization, email-identity provisioning and media-access revocation/recovery; login can remain available"},
	{"romm", "RomM", "RomM sync and all-platform/download provisioning/recovery; creation starts enabled in its default group, and full session termination is not verified"},
}

func providerDefinition(id string) (ProviderDefinition, bool) {
	for _, p := range compiledProviders {
		if p.ID == id {
			return p, true
		}
	}
	return ProviderDefinition{}, false
}

type ProviderConfig struct {
	Type   string
	URL    string
	APIKey string
}
type ProviderInfo struct {
	Name    string `json:"name"`
	Version string `json:"version,omitempty"`
}
type ProviderLibrary struct {
	ID        string
	Name      string
	Type      string
	ItemCount *int64
}
type ProviderUserAccess struct {
	LibrariesKnown    bool
	DownloadsKnown    bool
	AllowDownloads    bool
	ContentRestricted bool
}

type ProviderUser struct {
	ID           string
	Name         string
	Email        string
	Active       bool
	AllLibraries bool
	LibraryIDs   []string
	Access       *ProviderUserAccess
	Profile      *ProviderUserProfile
}

// Optional observations are independent of access policy. Empty values mean
// unavailable, not deletion; providers can omit presentation fields on reads.
type ProviderUserProfile struct {
	AvatarURL string
	JoinDate  string
}
type MediaProvider interface {
	Test(context.Context) (ProviderInfo, error)
	Libraries(context.Context) ([]ProviderLibrary, error)
	Users(context.Context) ([]ProviderUser, error)
}
type jsonProvider struct {
	geoCache        *plexGeoCache
	config          ProviderConfig
	client          *http.Client
	plexClientID    string
	reviewAuthority *reviewRequestAuthority
	// Attached only to owner-initiated service remote access operations.
	serviceAuthority *serviceRemoteAuthority
	bulkAuthority    func(context.Context) error
}

func validateProviderConfig(c ProviderConfig) error {
	if _, ok := providerDefinition(c.Type); !ok {
		return errors.New("provider is not implemented")
	}
	u, err := url.Parse(c.URL)
	if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return errors.New("use an HTTP or HTTPS server URL without credentials, query or fragment")
	}
	if strings.TrimSpace(c.APIKey) == "" || len(c.APIKey) > 4096 || strings.ContainsAny(c.APIKey, "\r\n") {
		return errors.New("a valid API key is required")
	}
	return nil
}
func newMediaProvider(c ProviderConfig, client *http.Client) (MediaProvider, error) {
	if err := validateProviderConfig(c); err != nil {
		return nil, err
	}
	if client == nil {
		client = &http.Client{Timeout: 8 * time.Second}
	}
	// A redirect must never forward provider credentials to a different endpoint.
	copyClient := *client
	copyClient.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	return &jsonProvider{config: c, client: &copyClient}, nil
}
func (p *jsonProvider) get(ctx context.Context, endpoint string, out any) error {
	base := strings.TrimRight(p.config.URL, "/")
	prefix := ""
	if p.config.Type == "emby" && !strings.HasSuffix(base, "/emby") {
		prefix = "/emby"
	}
	if p.config.Type == "kavita" {
		prefix = "/api"
	}
	return p.jsonRequest(ctx, http.MethodGet, base+prefix+endpoint, nil, out)
}

func (p *jsonProvider) fetch(ctx context.Context, method, target string, input any) ([]byte, error) {
	var encoded []byte
	var err error
	form, isForm := input.(url.Values)
	if isForm && p.config.Type != "romm" {
		return nil, errors.New("unsupported provider form request")
	}
	if isForm {
		encoded = []byte(form.Encode())
	} else if input != nil {
		encoded, err = json.Marshal(input)
		if err != nil {
			return nil, errors.New("invalid provider request body")
		}
	}
	req, err := http.NewRequestWithContext(ctx, method, target, bytes.NewReader(encoded))
	if err != nil {
		return nil, errors.New("invalid provider request")
	}
	req.Header.Set("Accept", "application/json")
	header := "X-Emby-Token"
	if p.config.Type == "kavita" {
		header = "x-api-key"
	}
	if p.config.Type == "komga" {
		header = "X-API-Key"
	}
	if p.config.Type == "plex" {
		header = "X-Plex-Token"
		req.Header.Set("Accept", "application/xml")
		clientID := p.plexClientID
		if clientID == "" {
			clientID = "mum-go"
		}
		req.Header.Set("X-Plex-Client-Identifier", clientID)
	}
	if p.config.Type == "audiobookshelf" || p.config.Type == "romm" {
		req.Header.Set("Authorization", "Bearer "+p.config.APIKey)
	} else {
		req.Header.Set(header, p.config.APIKey)
	}
	if isForm {
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	} else if input != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if err := p.reviewAuthority.check(ctx); err != nil {
		return nil, err
	}
	if err := p.serviceAuthority.check(ctx); err != nil {
		return nil, err
	}
	if p.bulkAuthority != nil {
		if err := p.bulkAuthority(ctx); err != nil {
			return nil, err
		}
	}
	response, err := p.client.Do(req)
	if response != nil {
		defer response.Body.Close()
	}
	if p.bulkAuthority != nil {
		if authorityErr := p.bulkAuthority(ctx); authorityErr != nil {
			return nil, authorityErr
		}
	}
	if err != nil {
		return nil, errors.New("provider request failed or timed out")
	}
	if err := p.reviewAuthority.check(ctx); err != nil {
		return nil, err
	}
	if err := p.serviceAuthority.check(ctx); err != nil {
		return nil, err
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil, &providerHTTPError{StatusCode: response.StatusCode}
	}
	const max = 16 << 20
	body, err := io.ReadAll(io.LimitReader(response.Body, max+1))
	if err != nil || len(body) > max {
		return nil, errors.New("provider response exceeds size limit or could not be read")
	}
	if err := p.reviewAuthority.check(ctx); err != nil {
		return nil, err
	}
	if err := p.serviceAuthority.check(ctx); err != nil {
		return nil, err
	}
	return body, nil
}
func (p *jsonProvider) jsonRequest(ctx context.Context, method, target string, input, out any) error {
	body, err := p.fetch(ctx, method, target, input)
	if err != nil {
		return err
	}
	if out == nil {
		return nil
	}
	if err := json.Unmarshal(body, out); err != nil {
		return errors.New("provider returned invalid JSON")
	}
	return nil
}
func (p *jsonProvider) Test(ctx context.Context) (ProviderInfo, error) {
	if p.config.Type == "plex" {
		info, err := p.plexIdentity(ctx)
		if err != nil {
			return ProviderInfo{}, err
		}
		if _, err := p.Libraries(ctx); err != nil {
			return ProviderInfo{}, err
		}
		return ProviderInfo{Name: info.Name, Version: info.Version}, nil
	}
	if p.config.Type == "komga" || p.config.Type == "romm" || p.config.Type == "audiobookshelf" {
		_, err := p.Users(ctx)
		definition, _ := providerDefinition(p.config.Type)
		return ProviderInfo{Name: definition.Name}, err
	}
	if p.config.Type == "kavita" {
		_, err := p.Libraries(ctx)
		return ProviderInfo{Name: "Kavita"}, err
	}
	var info struct {
		ServerName string
		Version    string
	}
	if err := p.get(ctx, "/System/Info", &info); err != nil {
		return ProviderInfo{}, err
	}
	if info.ServerName == "" {
		return ProviderInfo{}, errors.New("provider response lacks server name")
	}
	return ProviderInfo{info.ServerName, info.Version}, nil
}
func (p *jsonProvider) Libraries(ctx context.Context) ([]ProviderLibrary, error) {
	if p.config.Type == "plex" || p.config.Type == "komga" || p.config.Type == "romm" || p.config.Type == "audiobookshelf" {
		rows, err := p.extendedLibraries(ctx)
		if err != nil {
			return nil, err
		}
		return validateLibraries(rows)
	}
	result := []ProviderLibrary{}
	if p.config.Type == "kavita" {
		var rows []struct {
			ID          *int64          `json:"id"`
			Name        string          `json:"name"`
			Type        json.RawMessage `json:"type"`
			SeriesCount *int64          `json:"seriesCount"`
		}
		if err := p.get(ctx, "/Library/libraries", &rows); err != nil {
			return nil, err
		}
		if rows == nil {
			return nil, errors.New("provider returned null library list")
		}
		for _, r := range rows {
			if r.ID == nil {
				return nil, errors.New("library is missing its ID")
			}
			kind := "book"
			if len(r.Type) > 0 {
				var value int
				if err := json.Unmarshal(r.Type, &value); err != nil {
					return nil, errors.New("invalid Kavita library type")
				}
				types := map[int]string{0: "manga", 1: "comic", 2: "book", 3: "image", 4: "light_novel", 5: "comic"}
				if name, ok := types[value]; ok {
					kind = name
				} else {
					kind = "mixed"
				}
			}
			result = append(result, ProviderLibrary{fmt.Sprint(*r.ID), r.Name, kind, r.SeriesCount})
		}
	} else {
		var rows []struct {
			ItemID         string `json:"ItemId"`
			Name           string
			CollectionType string
		}
		if err := p.get(ctx, "/Library/VirtualFolders", &rows); err != nil {
			return nil, err
		}
		if rows == nil {
			return nil, errors.New("provider returned null library list")
		}
		for _, r := range rows {
			kind := strings.ToLower(r.CollectionType)
			if kind == "" {
				kind = "mixed"
			}
			result = append(result, ProviderLibrary{r.ItemID, r.Name, kind, nil})
		}
	}
	return validateLibraries(result)
}
func validateLibraries(result []ProviderLibrary) ([]ProviderLibrary, error) {
	seen := map[string]bool{}
	if len(result) > 10000 {
		return nil, errors.New("too many libraries in one synchronization")
	}
	for _, r := range result {
		if r.ID == "" || strings.TrimSpace(r.Name) == "" || seen[r.ID] || r.ItemCount != nil && *r.ItemCount < 0 {
			return nil, errors.New("provider returned invalid or duplicate libraries")
		}
		seen[r.ID] = true
	}
	return result, nil
}
func (p *jsonProvider) Users(ctx context.Context) ([]ProviderUser, error) {
	if p.config.Type == "plex" || p.config.Type == "komga" || p.config.Type == "romm" || p.config.Type == "audiobookshelf" {
		rows, err := p.extendedUsers(ctx)
		if err != nil {
			return nil, err
		}
		return validateUsers(rows)
	}
	result := []ProviderUser{}
	if p.config.Type == "kavita" {
		var rows []struct {
			ID        *int64    `json:"id"`
			Username  string    `json:"username"`
			Email     string    `json:"email"`
			IsPending *bool     `json:"isPending"`
			Roles     *[]string `json:"roles"`
			Libraries []struct {
				ID int64 `json:"id"`
			} `json:"libraries"`
		}
		if err := p.get(ctx, "/Users", &rows); err != nil {
			return nil, err
		}
		if rows == nil {
			return nil, errors.New("provider returned null user list")
		}
		for _, r := range rows {
			if r.ID == nil || *r.ID < 1 || r.IsPending == nil || r.Roles == nil {
				return nil, errors.New("user is missing identity or access policy")
			}
			for _, role := range *r.Roles {
				if strings.TrimSpace(role) == "" {
					return nil, errors.New("invalid Kavita role observation")
				}
			}
			libraries := []string{}
			for _, l := range r.Libraries {
				libraries = append(libraries, fmt.Sprint(l.ID))
			}
			result = append(result, ProviderUser{fmt.Sprint(*r.ID), r.Username, r.Email, !*r.IsPending && (slices.Contains(*r.Roles, "Login") || slices.Contains(*r.Roles, "Admin")), false, libraries, &ProviderUserAccess{LibrariesKnown: true, DownloadsKnown: true, AllowDownloads: slices.Contains(*r.Roles, "Download") || slices.Contains(*r.Roles, "Admin")}, nil})
		}
	} else {
		var rows []struct {
			ID     string `json:"Id"`
			Name   string
			Policy *struct {
				IsDisabled               *bool
				EnableAllFolders         *bool
				EnabledFolders           []string
				EnableContentDownloading *bool
			}
		}
		if err := p.get(ctx, "/Users", &rows); err != nil {
			return nil, err
		}
		if rows == nil {
			return nil, errors.New("provider returned null user list")
		}
		for _, r := range rows {
			if r.Policy == nil || r.Policy.IsDisabled == nil || r.Policy.EnableAllFolders == nil {
				return nil, errors.New("provider returned incomplete user access policy")
			}
			libraries := r.Policy.EnabledFolders
			if libraries == nil {
				libraries = []string{}
			}
			access := &ProviderUserAccess{LibrariesKnown: true}
			if r.Policy.EnableContentDownloading != nil {
				access.DownloadsKnown = true
				access.AllowDownloads = *r.Policy.EnableContentDownloading
			}
			result = append(result, ProviderUser{r.ID, r.Name, "", !*r.Policy.IsDisabled, *r.Policy.EnableAllFolders, libraries, access, nil})
		}
	}
	return validateUsers(result)
}
func validateUsers(result []ProviderUser) ([]ProviderUser, error) {
	seen := map[string]bool{}
	if len(result) > 10000 {
		return nil, errors.New("too many users in one synchronization")
	}
	for _, r := range result {
		if r.ID == "" || strings.TrimSpace(r.Name) == "" || seen[r.ID] {
			return nil, errors.New("provider returned invalid or duplicate users")
		}
		seen[r.ID] = true
	}
	return result, nil
}
