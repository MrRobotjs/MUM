package main

import (
	"context"
	"database/sql"
	"time"
)

// This concrete guard is attached only to runtime review/resume providers.
// Neither a stored actor nor a claim token alone substitutes for a live session.
type reviewRequestAuthority struct {
	Store *Store
	Actor string
	Job   string
	Token string
}

func (p *reviewRequestAuthority) check(ctx context.Context) error {
	if p == nil {
		return nil
	}
	tx, err := p.Store.reader.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err = reviewPermission(ctx, tx, p.Actor, p.Job, p.Token); err != nil {
		return err
	}
	return tx.Commit()
}

func reviewSessionAuthority(ctx context.Context, tx *sql.Tx, actor, job, token string) error {
	var valid bool
	now := utcTimestamp(time.Now())
	err := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM provisioning_jobs j
 JOIN session_access_tokens t ON t.token_hash=j.review_access_hash
 JOIN app_sessions s ON s.id=t.session_id AND s.user_uuid=j.review_actor_uuid
 JOIN admin_role_state r ON r.singleton=1 AND r.revision=j.review_role_revision
 WHERE j.id=? AND j.review_token=? AND j.review_actor_uuid=?
 AND t.expires_at>? AND s.refresh_expires_at>?)`, job, token, actor, now, now).Scan(&valid)
	if err != nil {
		return err
	}
	if !valid {
		return ErrForbidden
	}
	return nil
}
