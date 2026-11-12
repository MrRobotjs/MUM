package main

import (
	"context"
	"database/sql"
	"strconv"
	"time"
)

type plexShareAbsence struct {
	machine, account, share string
	verified                bool
}

func completePlexList(size, offset, total string, count int) bool {
	n, err := strconv.Atoi(size)
	return err == nil && n == count && n <= 10000 && (offset == "" || offset == "0") && (total == "" || total == size)
}

// Complete owner-side cloud lists plus sent invitations are required. A missing
// user reference, empty body, 404 or absent share ID alone is never evidence.
func (p *serverConnection) inspectPlexShareAbsence(ctx context.Context, claim plexShareCheckpoint) (plexShareAbsence, error) {
	result := plexShareAbsence{machine: claim.Machine, account: claim.Account, share: claim.Share}
	if p.config.Type != "plex" || !validProvisionedID(claim.Machine) || !plexNumericID(claim.Account) || !plexNumericID(claim.Share) {
		return result, ErrConflict
	}
	identity, err := p.plexIdentity(ctx)
	if err != nil || identity.Machine != claim.Machine {
		return result, errPlexShare
	}
	users, err := p.plexServer().Friends(ctx)
	if err != nil || !completePlexList(users.Size, users.Offset, users.Total, len(users.Users)) {
		return result, errPlexShare
	}
	seen := map[string]bool{}
	for _, user := range users.Users {
		if !plexNumericID(user.Attr("id")) || seen[user.Attr("id")] {
			return result, errPlexShare
		}
		seen[user.Attr("id")] = true
		machines := map[string]bool{}
		for _, server := range user.Servers {
			if !validProvisionedID(server.Machine) || machines[server.Machine] {
				return result, errPlexShare
			}
			machines[server.Machine] = true
			if user.Attr("id") == claim.Account && server.Machine == claim.Machine {
				return result, ErrConflict
			}
		}
	}
	shares, err := p.plexServer().SharedServers(ctx, claim.Machine)
	if err != nil || !completePlexList(shares.Size, shares.Offset, shares.Total, len(shares.Shares)) {
		return result, errPlexShare
	}
	ids := map[string]bool{}
	accounts := map[string]bool{}
	for _, share := range shares.Shares {
		if !plexNumericID(share.ID) || !plexNumericID(share.UserID) || ids[share.ID] || accounts[share.UserID] {
			return result, errPlexShare
		}
		ids[share.ID] = true
		accounts[share.UserID] = true
		if share.ID == claim.Share || share.UserID == claim.Account {
			return result, ErrConflict
		}
	}
	invites, err := p.plexSentInvitations(ctx)
	if err != nil {
		return result, err
	}
	for _, invite := range invites {
		if invite.Account != claim.Account {
			continue
		}
		for _, machine := range invite.Machines {
			if machine == claim.Machine {
				return result, ErrConflict
			}
		}
	}
	result.verified = true
	return result, nil
}

// Cleanup equality does not establish accepted access. Pending grants require
// an independent exact sent-share proof before the adapter admits a DELETE.
type plexPendingShareProof struct {
	account, machine, share string
	verified                bool
}

func plexRemovalObservationMatches(claim plexShareCheckpoint, current plexSharePreflight) bool {
	if current.State != "accepted" && current.State != "pending" {
		return false
	}
	if claim.grant.AllLibraries || current.Account != claim.Account || current.Machine != claim.Machine || current.ShareID != claim.Share || !samePlexSections(current.Sections, claim.Sections) {
		return false
	}
	checked := current
	checked.State = "accepted"
	return plexShareMatches(checked, claim.grant)
}
func bindPlexPendingShare(claim plexShareCheckpoint, current plexSharePreflight, invites []plexSentInvitation) (plexPendingShareProof, error) {
	var proof plexPendingShareProof
	if current.State != "pending" || !plexRemovalObservationMatches(claim, current) {
		return proof, ErrConflict
	}
	for _, invite := range invites {
		if invite.Account != claim.Account {
			continue
		}
		if invite.Friend || invite.Home || !invite.Server {
			return proof, ErrConflict
		}
		for _, share := range invite.Shares {
			if share.Machine != claim.Machine {
				continue
			}
			// The owner's own server is reported as owned (see inspectPlexShare).
			if !share.Known || share.ID != claim.Share || !share.Pending || !share.Owned {
				return proof, ErrConflict
			}
			proof = plexPendingShareProof{claim.Account, claim.Machine, claim.Share, true}
		}
	}
	if !proof.verified {
		return proof, ErrConflict
	}
	return proof, nil
}
func (p *serverConnection) removePlexSelectedSections(ctx context.Context, claim plexShareCheckpoint, current plexSharePreflight, pending plexPendingShareProof) error {
	if p.config.Type != "plex" || !validProvisionedID(claim.Machine) || !plexNumericID(claim.Account) || claim.State != "cancel_uncertain" || claim.operation != "cancel" || claim.token == "" || claim.expires <= utcTimestamp(time.Now()) || claim.grant.AllLibraries || !plexNumericID(claim.Share) || current.Account != claim.Account || current.Machine != claim.Machine || current.ShareID != claim.Share || !plexRemovalObservationMatches(claim, current) {
		return ErrConflict
	}
	if current.State == "pending" && (!pending.verified || pending.account != claim.Account || pending.machine != claim.Machine || pending.share != claim.Share) {
		return ErrConflict
	}
	ids := []int64{}
	for _, section := range claim.Sections {
		if !plexNumericID(section.CloudID) {
			return ErrConflict
		}
		id, _ := strconv.ParseInt(section.CloudID, 10, 64)
		ids = append(ids, id)
	}
	if len(ids) == 0 {
		return ErrConflict
	}
	body := struct {
		Server string `json:"server_id"`
		Share  struct {
			Libraries []int64 `json:"library_section_ids"`
		} `json:"shared_server"`
	}{Server: claim.Machine}
	body.Share.Libraries = ids
	err := p.plexServer().DeleteShare(ctx, claim.Machine, claim.Share, body)
	if err != nil {
		return errPlexShare
	}
	return nil
}
func (a *App) plexCancellationProvider(ctx context.Context, claim plexShareCheckpoint) (*serverConnection, error) {
	var config ProviderConfig
	err := a.store.write(ctx, func(tx *sql.Tx) error {
		p, err := loadPlexShareCheckpoint(ctx, tx, claim.Job, claim.Server)
		if err != nil {
			return err
		}
		if claim.token == "" || p.token != claim.token || p.Revision != claim.Revision || p.expires <= utcTimestamp(time.Now()) || p.State != "cancel_uncertain" || p.Account != claim.Account || canonicalPlexInvitationGrant(p.grant) != canonicalPlexInvitationGrant(claim.grant) || p.operation != claim.operation || p.Machine != claim.Machine || p.Share != claim.Share || !samePlexSections(p.Sections, claim.Sections) {
			return ErrConflict
		}
		if err := plexShareJobEligible(ctx, tx, p); err != nil {
			return err
		}
		if err := plexShareServerAuthority(ctx, tx, &p); err != nil {
			return err
		}
		if p.serverRevision != claim.serverRevision {
			return ErrConflict
		}
		server, err := scanServer(tx.QueryRowContext(ctx, serverSelect+" WHERE s.id=?", claim.Server))
		if err != nil {
			return err
		}
		config = ProviderConfig{Type: server.Type, URL: server.URL, APIKey: server.apiKey}
		return nil
	})
	if err != nil {
		return nil, err
	}
	provider, err := newServerConnection(config, a.ProviderHTTP)
	if err != nil {
		return nil, err
	}
	return provider, nil
}
func (s *Store) recordPlexShareAbsence(ctx context.Context, claim plexShareCheckpoint, proof plexShareAbsence) error {
	if !proof.verified || proof.machine != claim.Machine || proof.account != claim.Account || proof.share != claim.Share {
		return ErrConflict
	}
	return s.write(ctx, func(tx *sql.Tx) error {
		p, err := loadPlexShareCheckpoint(ctx, tx, claim.Job, claim.Server)
		if err != nil {
			return err
		}
		if claim.token == "" || p.token != claim.token || p.Revision != claim.Revision || p.operation != claim.operation || p.expires <= utcTimestamp(time.Now()) || p.State != "cancel_uncertain" || canonicalPlexInvitationGrant(p.grant) != canonicalPlexInvitationGrant(claim.grant) || !samePlexSections(p.Sections, claim.Sections) || p.Machine != proof.machine || p.Account != proof.account || p.Share != proof.share {
			return ErrConflict
		}
		if err := plexShareJobEligible(ctx, tx, p); err != nil {
			return err
		}
		if err := plexShareServerAuthority(ctx, tx, &p); err != nil {
			return err
		}
		if p.serverRevision != claim.serverRevision {
			return ErrConflict
		}
		if _, err := tx.ExecContext(ctx, `UPDATE plex_share_checkpoints SET state='cancelled',operation_token=NULL,operation_name=NULL,operation_expires_at=NULL,revision=revision+1,updated_at=? WHERE job_id=? AND server_id=?`, utcTimestamp(time.Now()), p.Job, p.Server); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `UPDATE plex_invitation_credentials SET status='released',secret=NULL,refresh_token=NULL,refresh_expires_at=NULL,revision=revision+1 WHERE job_id=? AND NOT EXISTS(SELECT 1 FROM plex_share_checkpoints WHERE job_id=? AND state!='cancelled')`, p.Job, p.Job); err != nil {
			return err
		}
		return auditAction(ctx, tx, "", "plex.share.cancel.verified_absence")
	})
}

// Reconcile an uncertain DELETE by reads only; never replay it. Both entry points
// remain private until public provisioning/recovery semantics are implemented.
func (a *App) cancelPlexSelectedShare(ctx context.Context, job string, server, revision int64, reconcile bool) error {
	a.provisionMu.Lock()
	if a.provisionClosing {
		a.provisionMu.Unlock()
		return ErrConflict
	}
	a.provisionWG.Add(1)
	a.provisionMu.Unlock()
	defer a.provisionWG.Done()
	select {
	case a.provisionSlots <- struct{}{}:
		defer func() { <-a.provisionSlots }()
	default:
		return ErrConflict
	}
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	stop := context.AfterFunc(a.provisionCtx, cancel)
	defer stop()
	var row plexShareCheckpoint
	var config ProviderConfig
	err := a.store.write(ctx, func(tx *sql.Tx) error {
		var err error
		row, err = loadPlexShareCheckpoint(ctx, tx, job, server)
		if err != nil {
			return err
		}
		if row.Revision != revision || row.token != "" {
			return ErrConflict
		}
		if err := plexShareJobEligible(ctx, tx, row); err != nil {
			return err
		}
		if row.State == "prepared" {
			return nil
		}
		if err := plexShareServerAuthority(ctx, tx, &row); err != nil {
			return err
		}
		managed, err := scanServer(tx.QueryRowContext(ctx, serverSelect+" WHERE s.id=?", server))
		if err != nil {
			return err
		}
		config = ProviderConfig{Type: managed.Type, URL: managed.URL, APIKey: managed.apiKey}
		return nil
	})
	if err != nil {
		return err
	}
	if row.State == "prepared" && !reconcile {
		_, err := a.store.claimPlexShare(ctx, job, server, revision, "cancel", plexSharePreflight{})
		return err
	}
	if row.grant.AllLibraries || !plexNumericID(row.Share) {
		return ErrConflict
	}
	action := "cancel"
	if reconcile {
		if row.State != "cancel_uncertain" {
			return ErrConflict
		}
		action = "inspect"
	} else if row.State != "access_observed" && row.State != "awaiting_acceptance" {
		return ErrConflict
	}
	alreadyAbsent := false
	if !reconcile {
		provider, err := newServerConnection(config, a.ProviderHTTP)
		if err != nil {
			return err
		}
		owner := provider
		current, err := owner.inspectPlexShare(ctx, row.Account, row.grant)
		if err != nil {
			return err
		}
		if current.State == "unobserved" {
			if _, err := owner.inspectPlexShareAbsence(ctx, row); err != nil {
				return err
			}
			alreadyAbsent = true
		} else {
			if !plexRemovalObservationMatches(row, current) {
				return ErrConflict
			}
			sent, err := owner.plexSentInvitations(ctx)
			if err != nil {
				return err
			}
			if current.State == "pending" {
				if _, err := bindPlexPendingShare(row, current, sent); err != nil {
					return err
				}
			} else if !noPlexSentInviteForAccount(sent, row.Account) {
				return ErrConflict
			}
		}
	}
	claim, err := a.store.claimPlexShare(ctx, job, server, revision, action, plexSharePreflight{})
	if err != nil {
		return err
	}
	owner, err := a.plexCancellationProvider(ctx, claim)
	if err != nil {
		return err
	}
	if !reconcile && !alreadyAbsent {
		current, err := owner.inspectPlexShare(ctx, claim.Account, claim.grant)
		if err != nil {
			return err
		}
		sent, err := owner.plexSentInvitations(ctx)
		if err != nil {
			return err
		}
		var pending plexPendingShareProof
		if current.State == "pending" {
			pending, err = bindPlexPendingShare(claim, current, sent)
			if err != nil {
				return err
			}
		} else if !noPlexSentInviteForAccount(sent, claim.Account) {
			return ErrConflict
		}
		owner, err = a.plexCancellationProvider(ctx, claim)
		if err != nil {
			return err
		}
		if err := owner.removePlexSelectedSections(ctx, claim, current, pending); err != nil {
			return err
		}
	}
	proof, err := owner.inspectPlexShareAbsence(ctx, claim)
	if err != nil {
		return err
	}
	return a.store.recordPlexShareAbsence(ctx, claim, proof)
}
