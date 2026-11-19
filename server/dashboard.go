package main

import (
	"database/sql"
	"net/http"
	"strconv"
	"strings"
)

// auditEventMessages maps recorded actions to fixed text. Audit details can
// carry reasons, usernames and other private values, so they are never exposed.
var auditEventMessages = map[string]string{
	"server.save": "A media server was saved", "server.delete": "A media server was deleted", "server.sync": "A media server was synchronized",
	"invitation.create": "An invitation was created", "invitation.update": "An invitation was updated", "invitation.reserve": "An invitation was redeemed",
	"settings.discord.save": "Discord settings were updated", "settings.general.save": "General settings were updated", "service.expiry.change": "A service account expiry changed",
	"service.remote_access.disable": "Remote access was disabled", "service.remote_access.enable": "Remote access was re-enabled",
	"service.remote_access.delete": "A remote account was deleted", "account.expiry.reconcile": "A local account expired",
	"service.expiry.reconcile": "A service account expired",
}

func auditEventMessage(action string) string {
	if message, ok := auditEventMessages[action]; ok {
		return message
	}
	switch {
	case strings.HasPrefix(action, "provisioning."):
		return "A provisioning job changed"
	case strings.HasPrefix(action, "overseerr."):
		return "An Overseerr request was reviewed"
	case strings.HasPrefix(action, "activity."):
		return "Activity monitoring recorded an update"
	}
	return "An administrative action was recorded"
}

// recentAuditEvents lists the newest audit events as action, time and a fixed
// message only, for the dashboard's recent-activity card.
func (a *App) recentAuditEvents(w http.ResponseWriter, r *http.Request) {
	p, ok := a.principal(w, r, true)
	if !ok {
		return
	}
	limit := 5
	for key, values := range r.URL.Query() {
		value, err := strconv.Atoi(values[0])
		if key != "limit" || len(values) != 1 || err != nil || value < 1 || value > 50 {
			fail(w, 400, "INVALID_AUDIT_QUERY", "Use only limit=1–50")
			return
		}
		limit = value
	}
	tx, err := a.store.reader.BeginTx(r.Context(), &sql.TxOptions{ReadOnly: true})
	if err != nil {
		domainError(w, err)
		return
	}
	defer tx.Rollback()
	if err = notificationAuthority(r.Context(), tx, p.UUID, bearer(r)); err != nil {
		domainError(w, err)
		return
	}
	rows, err := tx.QueryContext(r.Context(), "SELECT id,occurred_at,action FROM audit_events ORDER BY id DESC LIMIT ?", limit)
	if err != nil {
		domainError(w, err)
		return
	}
	items := []map[string]any{}
	for rows.Next() {
		var id int64
		var occurred, action string
		if err = rows.Scan(&id, &occurred, &action); err != nil {
			break
		}
		items = append(items, map[string]any{"id": id, "timestamp": occurred, "event_type": action, "message": auditEventMessage(action)})
	}
	if err == nil {
		err = rows.Err()
	}
	rows.Close()
	if err == nil {
		err = tx.Commit()
	}
	if err != nil {
		domainError(w, err)
		return
	}
	respond(w, 200, items)
}
