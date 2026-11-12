package main

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"time"
)

type editLocalSelection struct {
	Fingerprint string
	Outcome     string
	Reason      string
	Local       bool
	Owner       string
	ExpiresAt   *string
}

func editLocalExpiry(op editOperationInput, before *string, now time.Time) (*string, error) {
	switch op.Action {
	case "clear_expiration":
		return nil, nil
	case "set_expiration":
		if op.ExpiresAt == nil {
			return nil, ErrConflict
		}
		deadline, err := time.Parse(time.RFC3339, *op.ExpiresAt)
		if err != nil || len(*op.ExpiresAt) != 20 || deadline.UTC().Format(time.RFC3339) != *op.ExpiresAt || !deadline.After(now) {
			return nil, ErrConflict
		}
		value := *op.ExpiresAt
		return &value, nil
	case "extend_access":
		if op.Days < 1 || op.Days > 36500 {
			return nil, ErrConflict
		}
		start := now
		if before != nil {
			prior, err := time.Parse(time.RFC3339Nano, *before)
			if err != nil {
				return nil, ErrConflict
			}
			if prior.After(start) {
				start = prior
			}
		}
		deadline := start.Add(time.Duration(op.Days) * 24 * time.Hour).UTC()
		if deadline.Year() > 9999 || !deadline.After(now) {
			return nil, ErrConflict
		}
		value := deadline.Format("2006-01-02T15:04:05Z")
		return &value, nil
	}
	return nil, ErrConflict
}

func prepareEditLocal(ctx context.Context, tx *sql.Tx, actor, access, target string, op editOperationInput) (editLocalSelection, error) {
	out := editLocalSelection{Outcome: "updated"}
	if err := accountPreferenceAuthority(ctx, tx, actor, access); err != nil {
		return out, err
	}
	var kind string
	err := tx.QueryRowContext(ctx, "SELECT kind FROM identities WHERE uuid=?", target).Scan(&kind)
	if errors.Is(err, sql.ErrNoRows) {
		out.Outcome = "skipped"
		out.Reason = "not_found"
		return out, nil
	}
	if err != nil {
		return out, err
	}
	out.Local = kind != "service"
	if op.Action == "link_local" || op.Action == "unlink_local" || op.Action == "delete_users" {
		var busy bool
		err = tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM edit_source_locks b JOIN service_accounts a ON a.server_id=b.server_id WHERE b.operation_id<>? AND (a.uuid=? OR EXISTS(SELECT 1 FROM service_links l WHERE l.service_uuid=a.uuid AND l.user_uuid=?)))`, editContextOperation(ctx), target, target).Scan(&busy)
		if err != nil {
			return out, err
		}
		if busy {
			out.Outcome = "skipped"
			out.Reason = "pending_work"
			out.Fingerprint = editHash([]string{target, op.Action, "pending_work"})
			return out, nil
		}
	}

	var snapshot any
	switch op.Action {
	case "extend_access", "set_expiration", "clear_expiration":
		var before *string
		if out.Local {
			current, e := readHumanExpiry(ctx, tx, actor, access, target)
			if e != nil {
				return out, e
			}
			snapshot = current
			before = current.Expires
			if !current.CanEdit {
				out.Outcome = "skipped"
				out.Reason = current.Reason
			}
		} else {
			current, e := readServiceExpiry(ctx, tx, actor, access, target)
			if e != nil {
				return out, e
			}
			snapshot = current
			before = current.Expires
			if current.Owner != nil {
				out.Owner = *current.Owner
			}
			if !current.CanEdit {
				out.Outcome = "skipped"
				out.Reason = current.Reason
			}
		}
		out.ExpiresAt, err = editLocalExpiry(op, before, time.Now())
		if err != nil {
			return out, err
		}
		if out.Outcome != "skipped" && sameHumanExpiry(before, out.ExpiresAt) {
			out.Outcome = "unchanged"
		}
	case "link_local", "unlink_local":
		if out.Local {
			out.Outcome = "skipped"
			out.Reason = "service_account_required"
			break
		}
		owner := op.TargetLocalUserUUID
		if op.Action == "unlink_local" && owner == "" {
			e := tx.QueryRowContext(ctx, "SELECT user_uuid FROM service_links WHERE service_uuid=? AND link_kind='owner'", target).Scan(&owner)
			if errors.Is(e, sql.ErrNoRows) {
				out.Outcome = "unchanged"
				break
			}
			if e != nil {
				return out, e
			}
		}
		current, e := readAccountLink(ctx, tx, actor, access, owner, target)
		if e != nil {
			return out, e
		}
		out.Owner = owner
		var retired bool
		if e = tx.QueryRowContext(ctx, "SELECT deleted_at IS NOT NULL FROM user_accounts WHERE uuid=?", owner).Scan(&retired); e != nil {
			return out, e
		}
		var primary sql.NullString
		if e = tx.QueryRowContext(ctx, "SELECT user_uuid FROM service_links WHERE service_uuid=? AND link_kind='owner'", target).Scan(&primary); e != nil && !errors.Is(e, sql.ErrNoRows) {
			return out, e
		}
		snapshot = struct {
			Link    accountLinkRecord
			Primary sql.NullString
			Retired bool
		}{current, primary, retired}
		if retired {
			out.Outcome = "skipped"
			out.Reason = "deleted"
		} else if op.Action == "link_local" {
			if primary.Valid && primary.String == owner {
				out.Outcome = "unchanged"
			} else if !current.CanLink {
				out.Outcome = "skipped"
				out.Reason = "link_unavailable"
			}
		} else if !current.CanUnlink {
			out.Outcome = "skipped"
			out.Reason = "not_primary_owner"
		}
	case "delete_users":
		if !out.Local {
			out.Outcome = "skipped"
			out.Reason = "provider_operation_required"
			break
		}
		if err = requirePermission(ctx, tx, actor, "administrator"); err != nil {
			return out, err
		}
		var localKind string
		var deleted, admin, running, plex bool
		var profile, roles int64
		err = tx.QueryRowContext(ctx, `SELECT u.kind,u.deleted_at IS NOT NULL,EXISTS(SELECT 1 FROM admin_privileges WHERE user_uuid=u.uuid),EXISTS(SELECT 1 FROM provisioning_jobs WHERE user_uuid=u.uuid AND resolution IS NULL AND (status IN ('pending','running') OR review_token IS NOT NULL)),EXISTS(SELECT 1 FROM plex_connections WHERE owner_uuid=u.uuid AND status='active'),u.profile_revision,(SELECT revision FROM admin_role_state WHERE singleton=1) FROM user_accounts u WHERE uuid=?`, target).Scan(&localKind, &deleted, &admin, &running, &plex, &profile, &roles)
		if err != nil {
			return out, err
		}
		snapshot = []any{localKind, deleted, admin, running, plex, profile, roles}
		switch {
		case localKind == "owner":
			out.Reason = "protected_owner"
		case target == actor:
			out.Reason = "protected_self"
		case deleted:
			out.Reason = "already_deleted"
		case admin:
			out.Reason = "administrator"
		case running:
			out.Reason = "invite_in_progress"
		case plex:
			out.Reason = "plex_connection"
		}
		if out.Reason != "" {
			out.Outcome = "skipped"
		} else {
			out.Outcome = "deleted"
		}
	default:
		return out, ErrConflict
	}
	data, err := json.Marshal(struct {
		Target          string
		Operation       editOperationInput
		State           any
		Outcome, Reason string
	}{target, op, snapshot, out.Outcome, out.Reason})
	if err != nil {
		return out, err
	}
	sum := sha256.Sum256(data)
	out.Fingerprint = hex.EncodeToString(sum[:])
	return out, nil
}

// The coordinator compares every frozen fingerprint before starting the group.
// Re-reading live guards here deliberately ignores global revision increments
// produced by preceding members of that same short transaction.
func applyEditLocal(ctx context.Context, tx *sql.Tx, actor, access, target string, op editOperationInput, prepared editLocalSelection) (editUserResult, error) {
	current, err := prepareEditLocal(ctx, tx, actor, access, target, op)
	if err != nil {
		return editUserResult{}, err
	}
	result := editUserResult{UUID: target, Outcome: current.Outcome, Reason: current.Reason, local: current.Local}
	if prepared.Outcome == "skipped" || prepared.Outcome == "unchanged" {
		result.Outcome = prepared.Outcome
		result.Reason = prepared.Reason
		return result, nil
	}
	if current.Outcome == "skipped" {
		return result, nil
	}
	now := utcTimestamp(time.Now())
	switch op.Action {
	case "delete_users":
		if !current.Local {
			return result, ErrForbidden
		}
		request, _ := http.NewRequestWithContext(ctx, http.MethodPost, "/", nil)
		return editDeleteOne(request, tx, actor, target, now)
	case "link_local", "unlink_local":
		if current.Outcome == "unchanged" {
			return result, nil
		}
		if op.Action == "link_local" {
			_, err = tx.ExecContext(ctx, "INSERT INTO service_links(user_uuid,service_uuid,link_kind,created_by,created_at) VALUES(?,?,'owner',?,?)", current.Owner, target, actor, now)
		} else {
			_, err = tx.ExecContext(ctx, "DELETE FROM service_links WHERE user_uuid=? AND service_uuid=? AND link_kind='owner'", current.Owner, target)
		}
		if err != nil {
			return result, err
		}
		err = auditAction(ctx, tx, actor, "service."+op.Action)
	default:
		// Freeze extension at preparation; a queue delay must not silently extend it.
		after := prepared.ExpiresAt
		if after != nil {
			deadline, e := time.Parse(time.RFC3339, *after)
			if e != nil || !deadline.After(time.Now()) {
				return result, ErrConflict
			}
		}
		if current.Local {
			_, err = tx.ExecContext(ctx, "UPDATE user_accounts SET access_expires_at=?,profile_revision=profile_revision+1,updated_at=? WHERE uuid=?", after, now, target)
			if err == nil {
				err = revokeHumanSignIn(ctx, tx, target, now)
			}
		} else {
			_, err = tx.ExecContext(ctx, "UPDATE service_accounts SET access_expires_at=?,updated_at=? WHERE uuid=?", after, now, target)
		}
		if err == nil {
			err = auditAction(ctx, tx, actor, "edit."+op.Action)
		}
	}
	return result, err
}
