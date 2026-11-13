package main

import (
	"app/server/providers/provider"
	"context"
	"errors"
	"net/http"
	"net/url"
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
// The list comes from the module registry (provider_registry.go), in its order.
var compiledProviders = func() []ProviderDefinition {
	list := make([]ProviderDefinition, 0, len(mediaModules))
	for _, m := range mediaModules {
		list = append(list, definitionFromModule(m.Definition))
	}
	return list
}()

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

// The core uses the shared module types under its own names. They are
// aliases, not copies, so values cross the module boundary unconverted; the
// names stay because many core functions call a local variable "provider".
type (
	ProviderInfo             = provider.Info
	ProviderLibrary          = provider.Library
	ProviderUser             = provider.User
	ProviderUserAccess       = provider.UserAccess
	ProviderUserProfile      = provider.UserProfile
	ProviderUserRelationship = provider.UserRelationship
	InvitationGrant          = provider.Grant
	remoteReview             = provider.Account
	catalogueItem            = provider.CatalogueItem
	catalogueCollection      = provider.CatalogueCollection
)

// serverConnection is the core's connection to one configured media server: its
// settings, HTTP client and the authority checks attached to the current
// operation. Every service feature is reached through its module (module()).
type serverConnection struct {
	locations       *provider.LocationCache
	config          ProviderConfig
	client          *http.Client
	plexClientID    string
	reviewAuthority *reviewRequestAuthority
	// Attached only to owner-initiated service remote access operations.
	serviceAuthority *serviceRemoteAuthority
	editAuthority    func(context.Context) error
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
func newServerConnection(c ProviderConfig, client *http.Client) (*serverConnection, error) {
	if err := validateProviderConfig(c); err != nil {
		return nil, err
	}
	if client == nil {
		client = &http.Client{Timeout: 8 * time.Second}
	}
	// A redirect must never forward provider credentials to a different endpoint.
	copyClient := *client
	copyClient.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	return &serverConnection{config: c, client: &copyClient}, nil
}
func (p *serverConnection) Test(ctx context.Context) (ProviderInfo, error) {
	if m := p.module(); m != nil {
		if tester, ok := m.(connectionTester); ok {
			info, err := tester.Test(ctx)
			return info, err
		}
		// A module without its own test is tested by reading its users.
		_, err := p.Users(ctx)
		definition, _ := providerDefinition(p.config.Type)
		return ProviderInfo{Name: definition.Name}, err
	}
	return ProviderInfo{}, errors.New("provider is not implemented")
}
func (p *serverConnection) Libraries(ctx context.Context) ([]ProviderLibrary, error) {
	if m, ok := p.module().(libraryReader); ok {
		rows, err := m.Libraries(ctx)
		if err != nil {
			return nil, err
		}
		return validateLibraries(rows)
	}
	return nil, errors.New("provider is not implemented")
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
func (p *serverConnection) Users(ctx context.Context) ([]ProviderUser, error) {
	if m, ok := p.module().(userReader); ok {
		rows, err := m.Users(ctx)
		if err != nil {
			return nil, err
		}
		return validateUsers(rows)
	}
	return nil, errors.New("provider is not implemented")
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
