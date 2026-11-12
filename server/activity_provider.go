package main

import (
	"context"

	"app/server/providers/provider"
)

// Session snapshots are read and validated by each service's module
// (activityReader in provider_registry.go); the core stores them.
type (
	activitySession  = provider.ActivitySession
	activitySnapshot = provider.ActivitySnapshot
	activityDisplay  = provider.ActivityDisplay
)

var errActivitySnapshot = provider.ErrActivitySnapshot

func validActivitySession(s activitySession) bool { return provider.ValidActivitySession(s) }

// activitySupported reports whether a service's module reads sessions.
func activitySupported(kind string) bool {
	_, ok := moduleRules(kind).(activityReader)
	return ok
}

func (p *serverConnection) readActivitySnapshot(ctx context.Context) (activitySnapshot, error) {
	m, ok := p.module().(activityReader)
	if !ok {
		return activitySnapshot{}, errActivitySnapshot
	}
	return m.ActivitySnapshot(ctx)
}
