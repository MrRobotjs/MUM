package main

import (
	"context"
	"errors"
)

// Plex is provisioned by sharing the server with the invitee's verified Plex
// account (plex_invitation_share.go), not by creating a local account, so it
// has no recorded-account recovery.
func supportsProvisioning(kind string) bool {
	return kind == "plex" || supportsRecordedRecovery(kind)
}

func supportsRecordedRecovery(kind string) bool {
	return moduleRecovers(moduleRules(kind))
}

func validProvisionedID(id string) bool {
	if id == "" || len(id) > 255 {
		return false
	}
	for _, c := range []byte(id) {
		if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '-' || c == '_') {
			return false
		}
	}
	return true
}

// provisionUser creates a recorded account through the server's module.
func (p *serverConnection) provisionUser(ctx context.Context, username, password string, grant InvitationGrant, checkpoint func(string, string) error) error {
	if m, ok := p.module().(accountProvisioner); ok {
		return m.ProvisionAccount(ctx, username, password, grant, checkpoint)
	}
	return errors.New("unsupported provisioning provider")
}
