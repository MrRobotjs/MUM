package main

import (
	"app/server/providers/provider"
	"context"
	"database/sql"
	"encoding/json"
	"net/http"
	"strings"
	"time"
)

type resumePassword struct {
	ServerID int64  `json:"server_id"`
	Password string `json:"password"`
}
type resumeInput struct {
	Revision             int64            `json:"revision"`
	Reason               string           `json:"reason"`
	AcknowledgeRisk      bool             `json:"acknowledge_in_flight_risk"`
	AcknowledgePasswords bool             `json:"acknowledge_password_changes"`
	Passwords            []resumePassword `json:"server_passwords"`
}
type resumeTarget struct {
	Server      ManagedServer
	Step        redemptionStep
	Grant       InvitationGrant
	Password    string
	Fingerprint string
}

const resumeProfileQuery = `SELECT EXISTS(SELECT 1 FROM user_accounts u WHERE u.uuid=? AND u.kind='local' AND u.is_active=0 AND u.used_invite_id=? AND u.local_username=(SELECT requested_username FROM provisioning_jobs WHERE id=?) AND u.password_hash IS NOT NULL AND NOT EXISTS(SELECT 1 FROM admin_privileges WHERE user_uuid=u.uuid) AND NOT EXISTS(SELECT 1 FROM service_links l WHERE l.user_uuid=u.uuid AND l.service_uuid NOT IN (SELECT a.uuid FROM service_accounts a JOIN provisioning_steps s ON s.server_id=a.server_id AND s.remote_id=a.external_user_id WHERE s.job_id=?)))`

func resumeProfileSafe(ctx context.Context, tx *sql.Tx, job redemptionJob) error {
	var eligible bool
	if err := tx.QueryRowContext(ctx, resumeProfileQuery, job.UserUUID, job.InviteID, job.ID, job.ID).Scan(&eligible); err != nil {
		return err
	}
	if !eligible {
		return ErrConflict
	}
	return nil
}

func (p *serverConnection) resumeRecordedUser(ctx context.Context, target resumeTarget, checkpoint func(string) error) error {
	if m, ok := p.module().(accountResumer); ok {
		return m.ResumeAccount(ctx, provider.Resume{RemoteID: target.Step.RemoteID, RemoteName: target.Step.RemoteName, Grant: target.Grant, Password: target.Password}, checkpoint)
	}
	return ErrConflict
}

func resumeAuthority(ctx context.Context, tx *sql.Tx, actor string, job redemptionJob, token string, target resumeTarget) error {
	if err := reviewPermission(ctx, tx, actor, job.ID, token); err != nil {
		return err
	}
	if err := resumeProfileSafe(ctx, tx, job); err != nil {
		return err
	}
	if err := provisionStillAllowed(ctx, tx, job.InviteID, target.Server); err != nil {
		return err
	}
	current, err := scanServer(tx.QueryRowContext(ctx, serverSelect+" WHERE s.id=?", target.Server.ID))
	if err != nil {
		return err
	}
	if providerFingerprint(current) != target.Fingerprint {
		return ErrConflict
	}
	if _, err := validateInvitationGrant(ctx, tx, target.Grant); err != nil {
		return err
	}
	var conflict bool
	if err := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM service_accounts a JOIN service_links l ON l.service_uuid=a.uuid WHERE a.server_id=? AND a.external_user_id=? AND l.user_uuid!=?)`, target.Server.ID, target.Step.RemoteID, job.UserUUID).Scan(&conflict); err != nil {
		return err
	}
	if conflict {
		return ErrConflict
	}
	return nil
}

func (a *App) prepareResume(ctx context.Context, actor string, job redemptionJob, token string, input resumeInput) ([]resumeTarget, error) {
	passwords := map[int64]string{}
	for _, entry := range input.Passwords {
		if entry.ServerID < 1 || passwords[entry.ServerID] != "" || len(entry.Password) < 12 || len(entry.Password) > 1024 {
			return nil, ErrConflict
		}
		passwords[entry.ServerID] = entry.Password
	}
	if len(passwords) != len(job.Steps) || len(job.Steps) == 0 {
		return nil, ErrConflict
	}
	targets := []resumeTarget{}
	err := a.store.write(ctx, func(tx *sql.Tx) error {
		if err := reviewPermission(ctx, tx, actor, job.ID, token); err != nil {
			return err
		}
		if err := resumeProfileSafe(ctx, tx, job); err != nil {
			return err
		}
		for _, step := range job.Steps {
			if !validProvisionedID(step.RemoteID) || step.RemoteName == "" || passwords[step.ServerID] == "" {
				return ErrConflict
			}
			var fingerprint, snapshot string
			if err := tx.QueryRowContext(ctx, "SELECT coalesce(provider_fingerprint,''),coalesce(grant_snapshot,'') FROM provisioning_steps WHERE job_id=? AND server_id=?", job.ID, step.ServerID).Scan(&fingerprint, &snapshot); err != nil {
				return err
			}
			var grant InvitationGrant
			if json.Unmarshal([]byte(snapshot), &grant) != nil || grant.ServerID != step.ServerID {
				return ErrConflict
			}
			server, err := scanServer(tx.QueryRowContext(ctx, serverSelect+" WHERE s.id=?", step.ServerID))
			if err != nil {
				return err
			}
			if !supportsRecordedRecovery(server.Type) || fingerprint == "" || fingerprint != providerFingerprint(server) {
				return ErrConflict
			}
			if m := moduleRules(server.Type); m != nil {
				if rule, ok := m.(grantRule); ok && !rule.ValidGrant(grant) {
					return ErrConflict
				}
				if rule, ok := m.(recordedIDRule); ok && !rule.ValidRecordedID(step.RemoteID) {
					return ErrConflict
				}
			}
			if checker, ok := moduleRules(server.Type).(credentialChecker); ok {
				if err := checker.CheckCredentials(step.RemoteName, passwords[step.ServerID]); err != nil {
					return err
				}
			}
			target := resumeTarget{server, step, grant, passwords[step.ServerID], fingerprint}
			if err := resumeAuthority(ctx, tx, actor, job, token, target); err != nil {
				return err
			}
			targets = append(targets, target)
		}
		if _, err := tx.ExecContext(ctx, "UPDATE provisioning_jobs SET review_operation='resume' WHERE id=? AND review_token=?", job.ID, token); err != nil {
			return err
		}
		return auditReview(ctx, tx, actor, job.ID, "provisioning.resume.start", map[string]any{"reason": input.Reason, "acknowledge_in_flight_risk": true, "server_passwords_will_change": true})
	})
	return targets, err
}

func (a *App) resumeCheckpoint(ctx context.Context, actor string, job redemptionJob, token string, target *resumeTarget, stage string) error {
	nextRevision := target.Server.Revision
	err := a.store.write(ctx, func(tx *sql.Tx) error {
		if err := resumeAuthority(ctx, tx, actor, job, token, *target); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, "UPDATE media_servers SET revision=revision+1 WHERE id=?", target.Server.ID); err != nil {
			return err
		}
		nextRevision++
		_, err := tx.ExecContext(ctx, "UPDATE provisioning_steps SET resume_state='running',resume_error_code=NULL,stage=?,cleanup_state='pending',cleanup_error_code=NULL,cleanup_checked_at=NULL WHERE job_id=? AND server_id=?", "resume_"+stage, job.ID, target.Server.ID)
		return err
	})
	if err == nil {
		target.Server.Revision = nextRevision
	}
	return err
}

func (a *App) commitResumedStep(ctx context.Context, actor string, job redemptionJob, token string, target resumeTarget) error {
	return a.store.write(ctx, func(tx *sql.Tx) error {
		if err := resumeAuthority(ctx, tx, actor, job, token, target); err != nil {
			return err
		}
		var uuid string
		err := tx.QueryRowContext(ctx, "SELECT uuid FROM service_accounts WHERE server_id=? AND external_user_id=?", target.Server.ID, target.Step.RemoteID).Scan(&uuid)
		if err == sql.ErrNoRows {
			uuid = newUUID()
			if _, err := tx.ExecContext(ctx, "INSERT INTO identities(uuid,kind) VALUES(?,'service')", uuid); err != nil {
				return err
			}
		} else if err != nil {
			return err
		}
		now := utcTimestamp(time.Now())
		ids, _ := json.Marshal(target.Grant.LibraryIDs)
		settings, _ := json.Marshal(map[string]bool{"all_libraries": target.Grant.AllLibraries, "library_policy_known": true})
		if _, err := tx.ExecContext(ctx, `INSERT INTO service_accounts(uuid,server_id,external_user_id,external_username,allowed_library_ids,allow_downloads,service_settings,is_active,used_invite_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,1,?,?,?) ON CONFLICT(server_id,external_user_id) DO UPDATE SET external_username=excluded.external_username,allowed_library_ids=excluded.allowed_library_ids,allow_downloads=excluded.allow_downloads,service_settings=excluded.service_settings,is_active=1,updated_at=excluded.updated_at`, uuid, target.Server.ID, target.Step.RemoteID, target.Step.RemoteName, string(ids), target.Grant.AllowDownloads, string(settings), job.InviteID, now, now); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO service_links(user_uuid,service_uuid,link_kind,created_at) VALUES(?,?,'owner',?) ON CONFLICT(user_uuid,service_uuid) DO UPDATE SET link_kind='owner'`, job.UserUUID, uuid, now); err != nil {
			return err
		}
		_, err = tx.ExecContext(ctx, "UPDATE provisioning_steps SET status='completed',stage='completed',error_code=NULL,resume_state='completed',resume_error_code=NULL WHERE job_id=? AND server_id=?", job.ID, target.Server.ID)
		return err
	})
}

func (a *App) completeResumedJob(ctx context.Context, actor string, job redemptionJob, token string, targets []resumeTarget) error {
	return a.store.write(ctx, func(tx *sql.Tx) error {
		for _, target := range targets {
			if err := resumeAuthority(ctx, tx, actor, job, token, target); err != nil {
				return err
			}
		}
		var incomplete bool
		if err := tx.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM provisioning_steps WHERE job_id=? AND (status!='completed' OR resume_state!='completed')) OR EXISTS(SELECT 1 FROM plex_share_checkpoints WHERE job_id=?)", job.ID, job.ID).Scan(&incomplete); err != nil {
			return err
		}
		if incomplete {
			return ErrConflict
		}
		now := utcTimestamp(time.Now())
		if _, err := tx.ExecContext(ctx, "UPDATE provisioning_jobs SET status='completed',reservation_held=0,error_code=NULL,revision=revision+1,updated_at=? WHERE id=? AND review_token=?", now, job.ID, token); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, "UPDATE invites SET current_uses=current_uses+1,updated_at=? WHERE id=?", now, job.InviteID); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, "DELETE FROM app_sessions WHERE user_uuid=?", job.UserUUID); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, "UPDATE user_accounts SET is_active=1,updated_at=? WHERE uuid=?", now, job.UserUUID); err != nil {
			return err
		}
		return auditReview(ctx, tx, actor, job.ID, "provisioning.resume.complete", map[string]any{})
	})
}

func (a *App) resumeProvisioningJob(w http.ResponseWriter, r *http.Request) {
	p, ok := a.principal(w, r, true)
	if !ok {
		return
	}
	var input resumeInput
	if !decodeStrictBody(w, r, &input) {
		return
	}
	input.Reason = strings.TrimSpace(input.Reason)
	if input.Revision < 1 || len(input.Reason) < 10 || len(input.Reason) > 1000 || !input.AcknowledgeRisk || !input.AcknowledgePasswords || len(input.Passwords) < 1 || len(input.Passwords) > 20 {
		fail(w, 400, "INVALID_RESUME", "Provide the current revision, reason, risk/password acknowledgments and passwords for every recorded server")
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
	code := "RESUME_REVIEW_REQUIRED"
	finished := false
	defer func() {
		if !finished {
			_ = a.finishReview(jobID, token, code)
		}
	}()
	job, err := a.loadRedemption(ctx, jobID)
	var targets []resumeTarget
	if err == nil {
		targets, err = a.prepareResume(ctx, p.UUID, job, token, input)
	}
	// Inspect every recorded target before the first remote mutation. Missing IDs
	// and absent accounts never fall back to create or username-based adoption.
	if err == nil {
		for _, target := range targets {
			provider, newErr := newServerConnection(ProviderConfig{target.Server.Type, target.Server.URL, target.Server.apiKey}, a.ProviderHTTP)
			if newErr != nil {
				err = newErr
				break
			}
			provider.reviewAuthority = &reviewRequestAuthority{a.store, p.UUID, jobID, token}
			user, inspectErr := provider.inspectProvisionedUser(ctx, target.Step.RemoteID, target.Step.RemoteName)
			if inspectErr != nil {
				err = inspectErr
				break
			}
			if user.Absent {
				err = ErrConflict
				break
			}
		}
	}
	if err == nil {
		for index := range targets {
			target := &targets[index]
			provider, newErr := newServerConnection(ProviderConfig{target.Server.Type, target.Server.URL, target.Server.apiKey}, a.ProviderHTTP)
			if newErr != nil {
				err = newErr
				break
			}
			provider.reviewAuthority = &reviewRequestAuthority{a.store, p.UUID, jobID, token}
			err = provider.resumeRecordedUser(ctx, *target, func(stage string) error { return a.resumeCheckpoint(ctx, p.UUID, job, token, target, stage) })
			if err != nil {
				break
			}
			if err = a.commitResumedStep(ctx, p.UUID, job, token, *target); err != nil {
				break
			}
		}
	}
	if err == nil {
		err = a.completeResumedJob(ctx, p.UUID, job, token, targets)
	}
	if err == nil {
		code = ""
	}
	if saveErr := a.finishReview(jobID, token, code); saveErr != nil {
		fail(w, 503, "RESUME_STATE_UNCERTAIN", "Could not save the resumption outcome; inspect the held job before continuing")
		return
	}
	finished = true
	if err != nil {
		if credentialsFailure(w, err) {
			// A module's credentials error; credentialsFailure wrote the response.
		} else if err == ErrConflict || err == ErrForbidden {
			domainError(w, err)
		} else {
			fail(w, 502, "RESUME_REVIEW_REQUIRED", "Recorded account resumption did not complete; review the retained job")
		}
		return
	}
	result, err := a.loadRedemption(r.Context(), jobID)
	if err == nil {
		err = a.populateReviewFlags(r.Context(), &result)
	}
	if err != nil {
		domainError(w, err)
		return
	}
	respond(w, 200, result)
}
