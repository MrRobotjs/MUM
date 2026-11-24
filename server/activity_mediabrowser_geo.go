package main

import (
	"app/server/providers/plex"
	"context"
)

// enrichMediaBrowserLocations uses only a configured active Plex credential.
// Failure is optional and must never discard a valid media-session snapshot.
func (a *App) enrichMediaBrowserLocations(ctx context.Context, snapshot *activitySnapshot) {
	if snapshot.Provider != "jellyfin" && snapshot.Provider != "emby" && snapshot.Provider != "tofa" {
		return
	}
	found := false
	for _, s := range snapshot.Sessions {
		if s.Display != nil && plex.PublicSessionAddress(s.Display.IP).IsValid() {
			found = true
			break
		}
	}
	if !found {
		return
	}
	var id, revision int64
	err := a.store.reader.QueryRowContext(ctx, `SELECT s.id,s.config_revision FROM media_servers s JOIN provider_settings p ON p.provider_id=s.service_type WHERE s.service_type='plex' AND s.is_active=1 AND p.enabled=1 AND coalesce(s.api_key,'')<>'' ORDER BY s.id LIMIT 1`).Scan(&id, &revision)
	if err != nil {
		return
	}
	server, err := a.loadServer(ctx, id)
	if err != nil || !server.EffectiveActive || server.ConfigRevision != revision {
		return
	}
	connection, err := newServerConnection(ProviderConfig{server.Type, server.URL, server.apiKey}, a.ProviderHTTP)
	if err != nil {
		return
	}
	connection.locations = &a.locationCache
	client, ok := connection.module().(*plex.Server)
	if !ok {
		return
	}
	client.EnrichLocations(ctx, snapshot)
	current, err := a.loadServer(ctx, id)
	if err != nil || !current.EffectiveActive || current.ConfigRevision != revision {
		for i := range snapshot.Sessions {
			if d := snapshot.Sessions[i].Display; d != nil {
				d.Latitude = nil
				d.Longitude = nil
			}
		}
	}
}
