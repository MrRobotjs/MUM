package main

import (
	"context"
	"net/http"
	"net/url"
	"strings"
)

// Remote delete is limited to providers that delete by the recorded remote ID.
// Kavita deletes by username, which would trust a name-to-ID binding observed
// earlier; Plex removal belongs to the share path. Both stay unsupported.
func serviceRemoteDeletable(kind string) bool {
	switch kind {
	case "jellyfin", "emby", "audiobookshelf", "komga", "romm":
		return true
	}
	return false
}

// deleteRecordedUser sends one ID-addressed DELETE. The caller has already
// inspected the account as present and disabled, and verifies absence after.
func (p *jsonProvider) deleteRecordedUser(ctx context.Context, user remoteReview) error {
	if !serviceRemoteDeletable(p.config.Type) || user.Absent || !user.Disabled {
		return ErrConflict
	}
	id := url.PathEscape(user.ID)
	switch p.config.Type {
	case "jellyfin", "emby":
		return p.mediaUserRequest(ctx, http.MethodDelete, "/Users/"+id, nil, nil)
	case "audiobookshelf":
		return p.absRequest(ctx, http.MethodDelete, "/users/"+id, nil, nil)
	case "komga":
		return p.komgaRequest(ctx, http.MethodDelete, "/"+id, nil, nil)
	case "romm":
		if !rommRecordedID(user.ID) {
			return ErrConflict
		}
		return p.jsonRequest(ctx, http.MethodDelete, strings.TrimRight(p.config.URL, "/")+"/api/users/"+id, nil, nil)
	}
	return ErrConflict
}
