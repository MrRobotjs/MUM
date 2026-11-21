package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// The public address is the one people outside the server's network use to
// reach MUM (stored as APP_BASE_URL). It is optional: invite links fall back to
// the address the administrator is browsing on, and Discord sign-in needs it
// to build its return address.

// validAppSettings applies the setup rules to the application name and the
// public address.
func validAppSettings(name, public string) (code, message string, ok bool) {
	if strings.TrimSpace(name) == "" || len(name) > 100 {
		return "INVALID_NAME", "Application name is required", false
	}
	if public != "" {
		u, err := url.Parse(public)
		// MUM is served from the root of an address, so only a scheme and host (with any port).
		if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") || u.User != nil || (u.Path != "" && u.Path != "/") || u.RawQuery != "" || u.Fragment != "" || len(public) > 2048 {
			return "INVALID_URL", "Use an http:// or https:// address without a path, such as https://mum.example.com", false
		}
	}
	return "", "", true
}

// publicAddress is the saved public address without a trailing slash, or "".
func (a *App) publicAddress(ctx context.Context) string {
	return strings.TrimRight(a.setting(ctx, "APP_BASE_URL", ""), "/")
}

// saveGeneralSettings edits the application name, the public address and how
// long sign-ins last (sessions.go). Cookie security is decided by HTTPS
// detection and the --secure-cookies option, not here.
func (a *App) saveGeneralSettings(w http.ResponseWriter, r *http.Request) {
	p, ok := a.principal(w, r, true)
	if !ok {
		return
	}
	var input struct {
		Name    *string `json:"app_name"`
		Public  *string `json:"public_address"`
		IdleDay *int    `json:"session_idle_days"`
		MaxDay  *int    `json:"session_max_days"`
	}
	if !decodeStrictBody(w, r, &input) {
		return
	}
	if input.Name == nil || input.Public == nil || input.IdleDay == nil || input.MaxDay == nil {
		fail(w, 400, "INVALID_SETTINGS", "Send app_name, public_address, session_idle_days and session_max_days")
		return
	}
	idleDays, maxDays := *input.IdleDay, *input.MaxDay
	if idleDays < 1 || idleDays > maxSessionIdleDays || maxDays < 1 || maxDays > maxSessionMaxDays || idleDays > maxDays {
		fail(w, 400, "INVALID_SESSION_LENGTH", "Use 1 to 90 days without use and 1 to 365 days in all, with the first no longer than the second")
		return
	}
	name, public := *input.Name, strings.TrimRight(strings.TrimSpace(*input.Public), "/")
	if code, message, valid := validAppSettings(name, public); !valid {
		fail(w, 400, code, message)
		return
	}
	err := a.store.write(r.Context(), func(tx *sql.Tx) error {
		if err := notificationAuthority(r.Context(), tx, p.UUID, bearer(r)); err != nil {
			return err
		}
		for key, value := range map[string]string{"APP_NAME": name, "APP_BASE_URL": public, "SESSION_IDLE_DAYS": strconv.Itoa(idleDays), "SESSION_MAX_DAYS": strconv.Itoa(maxDays)} {
			if err := putSetting(r.Context(), tx, key, value); err != nil {
				return err
			}
		}
		// Apply the new limits to existing sessions inside the same transaction.
		rows, err := tx.QueryContext(r.Context(), "SELECT id,created_at,coalesce(last_used_at,created_at),refresh_expires_at FROM app_sessions")
		if err != nil {
			return err
		}
		type expiryUpdate struct {
			id, expires string
			expired     bool
		}
		var updates []expiryUpdate
		now := time.Now()
		for rows.Next() {
			var id, created, used, old string
			if err := rows.Scan(&id, &created, &used, &old); err != nil {
				rows.Close()
				return err
			}
			createdAt, e1 := time.Parse(time.RFC3339Nano, created)
			usedAt, e2 := time.Parse(time.RFC3339Nano, used)
			oldExpiry, e3 := time.Parse(time.RFC3339Nano, old)
			expires := sessionExpiry(createdAt, usedAt, time.Duration(idleDays)*24*time.Hour, time.Duration(maxDays)*24*time.Hour)
			updates = append(updates, expiryUpdate{id: id, expires: utcTimestamp(expires), expired: e1 != nil || e2 != nil || e3 != nil || !oldExpiry.After(now) || !expires.After(now)})
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			return err
		}
		if err := rows.Close(); err != nil {
			return err
		}
		for _, update := range updates {
			if update.expired {
				if _, err := tx.ExecContext(r.Context(), "DELETE FROM app_sessions WHERE id=?", update.id); err != nil {
					return err
				}
			} else {
				if _, err := tx.ExecContext(r.Context(), "UPDATE app_sessions SET refresh_expires_at=? WHERE id=?", update.expires, update.id); err != nil {
					return err
				}
			}
		}
		// The unused local address is no longer kept.
		if _, err := tx.ExecContext(r.Context(), "DELETE FROM settings WHERE key='APP_LOCAL_URL'"); err != nil {
			return err
		}
		details, _ := json.Marshal(map[string]any{"app_name": name, "public_address": public, "session_idle_days": idleDays, "session_max_days": maxDays})
		_, err = tx.ExecContext(r.Context(), "INSERT INTO audit_events(actor_uuid,action,details,occurred_at) VALUES(?,'settings.general.save',?,?)", p.UUID, string(details), utcTimestamp(time.Now()))
		return err
	})
	if err != nil {
		domainError(w, err)
		return
	}
	respond(w, 200, map[string]any{"app_name": name, "public_address": public, "session_idle_days": idleDays, "session_max_days": maxDays})
}
