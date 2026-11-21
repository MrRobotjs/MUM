package main

import (
	"context"
	"database/sql"
	"errors"
	"net"
	"net/http"
	"strconv"
	"time"
)

// Sign-in sessions follow the OWASP Session Management Cheat Sheet: a session
// ends after a period without use (the inactivity timeout) and, however
// active, after a fixed time from sign-in (the maximum length); both are
// General settings and apply to existing sessions too. Each renewal replaces
// the refresh key; presenting the replaced key again after a short grace
// period ends the session, because someone else has a copy. People can see
// their signed-in devices and sign them out, and an administrator can sign a
// user out everywhere.

const (
	defaultSessionIdleDays = 7
	defaultSessionMaxDays  = 30
	maxSessionIdleDays     = 90
	maxSessionMaxDays      = 365
	// refreshReuseGrace covers two tabs of one browser renewing at the same
	// moment: the slower one presents the key the faster one just replaced.
	refreshReuseGrace = 60 * time.Second
)

// sessionLimits reads the inactivity timeout and maximum length.
func sessionLimits(ctx context.Context, db queryRower) (idle, max time.Duration) {
	read := func(key string, fallback, ceiling int) int {
		var raw string
		if db.QueryRowContext(ctx, "SELECT value FROM settings WHERE key=?", key).Scan(&raw) != nil {
			return fallback
		}
		n, err := strconv.Atoi(raw)
		if err != nil || n < 1 || n > ceiling {
			return fallback
		}
		return n
	}
	idleDays, maxDays := read("SESSION_IDLE_DAYS", defaultSessionIdleDays, maxSessionIdleDays), read("SESSION_MAX_DAYS", defaultSessionMaxDays, maxSessionMaxDays)
	if idleDays > maxDays {
		idleDays = maxDays
	}
	return time.Duration(idleDays) * 24 * time.Hour, time.Duration(maxDays) * 24 * time.Hour
}

// sessionExpiry is when a session used at lastUsed and created at created
// ends: the earlier of the inactivity timeout and the maximum length.
func sessionExpiry(created, lastUsed time.Time, idle, max time.Duration) time.Time {
	byIdle, byMax := lastUsed.Add(idle), created.Add(max)
	if byIdle.Before(byMax) {
		return byIdle
	}
	return byMax
}

// sessionDevice is the browser and address a request came from, recorded
// when a session is created or renewed.
type sessionDevice struct{ userAgent, ip string }

type sessionDeviceKey struct{}
type backgroundRefreshKey struct{}

func withSessionDevice(r *http.Request) *http.Request {
	agent := r.UserAgent()
	if len(agent) > 512 {
		agent = agent[:512]
	}
	ip := r.RemoteAddr
	if host, _, err := net.SplitHostPort(ip); err == nil {
		ip = host
	}
	if len(ip) > 64 {
		ip = ""
	}
	return r.WithContext(context.WithValue(r.Context(), sessionDeviceKey{}, sessionDevice{userAgent: agent, ip: ip}))
}

func deviceFrom(ctx context.Context) sessionDevice {
	d, _ := ctx.Value(sessionDeviceKey{}).(sessionDevice)
	return d
}

// currentSessionID is the session the request's access token belongs to.
func currentSessionID(ctx context.Context, tx *sql.Tx, access string) (string, error) {
	var id string
	now := utcTimestamp(time.Now())
	err := tx.QueryRowContext(ctx, `SELECT s.id FROM app_sessions s JOIN session_access_tokens t ON t.session_id=s.id WHERE t.token_hash=? AND t.expires_at>? AND s.refresh_expires_at>?`, tokenHash(access), now, now).Scan(&id)
	if err != nil {
		return "", ErrForbidden
	}
	return id, nil
}

type accountSession struct {
	ID         string  `json:"id"`
	Current    bool    `json:"current"`
	SignIn     string  `json:"sign_in"`
	CreatedAt  string  `json:"created_at"`
	LastUsedAt string  `json:"last_used_at"`
	ExpiresAt  string  `json:"expires_at"`
	UserAgent  *string `json:"user_agent"`
	IP         *string `json:"ip_address"`
}

// accountSessions lists the signed-in devices of the person asking.
func (a *App) accountSessions(w http.ResponseWriter, r *http.Request) {
	p, ok := a.principal(w, r, false)
	if !ok {
		return
	}
	tx, err := a.store.reader.BeginTx(r.Context(), &sql.TxOptions{ReadOnly: true})
	if err != nil {
		domainError(w, err)
		return
	}
	defer tx.Rollback()
	if err := accountPreferenceAuthority(r.Context(), tx, p.UUID, bearer(r)); err != nil {
		domainError(w, err)
		return
	}
	current, err := currentSessionID(r.Context(), tx, bearer(r))
	if err != nil {
		domainError(w, err)
		return
	}
	idle, max := sessionLimits(r.Context(), tx)
	now := time.Now()
	rows, err := tx.QueryContext(r.Context(), `SELECT id,sign_in_origin,created_at,coalesce(last_used_at,created_at),refresh_expires_at,coalesce(user_agent,''),coalesce(client_ip,'')
	 FROM app_sessions WHERE user_uuid=? AND refresh_expires_at>? ORDER BY coalesce(last_used_at,created_at) DESC,id`, p.UUID, utcTimestamp(now))
	if err != nil {
		domainError(w, err)
		return
	}
	defer rows.Close()
	out := []accountSession{}
	for rows.Next() {
		var s accountSession
		var agent, ip, stored string
		if err := rows.Scan(&s.ID, &s.SignIn, &s.CreatedAt, &s.LastUsedAt, &stored, &agent, &ip); err != nil {
			domainError(w, err)
			return
		}
		created, err1 := time.Parse(time.RFC3339Nano, s.CreatedAt)
		used, err2 := time.Parse(time.RFC3339Nano, s.LastUsedAt)
		if err1 != nil || err2 != nil {
			continue
		}
		expires := sessionExpiry(created, used, idle, max)
		if !expires.After(now) {
			continue // Ended by the current limits; removed at its next renewal.
		}
		s.ExpiresAt = utcTimestamp(expires)
		s.Current = s.ID == current
		if agent != "" {
			s.UserAgent = &agent
		}
		if ip != "" {
			s.IP = &ip
		}
		out = append(out, s)
	}
	if err := rows.Err(); err != nil {
		domainError(w, err)
		return
	}
	respond(w, 200, map[string]any{"sessions": out})
}

// endAccountSessions signs out one of the asker's devices (DELETE with an id),
// or every device but the one asking (POST .../sign-out-others).
func (a *App) endAccountSessions(w http.ResponseWriter, r *http.Request) {
	p, ok := a.principal(w, r, false)
	if !ok {
		return
	}
	target := r.PathValue("session")
	if r.Method == http.MethodDelete && (len(target) < 1 || len(target) > 64) {
		fail(w, 404, "NOT_FOUND", "Session not found")
		return
	}
	var ended int64
	endedCurrent := false
	err := a.store.write(r.Context(), func(tx *sql.Tx) error {
		if err := accountPreferenceAuthority(r.Context(), tx, p.UUID, bearer(r)); err != nil {
			return err
		}
		current, err := currentSessionID(r.Context(), tx, bearer(r))
		if err != nil {
			return err
		}
		var result sql.Result
		if r.Method == http.MethodDelete {
			result, err = tx.ExecContext(r.Context(), "DELETE FROM app_sessions WHERE id=? AND user_uuid=?", target, p.UUID)
			endedCurrent = target == current
		} else if r.URL.Path == "/api/account/sessions/sign-out-all" {
			result, err = tx.ExecContext(r.Context(), "DELETE FROM app_sessions WHERE user_uuid=?", p.UUID)
			endedCurrent = true
		} else {
			result, err = tx.ExecContext(r.Context(), "DELETE FROM app_sessions WHERE user_uuid=? AND id<>?", p.UUID, current)
		}
		if err != nil {
			return err
		}
		if ended, err = result.RowsAffected(); err != nil {
			return err
		}
		if r.Method == http.MethodDelete && ended == 0 {
			return ErrNotFound
		}
		action := "session.sign_out_others"
		if r.Method == http.MethodDelete {
			action = "session.sign_out"
		} else if endedCurrent {
			action = "session.sign_out_all"
		}
		return auditAction(r.Context(), tx, p.UUID, action)
	})
	if err != nil {
		domainError(w, err)
		return
	}
	if ended > 0 {
		a.hub.closeAccountConnections(p.UUID)
	}
	if endedCurrent {
		http.SetCookie(w, &http.Cookie{Name: "mum_refresh", Path: "/api/auth", Value: "", MaxAge: -1, HttpOnly: true, Secure: a.secureCookie(r), SameSite: http.SameSiteStrictMode})
	}
	respond(w, 200, map[string]any{"ended": ended, "signed_out_here": endedCurrent})
}

// endUserSessions lets an administrator sign a user out everywhere, under the
// same rules as deactivating them: never the owner or themselves, another
// administrator only by the owner, and only below the actor's rank.
func (a *App) endUserSessions(w http.ResponseWriter, r *http.Request) {
	actor, ok := a.principal(w, r, true)
	if !ok {
		return
	}
	target := r.PathValue("user")
	var ended int64
	err := a.store.write(r.Context(), func(tx *sql.Tx) error {
		record, err := readHumanActivation(r.Context(), tx, actor.UUID, bearer(r), target)
		if err != nil {
			return err
		}
		switch record.Reason {
		case "protected_owner", "protected_self", "administrator_unavailable":
			return ErrForbidden
		}
		result, err := tx.ExecContext(r.Context(), "DELETE FROM app_sessions WHERE user_uuid=?", target)
		if err != nil {
			return err
		}
		if ended, err = result.RowsAffected(); err != nil {
			return err
		}
		return auditAction(r.Context(), tx, actor.UUID, "session.sign_out_user")
	})
	if errors.Is(err, ErrForbidden) {
		fail(w, 403, "FORBIDDEN", "You can't sign this account out")
		return
	}
	if err != nil {
		domainError(w, err)
		return
	}
	a.hub.closeAccountConnections(target)
	respond(w, 200, map[string]any{"user_uuid": target, "ended": ended})
}

// sessionsSecureStatus reports whether this request reached MUM over HTTPS,
// as MUM sees it, and whether cookies are always marked secure.
func (a *App) sessionsSecureStatus(r *http.Request) map[string]any {
	return map[string]any{"https_detected": requestHTTPS(r), "secure_cookies_forced": a.SecureCookies}
}
