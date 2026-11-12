package main

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"strings"
)

func newConsoleLogger(out io.Writer, level string) (*slog.Logger, error) {
	var value slog.Level
	switch strings.ToLower(strings.TrimSpace(level)) {
	case "", "info":
		value = slog.LevelInfo
	case "debug":
		value = slog.LevelDebug
	case "warn":
		value = slog.LevelWarn
	case "error":
		value = slog.LevelError
	default:
		return nil, errors.New("log level must be debug, info, warn or error")
	}
	return slog.New(slog.NewTextHandler(out, &slog.HandlerOptions{Level: value})), nil
}

// Allowlisted codes only: errors can contain credential-bearing URLs, SQL,
// upstream response bodies or personal data. Never print their raw text here.
func consoleErrorCode(err error) string {
	var upstream *providerHTTPError
	switch {
	case errors.Is(err, context.DeadlineExceeded):
		return "TIMEOUT"
	case errors.Is(err, context.Canceled):
		return "CANCELLED"
	case errors.Is(err, ErrForbidden):
		return "AUTHORITY_REJECTED"
	case errors.Is(err, ErrConflict):
		return "REVISION_OR_AUTHORITY_CHANGED"
	case errors.Is(err, errActivitySnapshot):
		return "INVALID_ACTIVITY_SNAPSHOT"
	case errors.As(err, &upstream):
		if upstream.StatusCode == 401 || upstream.StatusCode == 403 {
			return "UPSTREAM_AUTH_REJECTED"
		}
		return "UPSTREAM_HTTP_ERROR"
	default:
		return "OPERATION_FAILED"
	}
}

func (a *App) logActivityMonitorInventory(ctx context.Context) {
	rows, err := a.store.reader.QueryContext(ctx, `SELECT q.server_id,s.service_type,q.enabled,
	(s.is_active=1 AND p.enabled=1 AND q.configured_server_revision=s.config_revision AND EXISTS(
	SELECT 1 FROM user_accounts u WHERE u.uuid=q.authorized_by AND u.kind='owner' AND u.is_active=1
	AND (u.access_expires_at IS NULL OR julianday(u.access_expires_at)>julianday('now')))),q.interval_seconds
	FROM activity_monitor_schedules q JOIN media_servers s ON s.id=q.server_id
	JOIN provider_settings p ON p.provider_id=s.service_type ORDER BY q.server_id LIMIT 1000`)
	if err != nil {
		a.logger.Warn("Monitoring inventory unavailable", "code", consoleErrorCode(err))
		return
	}
	defer rows.Close()
	count := 0
	for rows.Next() {
		var id int64
		var provider string
		var enabled, eligible bool
		var interval int
		if err := rows.Scan(&id, &provider, &enabled, &eligible, &interval); err != nil {
			a.logger.Warn("Monitoring inventory unavailable", "code", consoleErrorCode(err))
			return
		}
		state := "disabled"
		if enabled {
			state = "enabled"
			if !eligible {
				state = "paused_requires_review"
			}
		}
		a.logger.Info("Activity monitoring configuration", "server_id", id, "provider", provider, "state", state, "interval_seconds", interval)
		count++
	}
	if err := rows.Err(); err != nil {
		a.logger.Warn("Monitoring inventory unavailable", "code", consoleErrorCode(err))
		return
	}
	if count == 0 {
		a.logger.Info("No activity monitoring sources configured")
	}
	// This is guidance only; it never changes owner consent or enables polling.
	a.logger.Info("Manage monitoring in Streams > Streaming Settings > Activity monitoring")
}
