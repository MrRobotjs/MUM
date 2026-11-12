package main

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"
)

// A server revision also changes on ordinary sync. Bind recovery to the exact
// original provider endpoint/credentials, then guard each operation's current
// revision against changes while its network requests are in progress.
func providerFingerprint(s ManagedServer) string {
	encoded, _ := json.Marshal([]string{s.Type, s.URL, s.apiKey})
	return fmt.Sprintf("%x", sha256.Sum256(encoded))
}

func (p *serverConnection) inspectProvisionedUser(ctx context.Context, id, name string) (remoteReview, error) {
	var user remoteReview
	if m, ok := p.module().(accountInspector); ok {
		account, err := m.InspectAccount(ctx, id, name)
		if err != nil {
			return remoteReview{}, err
		}
		return account, nil
	}
	return user, ErrConflict
}

type reviewInput struct {
	Revision        int64          `json:"revision"`
	Reason          string         `json:"reason"`
	AcknowledgeRisk bool           `json:"acknowledge_in_flight_risk"`
	ReleaseUsername bool           `json:"release_username,omitempty"`
	Manual          []manualReview `json:"manual_resolutions,omitempty"`
}
type manualReview struct {
	ServerID int64  `json:"server_id"`
	Reason   string `json:"reason"`
}
type reviewTarget struct {
	Server      ManagedServer
	Step        redemptionStep
	Fingerprint string
	Manual      bool
}

func (a *App) startReviewOperation(w http.ResponseWriter, r *http.Request) (context.Context, func(), bool) {
	a.provisionMu.Lock()
	if a.provisionClosing {
		a.provisionMu.Unlock()
		fail(w, 503, "SHUTTING_DOWN", "Provisioning is shutting down")
		return nil, nil, false
	}
	a.provisionWG.Add(1)
	a.provisionMu.Unlock()
	select {
	case a.provisionSlots <- struct{}{}:
	default:
		a.provisionWG.Done()
		fail(w, 503, "PROVISIONING_BUSY", "Provisioning capacity is busy")
		return nil, nil, false
	}
	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	stop := context.AfterFunc(a.provisionCtx, cancel)
	return ctx, func() { stop(); cancel(); <-a.provisionSlots; a.provisionWG.Done() }, true
}

func (a *App) claimReview(ctx context.Context, actor, access, jobID string, revision int64) (string, error) {
	token := newUUID()
	err := a.store.write(ctx, func(tx *sql.Tx) error {
		if busy, err := bulkSourceBusy(ctx, tx, 0, ""); err != nil {
			return err
		} else if busy {
			return ErrConflict
		}
		if err := accountPreferenceAuthority(ctx, tx, actor, access); err != nil {
			return err
		}
		if err := requirePermission(ctx, tx, actor, "administrator"); err != nil {
			return err
		}
		result, err := tx.ExecContext(ctx, `UPDATE provisioning_jobs SET review_token=?,review_actor_uuid=?,review_access_hash=?,review_role_revision=(SELECT revision FROM admin_role_state WHERE singleton=1),review_error_code=NULL,revision=revision+1,updated_at=? WHERE id=? AND revision=? AND status='failed' AND resolution IS NULL AND reservation_held=1 AND review_token IS NULL AND NOT EXISTS(SELECT 1 FROM plex_share_checkpoints c WHERE c.job_id=provisioning_jobs.id AND c.state!='cancelled') AND EXISTS(SELECT 1 FROM user_accounts WHERE uuid=provisioning_jobs.user_uuid AND is_active=0 AND NOT EXISTS(SELECT 1 FROM admin_privileges WHERE user_uuid=provisioning_jobs.user_uuid))`, token, actor, tokenHash(access), utcTimestamp(time.Now()), jobID, revision)
		if err != nil {
			return err
		}
		count, _ := result.RowsAffected()
		if count != 1 {
			return ErrConflict
		}
		return auditReview(ctx, tx, actor, jobID, "provisioning.review.start", map[string]any{})
	})
	return token, err
}

func auditReview(ctx context.Context, tx *sql.Tx, actor, jobID, action string, details map[string]any) error {
	details["job_id"] = jobID
	encoded, err := json.Marshal(details)
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, "INSERT INTO audit_events(actor_uuid,action,details,occurred_at) VALUES(?,?,?,?)", actor, action, string(encoded), utcTimestamp(time.Now()))
	return err
}

func reviewPermission(ctx context.Context, tx *sql.Tx, actor, jobID, token string) error {
	if err := reviewSessionAuthority(ctx, tx, actor, jobID, token); err != nil {
		return err
	}
	if err := requirePermission(ctx, tx, actor, "administrator"); err != nil {
		return err
	}
	var held bool
	err := tx.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM provisioning_jobs WHERE id=? AND review_token=? AND status='failed' AND reservation_held=1 AND resolution IS NULL AND EXISTS(SELECT 1 FROM user_accounts WHERE uuid=provisioning_jobs.user_uuid AND is_active=0 AND NOT EXISTS(SELECT 1 FROM admin_privileges WHERE user_uuid=provisioning_jobs.user_uuid)))", jobID, token).Scan(&held)
	if err != nil {
		return err
	}
	if !held {
		return ErrConflict
	}
	return nil
}

func (a *App) populateReviewFlags(ctx context.Context, job *redemptionJob) error {
	targets, err := a.reviewTargets(ctx, *job)
	if err != nil {
		return err
	}
	for index, target := range targets {
		job.Steps[index].PasswordMaxBytes = 1024
		if limit, ok := moduleRules(target.Server.Type).(passwordLimit); ok {
			job.Steps[index].PasswordMaxBytes = limit.PasswordMaxBytes()
		}
		if rule, ok := moduleRules(target.Server.Type).(passwordASCIIRule); ok {
			job.Steps[index].PasswordASCIIOnly = rule.PasswordASCIIOnly()
		}
		job.Steps[index].CleanupScope = "account"
		if scope, ok := moduleRules(target.Server.Type).(cleanupScoper); ok {
			job.Steps[index].CleanupScope = scope.CleanupScope()
		}
		job.Steps[index].ManualRequired = target.Manual
		job.Steps[index].ManualAllowed = target.Manual || target.Step.Cleanup == "failed" || target.Step.Cleanup == "unknown"
		if job.Steps[index].Plex != nil {
			job.Steps[index].CleanupScope = "media"
			if job.Steps[index].Plex.State != "cancelled" {
				job.Steps[index].ManualAllowed = false
				job.Steps[index].ManualRequired = false
			}
		}
	}
	job.ResumeAvailable = job.Status == "failed" && job.Reserved && !job.Reviewing
	for _, target := range targets {
		if target.Manual || !validProvisionedID(target.Step.RemoteID) || target.Step.RemoteName == "" {
			job.ResumeAvailable = false
		}
	}
	var active bool
	if err := a.store.reader.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM invites WHERE id=? AND is_active=1 AND archived_at IS NULL AND (expires_at IS NULL OR julianday(expires_at)>julianday('now')))", job.InviteID).Scan(&active); err != nil {
		return err
	}
	var eligible bool
	if err := a.store.reader.QueryRowContext(ctx, resumeProfileQuery, job.UserUUID, job.InviteID, job.ID, job.ID).Scan(&eligible); err != nil {
		return err
	}
	job.ResumeAvailable = job.ResumeAvailable && active && eligible && job.Plex == nil
	return nil
}

func (a *App) reviewTargets(ctx context.Context, job redemptionJob) ([]reviewTarget, error) {
	targets := []reviewTarget{}
	for _, step := range job.Steps {
		s, err := a.loadServer(ctx, step.ServerID)
		if err != nil {
			return nil, err
		}
		var fingerprint string
		if err := a.store.reader.QueryRowContext(ctx, "SELECT coalesce(provider_fingerprint,'') FROM provisioning_steps WHERE job_id=? AND server_id=?", job.ID, s.ID).Scan(&fingerprint); err != nil {
			return nil, err
		}
		knownID := validProvisionedID(step.RemoteID)
		if m := moduleRules(s.Type); m != nil {
			knownID = moduleIdentityValid(m, step.RemoteID, step.RemoteName)
		}
		manual := step.Stage != "pending" && (!knownID || step.RemoteName == "" || fingerprint == "" || fingerprint != providerFingerprint(s) || !s.EffectiveActive || !supportsRecordedRecovery(s.Type))
		targets = append(targets, reviewTarget{s, step, fingerprint, manual})
	}
	return targets, nil
}

func (a *App) reviewCheckpoint(ctx context.Context, actor, jobID, token string, target *reviewTarget, state, code string) error {
	nextRevision := target.Server.Revision
	err := a.store.write(ctx, func(tx *sql.Tx) error {
		if err := reviewPermission(ctx, tx, actor, jobID, token); err != nil {
			return err
		}
		if target.Step.Stage != "pending" && !target.Manual {
			current, err := scanServer(tx.QueryRowContext(ctx, serverSelect+" WHERE s.id=?", target.Server.ID))
			if err != nil {
				return err
			}
			if !current.EffectiveActive || current.Revision != target.Server.Revision || providerFingerprint(current) != target.Fingerprint {
				return ErrConflict
			}
			var otherOwner bool
			if err := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM service_accounts a JOIN service_links l ON l.service_uuid=a.uuid AND l.link_kind='owner' JOIN provisioning_jobs j ON j.id=? WHERE a.server_id=? AND a.external_user_id=? AND l.user_uuid!=j.user_uuid)`, jobID, target.Server.ID, target.Step.RemoteID).Scan(&otherOwner); err != nil {
				return err
			}
			if otherOwner {
				return ErrConflict
			}
		}
		if (state == "disabled" || state == "absent") && !target.Manual {
			if _, err := tx.ExecContext(ctx, "UPDATE media_servers SET revision=revision+1 WHERE id=?", target.Server.ID); err != nil {
				return err
			}
			nextRevision++
			if _, err := tx.ExecContext(ctx, "UPDATE service_accounts SET is_active=0,updated_at=? WHERE server_id=? AND external_user_id=?", utcTimestamp(time.Now()), target.Server.ID, target.Step.RemoteID); err != nil {
				return err
			}
		}
		_, err := tx.ExecContext(ctx, "UPDATE provisioning_steps SET cleanup_state=?,cleanup_error_code=nullif(?,''),cleanup_checked_at=? WHERE job_id=? AND server_id=?", state, code, utcTimestamp(time.Now()), jobID, target.Server.ID)
		return err
	})
	if err == nil {
		target.Server.Revision = nextRevision
	}
	return err
}

func (a *App) finishReview(jobID, token, code string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	return a.store.write(ctx, func(tx *sql.Tx) error {
		if _, err := tx.ExecContext(ctx, `UPDATE provisioning_steps SET cleanup_state='unknown',cleanup_error_code='REVIEW_REQUIRED' WHERE job_id=? AND cleanup_state='running' AND EXISTS(SELECT 1 FROM provisioning_jobs WHERE id=? AND review_token=?)`, jobID, jobID, token); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, "UPDATE provisioning_steps SET resume_state='unknown',resume_error_code='RESUME_REVIEW_REQUIRED' WHERE job_id=? AND resume_state='running' AND EXISTS(SELECT 1 FROM provisioning_jobs WHERE id=? AND review_token=?)", jobID, jobID, token); err != nil {
			return err
		}
		_, err := tx.ExecContext(ctx, "UPDATE provisioning_jobs SET review_token=NULL,review_actor_uuid=NULL,review_access_hash=NULL,review_role_revision=NULL,review_operation=NULL,review_error_code=nullif(?,''),revision=revision+1,updated_at=? WHERE id=? AND review_token=?", code, utcTimestamp(time.Now()), jobID, token)
		return err
	})
}

func (a *App) reviewProvisioningJob(w http.ResponseWriter, r *http.Request) {
	p, ok := a.principal(w, r, true)
	if !ok {
		return
	}
	var input reviewInput
	if !decodeStrictBody(w, r, &input) {
		return
	}
	input.Reason = strings.TrimSpace(input.Reason)
	if input.Revision < 1 || len(input.Reason) < 10 || len(input.Reason) > 1000 || !input.AcknowledgeRisk || len(input.Manual) > 20 {
		fail(w, 400, "REVIEW_REQUIRED", "Provide the current revision, a reason of 10–1000 bytes and acknowledgment of uncertain in-flight provider outcomes")
		return
	}
	cancelJob := r.PathValue("action") == "cancel"
	if !cancelJob && (input.ReleaseUsername || len(input.Manual) > 0) {
		fail(w, 400, "INVALID_REVIEW", "Manual resolutions and username release apply only to cancellation")
		return
	}
	ctx, done, ok := a.startReviewOperation(w, r)
	if !ok {
		return
	}
	defer done()
	jobID := r.PathValue("job")
	token, err := a.claimReview(ctx, p.UUID, bearer(r), jobID, input.Revision)
	if err != nil {
		domainError(w, err)
		return
	}
	code := "REVIEW_REQUIRED"
	// Cleanup must run before the operation leaves the tracked shutdown group.
	finished := false
	defer func() {
		if !finished {
			_ = a.finishReview(jobID, token, code)
		}
	}()
	job, err := a.loadRedemption(ctx, jobID)
	var targets []reviewTarget
	if err == nil {
		targets, err = a.reviewTargets(ctx, job)
	}
	manual := map[int64]string{}
	for _, resolution := range input.Manual {
		reason := strings.TrimSpace(resolution.Reason)
		if resolution.ServerID < 1 || manual[resolution.ServerID] != "" || len(reason) < 10 || len(reason) > 1000 {
			err = ErrConflict
			break
		}
		manual[resolution.ServerID] = reason
	}
	if err == nil {
		for id := range manual {
			found := false
			for _, target := range targets {
				if target.Server.ID == id && (target.Manual || target.Step.Cleanup == "failed" || target.Step.Cleanup == "unknown") {
					found = true
				}
			}
			if !found {
				err = ErrConflict
				break
			}
		}
	}
	proofs := map[int64]string{}
	if err == nil {
		for index := range targets {
			target := &targets[index]
			if cancelJob && manual[target.Server.ID] != "" {
				target.Manual = true
			}
			if target.Step.Stage == "pending" {
				err = a.reviewCheckpoint(ctx, p.UUID, jobID, token, target, "not_started", "")
				if err == nil {
					proofs[target.Server.ID] = "not_started"
				}
				if err != nil {
					break
				}
				continue
			}
			if target.Manual {
				if cancelJob && manual[target.Server.ID] != "" {
					err = a.reviewCheckpoint(ctx, p.UUID, jobID, token, target, "manual", "")
					if err == nil {
						proofs[target.Server.ID] = "manual"
					}
					if err != nil {
						break
					}
				} else {
					_ = a.reviewCheckpoint(ctx, p.UUID, jobID, token, target, "unknown", "MANUAL_RESOLUTION_REQUIRED")
				}
				continue
			}
			err = a.reviewCheckpoint(ctx, p.UUID, jobID, token, target, "running", "")
			if err != nil {
				break
			}
			provider, newErr := newServerConnection(ProviderConfig{target.Server.Type, target.Server.URL, target.Server.apiKey}, a.ProviderHTTP)
			if newErr != nil {
				err = newErr
				break
			}
			client := provider
			client.reviewAuthority = &reviewRequestAuthority{a.store, p.UUID, jobID, token}
			user, remoteErr := client.inspectProvisionedUser(ctx, target.Step.RemoteID, target.Step.RemoteName)
			if remoteErr == nil && !user.Absent && !user.Disabled && !cancelJob {
				remoteErr = a.reviewCheckpoint(ctx, p.UUID, jobID, token, target, "running", "")
				if remoteErr == nil {
					remoteErr = client.disableProvisionedUser(ctx, user)
				}
				if remoteErr == nil {
					user, remoteErr = client.inspectProvisionedUser(ctx, target.Step.RemoteID, target.Step.RemoteName)
				}
			}
			state := "disabled"
			if user.Absent {
				state = "absent"
			}
			if remoteErr != nil || !user.Absent && !user.Disabled {
				_ = a.reviewCheckpoint(ctx, p.UUID, jobID, token, target, "failed", "REMOTE_RECONCILIATION_REQUIRED")
				continue
			}
			err = a.reviewCheckpoint(ctx, p.UUID, jobID, token, target, state, "")
			if err != nil {
				break
			}
			proofs[target.Server.ID] = state
		}
	}
	if err == nil && cancelJob {
		if len(proofs) != len(targets) {
			err = ErrConflict
		} else {
			err = a.cancelReviewedJob(ctx, p.UUID, job, token, targets, proofs, manual, input)
		}
	}
	if err == nil && len(proofs) == len(targets) {
		code = ""
	}
	if err == nil && !cancelJob {
		err = a.store.write(ctx, func(tx *sql.Tx) error {
			if err := reviewPermission(ctx, tx, p.UUID, jobID, token); err != nil {
				return err
			}
			return auditReview(ctx, tx, p.UUID, jobID, "provisioning.disable_accounts", map[string]any{"reason": input.Reason, "acknowledge_in_flight_risk": true, "outcomes": proofs})
		})
	}
	if saveErr := a.finishReview(jobID, token, code); saveErr != nil {
		fail(w, 503, "REVIEW_STATE_UNCERTAIN", "Could not save the review outcome; keep the reservation held and inspect the job")
		return
	}
	finished = true
	if err != nil {
		domainError(w, err)
		return
	}
	result, err := a.loadRedemption(r.Context(), jobID)
	if err != nil {
		domainError(w, err)
		return
	}
	if err := a.populateReviewFlags(r.Context(), &result); err != nil {
		domainError(w, err)
		return
	}
	respond(w, 200, result)
}

func (a *App) cancelReviewedJob(ctx context.Context, actor string, job redemptionJob, token string, targets []reviewTarget, proofs map[int64]string, manual map[int64]string, input reviewInput) error {
	return a.store.write(ctx, func(tx *sql.Tx) error {
		if err := reviewPermission(ctx, tx, actor, job.ID, token); err != nil {
			return err
		}
		var unresolvedPlex bool
		if err := tx.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM plex_share_checkpoints WHERE job_id=? AND state!='cancelled')", job.ID).Scan(&unresolvedPlex); err != nil {
			return err
		}
		if unresolvedPlex {
			return ErrConflict
		}
		var provisional bool
		if err := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM user_accounts u JOIN provisioning_jobs j ON j.user_uuid=u.uuid WHERE j.id=? AND u.kind='local' AND u.is_active=0 AND u.used_invite_id=j.invite_id AND NOT EXISTS(SELECT 1 FROM admin_privileges WHERE user_uuid=u.uuid) AND NOT EXISTS(SELECT 1 FROM service_links l WHERE l.user_uuid=u.uuid AND l.service_uuid NOT IN (SELECT a.uuid FROM service_accounts a JOIN provisioning_steps s ON s.server_id=a.server_id AND s.remote_id=a.external_user_id WHERE s.job_id=j.id)))`, job.ID).Scan(&provisional); err != nil {
			return err
		}
		if !provisional {
			return ErrConflict
		}
		for _, target := range targets {
			if proofs[target.Server.ID] == "" {
				return ErrConflict
			}
			if !target.Manual && target.Step.Stage != "pending" {
				current, err := scanServer(tx.QueryRowContext(ctx, serverSelect+" WHERE s.id=?", target.Server.ID))
				if err != nil {
					return err
				}
				if current.Revision != target.Server.Revision || providerFingerprint(current) != target.Fingerprint || !current.EffectiveActive {
					return ErrConflict
				}
			}
			if _, err := tx.ExecContext(ctx, "UPDATE media_servers SET revision=revision+1 WHERE id=?", target.Server.ID); err != nil {
				return err
			}
			if _, err := tx.ExecContext(ctx, `UPDATE service_accounts SET is_active=0,updated_at=? WHERE server_id=? AND external_user_id=? AND uuid IN (SELECT service_uuid FROM service_links WHERE user_uuid=?)`, utcTimestamp(time.Now()), target.Server.ID, target.Step.RemoteID, job.UserUUID); err != nil {
				return err
			}
		}
		now := utcTimestamp(time.Now())
		if _, err := tx.ExecContext(ctx, "UPDATE provisioning_jobs SET resolution='cancelled',reservation_held=0,error_code='CANCELLED',revision=revision+1,updated_at=? WHERE id=? AND review_token=?", now, job.ID, token); err != nil {
			return err
		}
		if input.ReleaseUsername {
			if _, err := tx.ExecContext(ctx, "UPDATE user_accounts SET local_username=NULL,updated_at=? WHERE uuid=?", now, job.UserUUID); err != nil {
				return err
			}
		}
		if _, err := tx.ExecContext(ctx, "DELETE FROM app_sessions WHERE user_uuid=?", job.UserUUID); err != nil {
			return err
		}
		return auditReview(ctx, tx, actor, job.ID, "provisioning.cancel", map[string]any{"reason": input.Reason, "acknowledge_in_flight_risk": true, "release_username": input.ReleaseUsername, "outcomes": proofs, "manual_resolutions": manual})
	})
}

func (p *serverConnection) disableProvisionedUser(ctx context.Context, user remoteReview) error {
	if m, ok := p.module().(accountDisabler); ok {
		return m.DisableAccount(ctx, user)
	}
	return ErrConflict
}
