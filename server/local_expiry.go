package main

import (
	"context"
	"database/sql"
	"time"
)

// Durable local policy work, not a provider revocation claim or telemetry frame.
// Every batch is atomic and bounded. Immediate authentication expiry remains
// independent of scheduler latency; this removes persisted sign-in authority.
func (a *App) reconcileLocalExpiry(parent context.Context) error {
	ctx, cancel := context.WithTimeout(parent, 5*time.Second)
	defer cancel()
	var revoked []string
	err := a.store.write(ctx, func(tx *sql.Tx) error {
		now := utcTimestamp(time.Now())
		// Resolve obsolete episodes, including changes made while MUM was stopped.
		if _, err := tx.ExecContext(ctx, `UPDATE admin_notifications SET resolved=1 WHERE id IN (SELECT n.id FROM admin_notifications n JOIN human_expiry_state e ON e.uuid=n.subject_uuid WHERE n.notification_type='ACCOUNT_EXPIRED' AND n.resolved=0 AND n.expiry_revision<>e.revision ORDER BY n.id LIMIT 100)`); err != nil {
			return err
		}
		rows, err := tx.QueryContext(ctx, `SELECT u.uuid,e.revision FROM user_accounts u JOIN human_expiry_state e ON e.uuid=u.uuid WHERE u.kind='local' AND u.access_expires_at IS NOT NULL AND julianday(u.access_expires_at)<=julianday(?) AND (
 NOT EXISTS(SELECT 1 FROM admin_notifications n WHERE n.notification_type='ACCOUNT_EXPIRED' AND n.subject_uuid=u.uuid AND n.expiry_revision=e.revision)
 OR EXISTS(SELECT 1 FROM app_sessions s WHERE s.user_uuid=u.uuid)
 OR EXISTS(SELECT 1 FROM plex_authorizations p WHERE p.owner_uuid=u.uuid AND p.status IN ('creating','pending','verified')))
 ORDER BY u.uuid LIMIT 100`, now)
		if err != nil {
			return err
		}
		type expiredHuman struct {
			uuid     string
			revision int64
		}
		var batch []expiredHuman
		for rows.Next() {
			var human expiredHuman
			if err = rows.Scan(&human.uuid, &human.revision); err != nil {
				break
			}
			batch = append(batch, human)
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
		for _, human := range batch {
			if err = revokeHumanSignIn(ctx, tx, human.uuid, now); err != nil {
				return err
			}
			// The owner is the only recipient; role hierarchy is never bypassed
			// by broadcasting a higher administrator's account metadata.
			if _, err = tx.ExecContext(ctx, `INSERT INTO admin_notifications(notification_type,audience,recipient_uuid,subject_uuid,expiry_revision,occurred_at) VALUES('ACCOUNT_EXPIRED','recipient',?,?,?,?) ON CONFLICT(subject_uuid,expiry_revision) WHERE notification_type='ACCOUNT_EXPIRED' DO NOTHING`, owner, human.uuid, human.revision, now); err != nil {
				return err
			}
			if _, err = tx.ExecContext(ctx, `INSERT INTO audit_events(actor_uuid,action,details,occurred_at) VALUES(NULL,'account.expiry.reconcile',json_object('target_uuid',?,'expiry_revision',?,'local_only',json('true'),'sessions_revoked',json('true')),?)`, human.uuid, human.revision, now); err != nil {
				return err
			}
			revoked = append(revoked, human.uuid)
		}
		return nil
	})
	if err != nil {
		if parent.Err() != nil {
			return nil
		}
		return err
	}
	for _, uuid := range revoked {
		a.hub.closeAccountConnections(uuid)
	}
	return nil
}
