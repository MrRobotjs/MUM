package main

import (
	"context"
	"database/sql"
	"errors"
	"net/http"
	"strconv"
	"strings"
)

// HTTP actions always pass this concrete authority through every mutation
// boundary. Nil is reserved for trusted internal workers without an HTTP actor.
type plexJobAdministrator struct {
	actor, access, job, reason string
	jobRevision                int64
}

func requirePlexJobAdministrator(ctx context.Context, tx *sql.Tx, admin *plexJobAdministrator, job string) error {
	if admin == nil {
		return nil
	}
	if admin.job != job {
		return ErrConflict
	}
	if err := plexSessionOwner(ctx, tx, admin.access, admin.actor); err != nil {
		return err
	}
	if err := requirePermission(ctx, tx, admin.actor, "administrator"); err != nil {
		return err
	}
	var revision int64
	if err := tx.QueryRowContext(ctx, "SELECT revision FROM provisioning_jobs WHERE id=?", admin.job).Scan(&revision); err != nil {
		return err
	}
	if revision != admin.jobRevision {
		return ErrConflict
	}
	return nil
}
func auditPlexJobAdministrator(ctx context.Context, tx *sql.Tx, admin *plexJobAdministrator, job, action string) error {
	if admin == nil {
		return nil
	}
	if admin.job != job {
		return ErrConflict
	}
	return auditReview(ctx, tx, admin.actor, job, action, map[string]any{"reason": admin.reason, "verification_scope": plexLibraryVerificationScope})
}
func (a *App) plexAdministratorJobAction(w http.ResponseWriter, r *http.Request) {
	principal, ok := a.principal(w, r, true)
	if !ok {
		return
	}
	var input struct {
		JobRevision        int64  `json:"job_revision"`
		CheckpointRevision int64  `json:"checkpoint_revision"`
		Reason             string `json:"reason"`
		Scope              string `json:"verification_scope"`
		AcknowledgeRisk    bool   `json:"acknowledge_in_flight_risk"`
		Activate           bool   `json:"acknowledge_local_activation"`
	}
	if !decodeStrictBody(w, r, &input) {
		return
	}
	server, err := strconv.ParseInt(r.PathValue("server"), 10, 64)
	job, action := r.PathValue("job"), r.PathValue("plex_action")
	if action != "verify" && action != "finalize" {
		fail(w, 404, "NOT_FOUND", "Plex job action not found")
		return
	}
	input.Reason = strings.TrimSpace(input.Reason)
	if err != nil || server < 1 || !validProvisionedID(job) || input.JobRevision < 1 || input.CheckpointRevision < 1 || len(input.Reason) < 10 || len(input.Reason) > 1000 || input.Scope != plexLibraryVerificationScope || !input.AcknowledgeRisk || input.Activate != (action == "finalize") {
		fail(w, 400, "PLEX_JOB_CONFIRMATION_REQUIRED", "Provide current job/checkpoint revisions, a reason, the exact verification scope and acknowledgments for this action")
		return
	}
	admin := &plexJobAdministrator{actor: principal.UUID, access: bearer(r), job: job, reason: input.Reason, jobRevision: input.JobRevision}
	err = a.store.write(r.Context(), func(tx *sql.Tx) error {
		if err := requirePlexJobAdministrator(r.Context(), tx, admin, job); err != nil {
			return err
		}
		checkpoint, err := loadPlexShareCheckpoint(r.Context(), tx, job, server)
		if err != nil {
			return err
		}
		if checkpoint.Revision != input.CheckpointRevision {
			return ErrConflict
		}
		return auditPlexJobAdministrator(r.Context(), tx, admin, job, "plex.admin."+action+".requested")
	})
	if err != nil {
		domainError(w, err)
		return
	}
	if action == "verify" {
		err = a.verifyPlexLibraryCompletionAs(r.Context(), job, server, input.CheckpointRevision, admin)
	} else {
		err = a.completeVerifiedPlexJobAs(r.Context(), job, server, input.CheckpointRevision, admin)
	}
	if err != nil {
		if errors.Is(err, ErrForbidden) || errors.Is(err, ErrConflict) {
			domainError(w, err)
		} else {
			fail(w, 409, "PLEX_JOB_ACTION_UNRESOLVED", "The Plex job action could not be confirmed. Read its current receipt before taking another action")
		}
		return
	}
	if _, ok := a.principal(w, r, true); !ok {
		return
	}
	receipt, err := a.loadRedemption(r.Context(), job)
	if err != nil {
		domainError(w, err)
		return
	}
	if err := a.populateReviewFlags(r.Context(), &receipt); err != nil {
		domainError(w, err)
		return
	}
	respond(w, 200, receipt)
}
