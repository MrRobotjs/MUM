package main

import (
	"database/sql"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// formatWatchDuration renders whole minutes as "2h 05m" or "45m".
func formatWatchDuration(seconds float64) string {
	if seconds < 0 {
		seconds = 0
	}
	minutes := int64(seconds/60 + 0.5)
	if minutes < 60 {
		return fmt.Sprintf("%dm", minutes)
	}
	return fmt.Sprintf("%dh %02dm", minutes/60, minutes%60)
}

type watchTitle struct {
	Title    string `json:"title"`
	Plays    int64  `json:"plays"`
	Duration string `json:"duration"`
}

// activityStatistics aggregates retained activity history for administrators.
// Observation spans approximate watch time: they cover the time MUM saw a
// session, not provider-reported playback. Shows and platforms are empty
// because series names and client devices are not recorded.
func (a *App) activityStatistics(w http.ResponseWriter, r *http.Request) {
	p, ok := a.principal(w, r, true)
	if !ok {
		return
	}
	days := 7
	for key, values := range r.URL.Query() {
		value, err := strconv.Atoi(values[0])
		if key != "days" || len(values) != 1 || err != nil || value < 1 || value > 90 {
			fail(w, 400, "INVALID_STATISTICS_QUERY", "Use only days=1–90")
			return
		}
		days = value
	}
	tx, err := a.store.beginActivityView(r.Context(), p.UUID, bearer(r), true)
	if err != nil {
		domainError(w, err)
		return
	}
	defer tx.Rollback()
	since := utcTimestamp(time.Now().AddDate(0, 0, -days))
	span := `max(0,(julianday(coalesce(h.ended_at,h.last_seen_at))-julianday(h.first_seen_at))*86400)`
	var plays, titles, users int64
	var duration float64
	err = tx.QueryRowContext(r.Context(), `SELECT count(*),coalesce(sum(`+span+`),0),count(DISTINCT h.server_id||':'||h.item_id),count(DISTINCT coalesce(h.owner_uuid,h.service_uuid)) FROM media_activity_history h WHERE h.first_seen_at>=?`, since).Scan(&plays, &duration, &titles, &users)
	var peak int64
	if err == nil {
		err = tx.QueryRowContext(r.Context(), `SELECT coalesce(max(n),0) FROM (SELECT count(*) n FROM media_activity_history h WHERE h.first_seen_at>=? GROUP BY substr(h.first_seen_at,1,10))`, since).Scan(&peak)
	}
	movies := []watchTitle{}
	if err == nil {
		var rows *sql.Rows
		rows, err = tx.QueryContext(r.Context(), `SELECT min(h.title),count(*),sum(`+span+`) FROM media_activity_history h WHERE h.first_seen_at>=? AND lower(h.media_type)='movie' GROUP BY h.server_id,h.item_id ORDER BY count(*) DESC,sum(`+span+`) DESC,min(h.title) LIMIT 5`, since)
		if err == nil {
			for rows.Next() {
				var item watchTitle
				var seconds float64
				if err = rows.Scan(&item.Title, &item.Plays, &seconds); err != nil {
					break
				}
				item.Duration = formatWatchDuration(seconds)
				movies = append(movies, item)
			}
			if err == nil {
				err = rows.Err()
			}
			rows.Close()
		}
	}
	if err == nil {
		err = tx.Commit()
	}
	if err != nil {
		domainError(w, err)
		return
	}
	average := 0.0
	if plays > 0 {
		average = duration / float64(plays)
	}
	respond(w, 200, map[string]any{
		"days": days, "top_movies": movies, "top_shows": []watchTitle{}, "top_platforms": []map[string]any{},
		"totals": map[string]any{"total_plays": plays, "total_duration": formatWatchDuration(duration), "unique_titles": titles, "unique_users": users, "avg_session_length": formatWatchDuration(average), "peak_day_streams": peak},
	})
}

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
