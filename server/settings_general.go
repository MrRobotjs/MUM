package main

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// validAppSettings applies the setup rules to the application name and URLs.
func validAppSettings(name, base, local string) (code, message string, ok bool) {
	if strings.TrimSpace(name) == "" || len(name) > 100 {
		return "INVALID_NAME", "Application name is required", false
	}
	for _, raw := range []string{base, local} {
		if raw != "" {
			u, err := url.Parse(raw)
			if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") {
				return "INVALID_URL", "Use an HTTP or HTTPS URL", false
			}
		}
	}
	return "", "", true
}

// saveGeneralSettings edits the application name and URLs after setup.
// Session lifetimes and cookie security are fixed by this build and are not
// accepted here.
func (a *App) saveGeneralSettings(w http.ResponseWriter, r *http.Request) {
	p, ok := a.principal(w, r, true)
	if !ok {
		return
	}
	var input struct {
		Name  *string `json:"app_name"`
		Base  *string `json:"app_base_url"`
		Local *string `json:"app_local_url"`
	}
	if !decodeStrictBody(w, r, &input) {
		return
	}
	if input.Name == nil || input.Base == nil || input.Local == nil {
		fail(w, 400, "INVALID_SETTINGS", "Send app_name, app_base_url and app_local_url")
		return
	}
	name, base, local := *input.Name, strings.TrimSpace(*input.Base), strings.TrimSpace(*input.Local)
	if code, message, valid := validAppSettings(name, base, local); !valid {
		fail(w, 400, code, message)
		return
	}
	err := a.store.write(r.Context(), func(tx *sql.Tx) error {
		if err := notificationAuthority(r.Context(), tx, p.UUID, bearer(r)); err != nil {
			return err
		}
		for key, value := range map[string]string{"APP_NAME": name, "APP_BASE_URL": base, "APP_LOCAL_URL": local} {
			if err := putSetting(r.Context(), tx, key, value); err != nil {
				return err
			}
		}
		details, _ := json.Marshal(map[string]any{"app_name": name, "app_base_url": base, "app_local_url": local})
		_, err := tx.ExecContext(r.Context(), "INSERT INTO audit_events(actor_uuid,action,details,occurred_at) VALUES(?,'settings.general.save',?,?)", p.UUID, string(details), utcTimestamp(time.Now()))
		return err
	})
	if err != nil {
		domainError(w, err)
		return
	}
	respond(w, 200, map[string]any{"app_name": name, "app_base_url": base, "app_local_url": local})
}
