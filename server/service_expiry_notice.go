package main

import (
	"context"
	"database/sql"
	"time"
)

func (a *App) reconcileServiceExpiry(parent context.Context) error {
	ctx, cancel := context.WithTimeout(parent, 5*time.Second)
	defer cancel()
	err := a.store.write(ctx, func(tx *sql.Tx) error {
		if _, err := tx.ExecContext(ctx, `UPDATE admin_notifications SET resolved=1 WHERE id IN (SELECT n.id FROM admin_notifications n JOIN service_expiry_state e ON e.uuid=n.subject_uuid WHERE n.notification_type='SERVICE_EXPIRED' AND n.resolved=0 AND n.expiry_revision<>e.revision ORDER BY n.id LIMIT 100)`); err != nil {
			return err
		}
		rows, err := tx.QueryContext(ctx, `SELECT s.uuid,e.revision FROM service_accounts s JOIN service_expiry_state e ON e.uuid=s.uuid WHERE s.access_expires_at IS NOT NULL AND julianday(s.access_expires_at)<=julianday('now') AND NOT EXISTS(SELECT 1 FROM admin_notifications n WHERE n.notification_type='SERVICE_EXPIRED' AND n.subject_uuid=s.uuid AND n.expiry_revision=e.revision) ORDER BY s.uuid LIMIT 100`)
		if err != nil {
			return err
		}
		type expiredService struct {
			uuid     string
			revision int64
		}
		var batch []expiredService
		for rows.Next() {
			var item expiredService
			if err = rows.Scan(&item.uuid, &item.revision); err != nil {
				break
			}
			batch = append(batch, item)
		}
		if err == nil {
			err = rows.Err()
		}
		rows.Close()
		if err != nil {
			return err
		}
		var owner string
		if len(batch) > 0 {
			if err = tx.QueryRowContext(ctx, "SELECT uuid FROM user_accounts WHERE kind='owner'").Scan(&owner); err != nil {
				return err
			}
		}
		for _, item := range batch {
			if _, err = tx.ExecContext(ctx, `INSERT INTO admin_notifications(notification_type,audience,recipient_uuid,subject_uuid,expiry_revision) VALUES('SERVICE_EXPIRED','recipient',?,?,?)`, owner, item.uuid, item.revision); err != nil {
				return err
			}
			if _, err = tx.ExecContext(ctx, `INSERT INTO audit_events(actor_uuid,action,details,occurred_at) VALUES(NULL,'service.expiry.reconcile',json_object('target_uuid',?,'expiry_revision',?,'local_only',json('true'),'remote_access_changed',json('false')),?)`, item.uuid, item.revision, utcTimestamp(time.Now())); err != nil {
				return err
			}
		}
		return nil
	})
	if parent.Err() != nil {
		return nil
	}
	return err
}
