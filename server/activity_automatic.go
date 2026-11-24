package main

import (
	"context"
	"database/sql"
	"errors"
)

// reconcileAutomaticActivity binds supported active servers to the current
// owner and connection revision. Stale in-flight reads lose their claim before
// a new observation is scheduled.
func reconcileAutomaticActivity(ctx context.Context, tx *sql.Tx) error {
	var owner string
	err := tx.QueryRowContext(ctx, `SELECT uuid FROM user_accounts WHERE kind='owner' AND is_active=1 AND (access_expires_at IS NULL OR julianday(access_expires_at)>julianday('now')) LIMIT 1`).Scan(&owner)
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	stale := `SELECT q.server_id FROM activity_monitor_schedules q JOIN media_servers s ON s.id=q.server_id JOIN provider_settings p ON p.provider_id=s.service_type WHERE s.is_active=1 AND p.enabled=1 AND s.service_type IN ('plex','jellyfin','emby','tofa') AND (q.enabled=0 OR q.socket_enabled=0 OR q.authorized_by IS NOT ? OR q.configured_server_revision IS NOT s.config_revision)`
	if _, err := tx.ExecContext(ctx, `UPDATE media_activity_state SET pending_token=NULL,pending_at=NULL,pending_until=NULL,last_result='failed',revision=revision+1 WHERE server_id IN (`+stale+`) AND pending_token IS NOT NULL AND pending_token=(SELECT claim_token FROM activity_monitor_schedules q WHERE q.server_id=media_activity_state.server_id)`, owner); err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `UPDATE activity_monitor_schedules SET enabled=1,socket_enabled=1,socket_revision=socket_revision+1,socket_pending=0,authorized_by=?,configured_server_revision=(SELECT config_revision FROM media_servers WHERE id=server_id),next_run_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),run_state=CASE WHEN run_state='running' THEN 'cancelled' ELSE run_state END,last_code=CASE WHEN run_state='running' THEN 'CANCELLED' ELSE last_code END,finished_at=CASE WHEN run_state='running' THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') ELSE finished_at END,claim_token=NULL,runner_id=NULL,lease_until=NULL,revision=revision+1 WHERE server_id IN (`+stale+`)`, owner, owner)
	return err
}
