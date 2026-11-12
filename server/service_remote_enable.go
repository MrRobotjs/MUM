package main

import "context"

// enableRecordedUser reverses a flag-based disable for an account inspected as
// disabled, through the server's module. Every other observed field is
// written back unchanged and, where the service exposes it, verified
// afterwards. Komga has no enable: its cleanup removed media access, and
// restoring it would invent a grant.
func (p *serverConnection) enableRecordedUser(ctx context.Context, user remoteReview) error {
	if m, ok := p.module().(accountEnabler); ok {
		return m.EnableAccount(ctx, user)
	}
	return ErrConflict
}
