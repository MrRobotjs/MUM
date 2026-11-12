package main

import (
	"app/server/providers/plex"
	"app/server/providers/provider"
	"context"
)

// errPlexAuthentication is the plex.tv sign-in error (errors.Is matches either name).
var errPlexAuthentication = plex.ErrAuthentication

// plexServerIdentity is the Plex server identity read by the plex client.
type plexServerIdentity = plex.Identity

// plexServer is this server's Plex client, wired to MUM's guarded transport
// and the per-installation (or recipient) client ID.
func (p *serverConnection) plexServer() *plex.Server {
	return plex.New(provider.Config{URL: p.config.URL, APIKey: p.config.APIKey, Transport: p.transport(), ClientID: p.plexClientID})
}

func (p *serverConnection) plexXML(ctx context.Context, target string, out any) error {
	return p.plexServer().XML(ctx, target, out)
}

// plexLibraries reads the server's library sections as reported, without the
// synchronization checks (sharing checks compare them as they are).
func (p *serverConnection) plexLibraries(ctx context.Context) ([]ProviderLibrary, error) {
	rows, err := p.plexServer().Libraries(ctx)
	if err != nil {
		return nil, err
	}
	return rows, nil
}

func (p *serverConnection) plexIdentity(ctx context.Context) (plexServerIdentity, error) {
	return p.plexServer().Identity(ctx)
}

// plexOwnerAccountID is the server-local account ID Plex Media Server gives
// its owner.
const plexOwnerAccountID = plex.OwnerAccountID
