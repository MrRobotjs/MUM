package main

import (
	"context"
	"errors"

	"app/server/providers/plex"
)

// plexAvatarError is the Plex module's classified avatar failure.
type plexAvatarError = plex.AvatarError

var errAvatarUnavailable = errors.New("invalid Plex avatar identity")

// activityAvatar downloads a playback avatar through the server's module.
func (p *serverConnection) activityAvatar(ctx context.Context, path string) (string, []byte, error) {
	m, ok := p.module().(activityAvatarReader)
	if !ok {
		return "", nil, errAvatarUnavailable
	}
	return m.ActivityAvatarImage(ctx, path)
}

// userAvatar downloads a user profile avatar through the server's module.
func (p *serverConnection) userAvatar(ctx context.Context, path string) (string, []byte, error) {
	m, ok := p.module().(userAvatarReader)
	if !ok {
		return "", nil, errAvatarUnavailable
	}
	return m.UserAvatarImage(ctx, path)
}
