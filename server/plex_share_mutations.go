package main

import (
	"context"
	"database/sql"
	"encoding/xml"
	"net/http"
	"net/url"
	"strconv"
	"time"
)

type plexSentShare struct {
	Machine, ID    string
	Pending, Owned bool
	Known          bool
}
type plexSentInvitation struct {
	Account              string
	Friend, Home, Server bool
	Machines             []string
	Shares               []plexSentShare
}

// Account IDs are taken only from the invitation's numeric id. Email-only
// invitations cannot be adopted as the verified recipient's account.
func (p *jsonProvider) plexSentInvitations(ctx context.Context) ([]plexSentInvitation, error) {
	if p.config.Type != "plex" {
		return nil, plexShareInvalid("SENT_INPUT")
	}
	var response struct {
		XMLName xml.Name `xml:"MediaContainer"`
		Size    string   `xml:"size,attr"`
		Offset  string   `xml:"offset,attr"`
		Total   string   `xml:"totalSize,attr"`
		Invites []struct {
			ID      string `xml:"id,attr"`
			Friend  string `xml:"friend,attr"`
			Home    string `xml:"home,attr"`
			Server  string `xml:"server,attr"`
			Servers []struct {
				Machine string `xml:"machineIdentifier,attr"`
				ID      string `xml:"id,attr"`
				Pending string `xml:"pending,attr"`
				Owned   string `xml:"owned,attr"`
			} `xml:"Server"`
		} `xml:"Invite"`
	}
	if err := p.plexXML(ctx, "https://plex.tv/api/invites/requested", &response); err != nil {
		return nil, plexShareInvalid("SENT_READ")
	}
	count, err := strconv.Atoi(response.Size)
	if err != nil || count != len(response.Invites) || count > 10000 || response.Offset != "" && response.Offset != "0" || response.Total != "" && response.Total != response.Size {
		return nil, plexShareInvalid("SENT_COUNT")
	}
	result := []plexSentInvitation{}
	seen := map[string]bool{}
	for _, invite := range response.Invites {
		if invite.ID == "" {
			return nil, plexShareInvalid("SENT_INVITE_ID_MISSING")
		}
		if !plexNumericID(invite.ID) {
			return nil, plexShareInvalid("SENT_INVITE_ID_INVALID")
		}
		if seen[invite.ID] {
			return nil, plexShareInvalid("SENT_INVITE_ID_DUPLICATE")
		}
		seen[invite.ID] = true
		friend, fok := plexExplicitBool(invite.Friend)
		home, hok := plexExplicitBool(invite.Home)
		server, sok := plexExplicitBool(invite.Server)
		if !fok || !hok || !sok {
			return nil, plexShareInvalid("SENT_INVITE_FLAGS")
		}
		item := plexSentInvitation{Account: invite.ID, Friend: friend, Home: home, Server: server, Machines: []string{}}
		machines := map[string]bool{}
		shareIDs := map[string]bool{}
		for _, s := range invite.Servers {
			if !validProvisionedID(s.Machine) || machines[s.Machine] {
				return nil, plexShareInvalid("SENT_SERVER_MACHINE")
			}
			machines[s.Machine] = true
			item.Machines = append(item.Machines, s.Machine)
			pending, pKnown := plexExplicitBool(s.Pending)
			owned, oKnown := plexExplicitBool(s.Owned)
			if s.ID != "" && (!plexNumericID(s.ID) || shareIDs[s.ID]) || s.Pending != "" && !pKnown || s.Owned != "" && !oKnown {
				return nil, plexShareInvalid("SENT_SHARE_FIELDS")
			}
			if s.ID != "" {
				shareIDs[s.ID] = true
			}
			item.Shares = append(item.Shares, plexSentShare{Machine: s.Machine, ID: s.ID, Pending: pending, Owned: owned, Known: s.ID != "" && pKnown && oKnown})

		}
		if server != (len(item.Machines) > 0) {
			return nil, plexShareInvalid("SENT_SERVER_MISMATCH")
		}
		result = append(result, item)
	}
	return result, nil
}
func noPlexSentInviteForAccount(invites []plexSentInvitation, account string) bool {
	for _, invite := range invites {
		if invite.Account == account {
			return false
		}
	}
	return true
}

// A pending invitation is evidence for this server only. A friendship request
// or another server's invitation must never complete this server's job step.
func hasPlexSentInviteForServer(invites []plexSentInvitation, account, machine string) bool {
	if !plexNumericID(account) || !validProvisionedID(machine) {
		return false
	}
	for _, invite := range invites {
		if invite.Account != account || !invite.Server {
			continue
		}
		for _, target := range invite.Machines {
			if target == machine {
				return true
			}
		}
	}
	return false
}

// This intentionally supports selected libraries for existing friends only.
// Omitting sharing_settings preserves account-level downloads, Home and filters.
func (p *jsonProvider) createPlexSelectedShare(ctx context.Context, claim plexShareCheckpoint, plan plexSharePreflight) error {
	if !plexNumericID(claim.Account) || p.config.Type != "plex" || claim.State != "send_uncertain" || claim.operation != "send" || claim.token == "" || claim.expires <= utcTimestamp(time.Now()) || claim.grant.AllLibraries || !validPlexSharePlan(plan, claim.Account, claim.grant) || !plan.DownloadsKnown || plan.AllowDownloads != claim.grant.AllowDownloads || plan.Machine != claim.Machine || !samePlexSections(plan.Sections, claim.Sections) {
		return ErrConflict
	}
	ids := []int64{}
	for _, section := range plan.Sections {
		id, err := strconv.ParseInt(section.CloudID, 10, 64)
		if err != nil {
			return errPlexShare
		}
		ids = append(ids, id)
	}
	account, err := strconv.ParseInt(claim.Account, 10, 64)
	if err != nil || account < 1 {
		return errPlexShare
	}
	body := struct {
		Server string `json:"server_id"`
		Share  struct {
			Libraries []int64 `json:"library_section_ids"`
			Account   int64   `json:"invited_id"`
		} `json:"shared_server"`
	}{Server: claim.Machine}
	body.Share.Libraries = ids
	body.Share.Account = account
	_, err = p.fetch(ctx, http.MethodPost, "https://plex.tv/api/servers/"+url.PathEscape(claim.Machine)+"/shared_servers", body)
	if err != nil {
		return errPlexShare
	}
	return nil
}
func samePlexSections(a, b []plexShareSection) bool {
	if len(a) != len(b) {
		return false
	}
	seen := map[string]string{}
	for _, s := range a {
		if seen[s.Key] != "" {
			return false
		}
		seen[s.Key] = s.CloudID
	}
	for _, s := range b {
		if seen[s.Key] != s.CloudID {
			return false
		}
		delete(seen, s.Key)
	}
	return len(seen) == 0
}

// The configuration is reread immediately before the future side effect; an
// authorization/lease/provider change during preflight or refresh blocks it.
func (a *App) plexSendProvider(ctx context.Context, claim plexShareCheckpoint) (*jsonProvider, error) {
	var config ProviderConfig
	err := a.store.write(ctx, func(tx *sql.Tx) error {
		current, err := loadPlexShareCheckpoint(ctx, tx, claim.Job, claim.Server)
		if err != nil {
			return err
		}
		if claim.token == "" || current.token != claim.token || current.Revision != claim.Revision || current.operation != "send" || current.State != "send_uncertain" || current.expires <= utcTimestamp(time.Now()) {
			return ErrConflict
		}
		if err := plexShareJobEligible(ctx, tx, current); err != nil {
			return err
		}
		if err := plexShareServerAuthority(ctx, tx, &current); err != nil {
			return err
		}
		if current.serverRevision != claim.serverRevision {
			return ErrConflict
		}
		var proofID, digest string
		if err := tx.QueryRowContext(ctx, "SELECT c.proof_id,p.invite_digest FROM plex_invitation_credentials c JOIN plex_invitation_authorizations p ON p.id=c.proof_id WHERE c.job_id=?", claim.Job).Scan(&proofID, &digest); err != nil {
			return err
		}
		proof, err := scanPlexInvitationAuthorization(tx.QueryRowContext(ctx, plexInvitationSelect, proofID, digest))
		if err != nil {
			return err
		}
		if err := verifyPlexInvitationScope(ctx, tx, proof, claim.Job); err != nil {
			return err
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
	provider, err := newMediaProvider(config, a.ProviderHTTP)
	if err != nil {
		return nil, err
	}
	return provider.(*jsonProvider), nil
}

// Private send worker: called explicitly, never on startup or uncertain retry.
// Normal invitation creation/redemption and capabilities remain disabled.
func (a *App) sendPlexSelectedShare(ctx context.Context, job string, server, revision int64) error {
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
		if row.Revision != revision || row.State != "prepared" || row.token != "" || row.grant.AllLibraries {
			return ErrConflict
		}
		if err := plexShareJobEligible(ctx, tx, row); err != nil {
			return err
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
	provider, err := newMediaProvider(config, a.ProviderHTTP)
	if err != nil {
		return err
	}
	owner := provider.(*jsonProvider)
	plan, err := owner.inspectPlexShare(ctx, row.Account, row.grant)
	if err != nil {
		return err
	}
	if !validPlexSharePlan(plan, row.Account, row.grant) || !plan.DownloadsKnown || plan.AllowDownloads != row.grant.AllowDownloads {
		return ErrConflict
	}
	sent, err := owner.plexSentInvitations(ctx)
	if err != nil {
		return err
	}
	if !noPlexSentInviteForAccount(sent, row.Account) {
		return ErrConflict
	}
	claim, err := a.store.claimPlexShare(ctx, job, server, revision, "send", plan)
	if err != nil {
		return err
	}
	secret, err := a.refreshPlexJobCredential(ctx, claim)
	if err != nil {
		return err
	}
	// Recheck remote state after refresh, without turning a duplicate/preexisting
	// share or a sent invitation into ownership evidence.
	owner, err = a.plexSendProvider(ctx, claim)
	if err != nil {
		return err
	}
	current, err := owner.inspectPlexShare(ctx, row.Account, row.grant)
	if err != nil {
		return err
	}
	sent, err = owner.plexSentInvitations(ctx)
	if err != nil {
		return err
	}
	if !validPlexSharePlan(current, row.Account, row.grant) || !current.DownloadsKnown || current.AllowDownloads != row.grant.AllowDownloads || !samePlexSections(current.Sections, plan.Sections) || !noPlexSentInviteForAccount(sent, row.Account) {
		return ErrConflict
	}
	owner, err = a.plexSendProvider(ctx, claim)
	if err != nil {
		return err
	}
	if err := owner.createPlexSelectedShare(ctx, claim, current); err != nil {
		return err
	}
	observation, err := owner.inspectPlexShare(ctx, row.Account, row.grant)
	if err != nil {
		return err
	}
	if observation.State == "accepted" {
		if err := verifyPlexRecipientLibraries(ctx, a.ProviderHTTP, secret, config.URL, observation, row.grant); err != nil {
			return err
		}
	}
	postInvites, err := owner.plexSentInvitations(ctx)
	if err != nil {
		return err
	}
	for _, invite := range postInvites {
		if invite.Account != row.Account {
			continue
		}
		for _, machine := range invite.Machines {
			if machine != claim.Machine {
				continue
			}
			if observation.State == "accepted" {
				return ErrConflict
			}
			if observation.State == "unobserved" {
				observation.State = "pending"
			}
		}
	}
	// POST success is never acceptance. Only a fresh scoped observation commits.
	return a.store.recordPlexShareObservation(ctx, claim, observation)
}
