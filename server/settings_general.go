package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"net/http"
	"net/url"
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

// saveGeneralSettings edits the application name and public address after setup.
// Session lifetimes and cookie security are fixed by this build and are not
// accepted here.
func (a *App) saveGeneralSettings(w http.ResponseWriter, r *http.Request) {
	p, ok := a.principal(w, r, true)
	if !ok {
		return
	}
	var input struct {
		Name   *string `json:"app_name"`
		Public *string `json:"public_address"`
	}
	if !decodeStrictBody(w, r, &input) {
		return
	}
	if input.Name == nil || input.Public == nil {
		fail(w, 400, "INVALID_SETTINGS", "Send app_name and public_address")
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
		for key, value := range map[string]string{"APP_NAME": name, "APP_BASE_URL": public} {
			if err := putSetting(r.Context(), tx, key, value); err != nil {
				return err
			}
		}
		// The unused local address is no longer kept.
		if _, err := tx.ExecContext(r.Context(), "DELETE FROM settings WHERE key='APP_LOCAL_URL'"); err != nil {
			return err
		}
		details, _ := json.Marshal(map[string]any{"app_name": name, "public_address": public})
		_, err := tx.ExecContext(r.Context(), "INSERT INTO audit_events(actor_uuid,action,details,occurred_at) VALUES(?,'settings.general.save',?,?)", p.UUID, string(details), utcTimestamp(time.Now()))
		return err
	})
	if err != nil {
		domainError(w, err)
		return
	}
	respond(w, 200, map[string]any{"app_name": name, "public_address": public})
}
