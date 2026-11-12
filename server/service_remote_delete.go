package main

import "context"

// Remote delete is limited to modules that delete by the recorded remote ID.
// Kavita deletes by username, which would trust a name-to-ID binding observed
// earlier; Plex removal belongs to the share path. Both stay unsupported.
func serviceRemoteDeletable(kind string) bool {
	_, ok := moduleRules(kind).(accountDeleter)
	return ok
}

// deleteRecordedUser sends one ID-addressed DELETE. The caller has already
// inspected the account as present and disabled, and verifies absence after.
func (p *serverConnection) deleteRecordedUser(ctx context.Context, user remoteReview) error {
	if !serviceRemoteDeletable(p.config.Type) || user.Absent || !user.Disabled {
		return ErrConflict
	}
	if m, ok := p.module().(accountDeleter); ok {
		return m.DeleteAccount(ctx, user)
	}
	return ErrConflict
}
