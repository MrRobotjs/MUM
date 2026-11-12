package main

import (
	"context"
	"database/sql"
	"strings"
	"time"
)

// Receipt DTOs deliberately contain no Plex account/share/machine IDs, device
// identity, token, lease value, provider fingerprint or ciphertext.
type plexShareReceipt struct {
	CompletionRecorded     bool   `json:"completion_recorded,omitempty"`
	VerificationScope      string `json:"verification_scope,omitempty"`
	VerifiedAt             string `json:"verified_at,omitempty"`
	State                  string `json:"state"`
	Revision               int64  `json:"revision"`
	OperationInProgress    bool   `json:"operation_in_progress"`
	ReconciliationRequired bool   `json:"reconciliation_required"`
	AccessVerified         bool   `json:"access_verified"`
	CleanupScope           string `json:"cleanup_scope"`
}
type plexJobProgress struct {
	Phase               string `json:"phase"`
	RequiresReview      bool   `json:"requires_review"`
	OperationInProgress bool   `json:"operation_in_progress"`
	CompletionAvailable bool   `json:"completion_available"`
}
type plexShareReceiptRow struct {
	job     string
	server  int64
	receipt plexShareReceipt
}

func readPlexShareReceipts(ctx context.Context, tx *sql.Tx, ids []string) ([]plexShareReceiptRow, error) {
	result := []plexShareReceiptRow{}
	if len(ids) == 0 {
		return result, nil
	}
	if len(ids) > 101 {
		return nil, ErrConflict
	}
	args := make([]any, 0, len(ids))
	for _, id := range ids {
		args = append(args, id)
	}
	placeholders := strings.TrimSuffix(strings.Repeat("?,", len(ids)), ",")
	rows, err := tx.QueryContext(ctx, `SELECT c.job_id,c.server_id,c.state,c.revision,c.operation_token IS NOT NULL,coalesce(c.operation_expires_at,''),m.service_type,coalesce(f.verification_scope,''),coalesce(f.verified_at,''),f.job_id IS NOT NULL AND j.status='completed' AND j.revision=f.job_revision AND j.user_uuid=f.user_uuid AND c.state='access_observed' AND c.operation_token IS NULL AND s.status='completed' AND s.stage='completed' FROM plex_share_checkpoints c JOIN media_servers m ON m.id=c.server_id JOIN provisioning_jobs j ON j.id=c.job_id JOIN provisioning_steps s ON s.job_id=c.job_id AND s.server_id=c.server_id LEFT JOIN plex_job_completions f ON f.job_id=c.job_id AND f.server_id=c.server_id AND f.checkpoint_revision=c.revision WHERE c.job_id IN (`+placeholders+`) ORDER BY c.job_id,c.server_id`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	now := time.Now()
	for rows.Next() {
		var row plexShareReceiptRow
		var tokenPresent bool
		var deadline, provider, scope, verified string
		var completed bool
		if err := rows.Scan(&row.job, &row.server, &row.receipt.State, &row.receipt.Revision, &tokenPresent, &deadline, &provider, &scope, &verified, &completed); err != nil {
			return nil, err
		}
		if provider != "plex" || row.receipt.Revision < 1 {
			return nil, ErrConflict
		}
		switch row.receipt.State {
		case "prepared", "send_uncertain", "awaiting_acceptance", "access_observed", "cancel_uncertain", "cancelled":
		default:
			return nil, ErrConflict
		}
		if tokenPresent {
			expires, err := time.Parse(time.RFC3339Nano, deadline)
			row.receipt.OperationInProgress = err == nil && expires.After(now)
			row.receipt.ReconciliationRequired = !row.receipt.OperationInProgress
		}
		if completed {
			if scope != plexLibraryVerificationScope {
				return nil, ErrConflict
			}
			if _, err := time.Parse(time.RFC3339Nano, verified); err != nil {
				return nil, ErrConflict
			}
			row.receipt.CompletionRecorded = true
			row.receipt.VerificationScope = scope
			row.receipt.VerifiedAt = verified
		}
		row.receipt.CleanupScope = "none"
		if row.receipt.State == "cancelled" {
			row.receipt.CleanupScope = "owner_cloud_grant"
		}
		result = append(result, row)
		if len(result) > 2020 {
			return nil, ErrConflict
		}
	}
	return result, rows.Err()
}
func summarizePlexReceipts(id, status string, rows []plexShareReceiptRow) *plexJobProgress {
	var result *plexJobProgress
	priority := -1
	allCompleted := true
	for _, row := range rows {
		if row.job != id {
			continue
		}
		if result == nil {
			result = &plexJobProgress{}
		}
		receipt := row.receipt
		allCompleted = allCompleted && receipt.CompletionRecorded
		result.OperationInProgress = result.OperationInProgress || receipt.OperationInProgress
		result.RequiresReview = result.RequiresReview || receipt.ReconciliationRequired
		phase, rank := "cleanup_recorded", 0
		switch receipt.State {
		case "prepared":
			phase, rank = "not_started", 1
		case "awaiting_acceptance":
			phase, rank = "awaiting_acceptance", 2
		case "access_observed":
			phase, rank = "verification_required", 3
			result.RequiresReview = true
		case "send_uncertain":
			phase, rank = "outcome_uncertain", 4
			result.RequiresReview = result.RequiresReview || !receipt.OperationInProgress
		case "cancel_uncertain":
			phase, rank = "cleanup_uncertain", 5
			result.RequiresReview = result.RequiresReview || !receipt.OperationInProgress
		}
		if rank > priority {
			result.Phase = phase
			priority = rank
		}
	}
	if result != nil {
		if status == "completed" {
			if allCompleted {
				result.Phase = "completed"
				result.RequiresReview = false
			} else {
				result.Phase = "review_required"
				result.RequiresReview = true
			}
		}
		if status == "failed" {
			result.RequiresReview = true
		}
		if result.Phase == "cleanup_recorded" {
			if status == "cancelled" {
				result.Phase = "cancelled"
			} else {
				result.RequiresReview = true
			}
		}
		if status == "cancelled" && priority > 0 {
			result.Phase = "review_required"
			result.RequiresReview = true
		}
	}
	return result
}
func attachPlexJobReceipts(job *redemptionJob, rows []plexShareReceiptRow) error {
	for _, row := range rows {
		if row.job != job.ID {
			continue
		}
		found := false
		for i := range job.Steps {
			if job.Steps[i].ServerID == row.server {
				copy := row.receipt
				job.Steps[i].Plex = &copy
				found = true
				break
			}
		}
		if !found {
			return ErrConflict
		}
	}
	job.Plex = summarizePlexReceipts(job.ID, job.Status, rows)
	return nil
}
