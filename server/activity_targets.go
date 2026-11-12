package main

import (
	"context"
	"database/sql"
	"errors"
)

// Target UUIDs come only from the explicit identity route. Human attribution
// is frozen history ownership; service attribution is its stable service UUID.
// No username, display role, delegate link or provider user ID grants access.
func checkActivityTarget(ctx context.Context, tx *sql.Tx, actor string, q activityReadQuery) error {
	if q.Target == "" {
		return nil
	}
	if !validAdminMemberCursor(q.Target) {
		return ErrConflict
	}
	var kind string
	if err := tx.QueryRowContext(ctx, "SELECT kind FROM identities WHERE uuid=?", q.Target).Scan(&kind); err != nil {
		if !q.All && errors.Is(err, sql.ErrNoRows) {
			return ErrForbidden
		}
		return err
	}
	if q.All {
		return nil
	} // beginActivityView already checks live administrator authority.
	if kind == "owner" || kind == "local" {
		if q.Target == actor {
			return nil
		}
		return ErrForbidden
	}
	if kind != "service" {
		return ErrForbidden
	}
	var linked bool
	err := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM service_links WHERE service_uuid=? AND user_uuid=? AND link_kind='owner')`, q.Target, actor).Scan(&linked)
	if err != nil {
		return err
	}
	if !linked {
		return ErrForbidden
	}
	return nil
}

func activityTargetPredicate(q activityReadQuery) (string, []any) {
	if q.Target == "" {
		return "", nil
	}
	return ` AND (h.service_uuid=? OR h.owner_uuid=?)`, []any{q.Target, q.Target}
}
