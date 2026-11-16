package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"time"
)

// 4K transcoding policy (user decision 2026-11-15). After each activity
// snapshot, a stream whose server is transcoding a 4K source for a server
// account with 4K transcoding turned off is stopped, with a message to the
// viewer. Each playback is attempted once: the attempt is recorded before the
// server is asked and never repeated. Servers are contacted outside any
// transaction, and every attempt is audited with its outcome.

const transcodePolicyMessage = "4K transcoding is turned off for your account."

// maxPolicyStops bounds the stops attempted after one snapshot.
const maxPolicyStops = 20

func (a *App) enforceTranscodePolicy(ctx context.Context, serverID int64, kind string, connection *serverConnection, snapshot activitySnapshot) {
	terminator, supported := connection.module().(sessionTerminator)
	if !supported {
		return
	}
	attempts := 0
	for _, session := range snapshot.Sessions {
		if !session.Transcode4K || attempts == maxPolicyStops || ctx.Err() != nil {
			continue
		}
		history, service, claimed, err := a.claimTranscodeStop(ctx, serverID, session.Session)
		if err != nil {
			a.logger.Warn("4K transcoding check failed", "server_id", serverID, "code", consoleErrorCode(err))
			return
		}
		if !claimed {
			continue
		}
		attempts++
		stop, cancel := context.WithTimeout(ctx, 10*time.Second)
		outcome := terminateOutcome(terminator.TerminateSession(stop, session.Session, transcodePolicyMessage))
		cancel()
		details, _ := json.Marshal(map[string]any{"server_id": serverID, "history_id": history, "service_uuid": service, "provider": kind, "outcome": outcome, "reason": "4k_transcode"})
		record, done := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
		err = a.store.write(record, func(tx *sql.Tx) error {
			if _, err := tx.ExecContext(record, "UPDATE transcode_policy_stops SET outcome=? WHERE history_id=?", outcome, history); err != nil {
				return err
			}
			_, err := tx.ExecContext(record, "INSERT INTO audit_events(actor_uuid,action,details,occurred_at) VALUES(NULL,'stream.policy_stop',?,?)", string(details), utcTimestamp(time.Now()))
			return err
		})
		done()
		if err != nil {
			a.logger.Warn("4K transcoding stop not recorded", "server_id", serverID, "history_id", history, "outcome", outcome, "code", consoleErrorCode(err))
		} else {
			a.logger.Info("4K transcoding stop", "server_id", serverID, "history_id", history, "outcome", outcome)
		}
	}
}

// claimTranscodeStop records the one stop attempt for the stream's current
// playback, rechecking the account's setting inside the transaction. It
// reports false when the setting allows 4K, the stream is gone, its server is
// inactive or the playback was already attempted.
func (a *App) claimTranscodeStop(ctx context.Context, serverID int64, session string) (int64, string, bool, error) {
	var history int64
	var service string
	claimed := false
	err := a.store.write(ctx, func(tx *sql.Tx) error {
		err := tx.QueryRowContext(ctx, `SELECT c.history_id,h.service_uuid FROM media_activity_current c
		 JOIN media_activity_history h ON h.id=c.history_id
		 JOIN service_accounts a ON a.uuid=h.service_uuid
		 JOIN media_servers s ON s.id=c.server_id
		 WHERE c.server_id=? AND c.external_session_id=? AND a.allow_4k_transcode=0 AND s.is_active=1
		 AND NOT EXISTS(SELECT 1 FROM transcode_policy_stops WHERE history_id=c.history_id)`, serverID, session).Scan(&history, &service)
		if errors.Is(err, sql.ErrNoRows) {
			return nil
		}
		if err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, "INSERT INTO transcode_policy_stops(history_id,attempted_at,outcome) VALUES(?,?,'pending')", history, utcTimestamp(time.Now())); err != nil {
			return err
		}
		claimed = true
		return nil
	})
	return history, service, claimed, err
}
