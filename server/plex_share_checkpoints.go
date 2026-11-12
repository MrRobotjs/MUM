package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"slices"
	"time"
)

// This durable ledger is private until cloud writes and recipient-side effective
// access verification exist. access_observed never completes a provisioning job.
type plexShareCheckpoint struct {
	Job                            string
	Server                         int64
	State, Machine, Share, Account string
	Sections                       []plexShareSection
	Revision                       int64
	operation, token, expires      string
	grant                          InvitationGrant
	fingerprint                    string
	serverRevision                 int64
}

func loadPlexShareCheckpoint(ctx context.Context, tx *sql.Tx, job string, server int64) (plexShareCheckpoint, error) {
	p := plexShareCheckpoint{Job: job, Server: server}
	var sections, grant string
	err := tx.QueryRowContext(ctx, `SELECT c.state,c.machine_id,c.share_id,c.sections,c.revision,coalesce(c.operation_name,''),coalesce(c.operation_token,''),coalesce(c.operation_expires_at,''),s.grant_snapshot,s.provider_fingerprint,k.account_id FROM plex_share_checkpoints c JOIN provisioning_steps s ON s.job_id=c.job_id AND s.server_id=c.server_id JOIN plex_invitation_credentials k ON k.job_id=c.job_id WHERE c.job_id=? AND c.server_id=?`, job, server).Scan(&p.State, &p.Machine, &p.Share, &sections, &p.Revision, &p.operation, &p.token, &p.expires, &grant, &p.fingerprint, &p.Account)
	if err != nil {
		return p, err
	}
	if json.Unmarshal([]byte(sections), &p.Sections) != nil || json.Unmarshal([]byte(grant), &p.grant) != nil || p.grant.ServerID != server {
		return p, ErrConflict
	}
	return p, nil
}
func plexShareJobEligible(ctx context.Context, tx *sql.Tx, p plexShareCheckpoint) error {
	var eligible bool
	err := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM provisioning_jobs j JOIN user_accounts u ON u.uuid=j.user_uuid JOIN plex_invitation_credentials k ON k.job_id=j.id JOIN plex_invitation_authorizations p ON p.id=k.proof_id WHERE p.status='consumed' AND p.invite_id=j.invite_id AND p.account_id=k.account_id AND j.id=? AND j.status IN ('running','failed') AND j.resolution IS NULL AND j.reservation_held=1 AND u.kind='local' AND u.is_active=0 AND u.used_invite_id=j.invite_id AND NOT EXISTS(SELECT 1 FROM admin_privileges WHERE user_uuid=u.uuid) AND k.status='active' AND k.secret IS NOT NULL AND k.user_uuid=u.uuid AND k.account_id=?)`, p.Job, p.Account).Scan(&eligible)
	if err != nil {
		return err
	}
	if !eligible {
		return ErrConflict
	}
	return nil
}
func plexShareServerAuthority(ctx context.Context, tx *sql.Tx, p *plexShareCheckpoint) error {
	server, err := scanServer(tx.QueryRowContext(ctx, serverSelect+" WHERE s.id=?", p.Server))
	if err != nil {
		return err
	}
	if server.Type != "plex" || !server.EffectiveActive || providerFingerprint(server) != p.fingerprint {
		return ErrConflict
	}
	p.serverRevision = server.Revision
	return nil
}
func validPlexSharePlan(plan plexSharePreflight, account string, grant InvitationGrant) bool {
	if plan.State != "unobserved" || plan.Account != account || !validProvisionedID(plan.Machine) || plan.ShareID != "" || len(plan.Sections) == 0 || len(plan.Sections) > 10000 {
		return false
	}
	keys := []string{}
	seen := map[string]bool{}
	cloud := map[string]bool{}
	for _, section := range plan.Sections {
		if !plexNumericID(section.Key) || !plexNumericID(section.CloudID) || seen[section.Key] || cloud[section.CloudID] {
			return false
		}
		seen[section.Key] = true
		cloud[section.CloudID] = true
		keys = append(keys, section.Key)
	}
	if grant.AllLibraries {
		return len(grant.LibraryIDs) == 0
	}
	want := slices.Clone(grant.LibraryIDs)
	slices.Sort(want)
	slices.Sort(keys)
	return slices.Equal(keys, want)
}

// Persist uncertain intent BEFORE any future HTTP mutation. Only prepared sends
// can be claimed; uncertain sends require inspection, never an automatic retry.
func (s *Store) claimPlexShare(ctx context.Context, job string, server, revision int64, action string, plan plexSharePreflight) (plexShareCheckpoint, error) {
	return s.claimPlexShareAs(ctx, job, server, revision, action, plan, nil)
}
func (s *Store) claimPlexShareAs(ctx context.Context, job string, server, revision int64, action string, plan plexSharePreflight, admin *plexJobAdministrator) (plexShareCheckpoint, error) {
	var claimed plexShareCheckpoint
	err := s.write(ctx, func(tx *sql.Tx) error {
		if err := requirePlexJobAdministrator(ctx, tx, admin, job); err != nil {
			return err
		}

		p, err := loadPlexShareCheckpoint(ctx, tx, job, server)
		if err != nil {
			return err
		}
		if p.Revision != revision || p.token != "" || action != "send" && action != "inspect" && action != "cancel" {
			return ErrConflict
		}
		if err := plexShareJobEligible(ctx, tx, p); err != nil {
			return err
		}
		if action == "cancel" && p.State == "prepared" {
			if _, err := tx.ExecContext(ctx, "UPDATE plex_share_checkpoints SET state='cancelled',revision=revision+1,updated_at=? WHERE job_id=? AND server_id=?", utcTimestamp(time.Now()), job, server); err != nil {
				return err
			}
			// Release only the unused encrypted credential. Job capacity and inactive
			// identity remain held for the existing whole-job cancellation workflow.
			if _, err := tx.ExecContext(ctx, `UPDATE plex_invitation_credentials SET status='released',secret=NULL WHERE job_id=? AND NOT EXISTS(SELECT 1 FROM plex_share_checkpoints WHERE job_id=? AND state!='cancelled')`, job, job); err != nil {
				return err
			}
			p.State = "cancelled"
			p.Revision++
			claimed = p
			return auditAction(ctx, tx, "", "plex.share.cancel.not_started")
		}
		if err := plexShareServerAuthority(ctx, tx, &p); err != nil {
			return err
		}
		if action == "send" {
			if p.State != "prepared" || !validPlexSharePlan(plan, p.Account, p.grant) {
				return ErrConflict
			}
			var status string
			if err := tx.QueryRowContext(ctx, "SELECT status FROM provisioning_jobs WHERE id=?", job).Scan(&status); err != nil {
				return err
			}
			if status != "running" {
				return ErrConflict
			}
			var proofID, digest string
			if err := tx.QueryRowContext(ctx, "SELECT c.proof_id,p.invite_digest FROM plex_invitation_credentials c JOIN plex_invitation_authorizations p ON p.id=c.proof_id WHERE c.job_id=?", job).Scan(&proofID, &digest); err != nil {
				return err
			}
			proof, err := scanPlexInvitationAuthorization(tx.QueryRowContext(ctx, plexInvitationSelect, proofID, digest))
			if err != nil {
				return err
			}
			if err := verifyPlexInvitationScope(ctx, tx, proof, job); err != nil {
				return err
			}
			p.State = "send_uncertain"
			p.Machine = plan.Machine
			p.Sections = slices.Clone(plan.Sections)
		} else {
			if p.State == "prepared" || p.State == "cancelled" || p.Machine == "" {
				return ErrConflict
			}
			if action == "cancel" {
				p.State = "cancel_uncertain"
			}
		}
		encoded, err := json.Marshal(p.Sections)
		if err != nil {
			return err
		}
		p.operation = action
		p.token = randomToken()
		p.expires = utcTimestamp(time.Now().Add(30 * time.Second))
		p.Revision++
		_, err = tx.ExecContext(ctx, `UPDATE plex_share_checkpoints SET state=?,machine_id=?,sections=?,operation_name=?,operation_token=?,operation_expires_at=?,revision=?,updated_at=? WHERE job_id=? AND server_id=?`, p.State, p.Machine, string(encoded), action, p.token, p.expires, p.Revision, utcTimestamp(time.Now()), job, server)
		if err != nil {
			return err
		}
		claimed = p
		return auditAction(ctx, tx, "", "plex.share.intent."+action)
	})
	return claimed, err
}

// A missing share in the current preflight is not cancellation evidence: sent
// invitations are not yet enumerated. This function cannot mark remote absence,
// activate a profile, complete a job, release capacity, or retry a mutation.
func (s *Store) recordPlexShareObservation(ctx context.Context, claim plexShareCheckpoint, observation plexSharePreflight) error {
	return s.write(ctx, func(tx *sql.Tx) error { return recordPlexShareObservationTx(ctx, tx, claim, observation) })
}
func recordPlexShareObservationTx(ctx context.Context, tx *sql.Tx, claim plexShareCheckpoint, observation plexSharePreflight) error {
	p, err := loadPlexShareCheckpoint(ctx, tx, claim.Job, claim.Server)
	if err != nil {
		return err
	}
	if claim.token == "" || p.token != claim.token || p.operation != claim.operation || p.Revision != claim.Revision || p.expires <= utcTimestamp(time.Now()) {
		return ErrConflict
	}
	if err := plexShareJobEligible(ctx, tx, p); err != nil {
		return err
	}
	if err := plexShareServerAuthority(ctx, tx, &p); err != nil {
		return err
	}
	if p.serverRevision != claim.serverRevision || observation.Account != p.Account || observation.Machine != p.Machine || len(observation.Sections) != len(p.Sections) {
		return ErrConflict
	}
	seen := map[string]string{}
	for _, section := range p.Sections {
		seen[section.Key] = section.CloudID
	}
	for _, section := range observation.Sections {
		if seen[section.Key] != section.CloudID {
			return ErrConflict
		}
		delete(seen, section.Key)
	}
	if len(seen) != 0 {
		return ErrConflict
	}
	if observation.ShareID != "" {
		if !plexNumericID(observation.ShareID) || p.Share != "" && p.Share != observation.ShareID {
			return ErrConflict
		}
		p.Share = observation.ShareID
	}
	switch observation.State {
	case "unobserved":
		if p.State != "cancel_uncertain" {
			p.State = "send_uncertain"
		}
	case "pending":
		if p.State != "cancel_uncertain" {
			p.State = "awaiting_acceptance"
		}
	case "accepted":
		if !plexShareMatches(observation, p.grant) {
			return ErrConflict
		}
		if p.State != "cancel_uncertain" {
			p.State = "access_observed"
		}
	default:
		return ErrConflict
	}
	if _, err := tx.ExecContext(ctx, `UPDATE plex_share_checkpoints SET state=?,share_id=?,operation_token=NULL,operation_name=NULL,operation_expires_at=NULL,revision=revision+1,updated_at=? WHERE job_id=? AND server_id=?`, p.State, p.Share, utcTimestamp(time.Now()), p.Job, p.Server); err != nil {
		return err
	}
	return auditAction(ctx, tx, "", "plex.share.observation."+observation.State)
}
func (s *Store) expirePlexShareLeases(ctx context.Context) error {
	return s.write(ctx, func(tx *sql.Tx) error {
		_, err := tx.ExecContext(ctx, `UPDATE plex_share_checkpoints SET operation_token=NULL,operation_name=NULL,operation_expires_at=NULL,revision=revision+1,updated_at=? WHERE operation_token IS NOT NULL AND operation_expires_at<=?`, utcTimestamp(time.Now()), utcTimestamp(time.Now()))
		return err
	})
}
