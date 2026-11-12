package main

import (
	"context"
	"database/sql"
	"net/http"
	"strconv"
	"time"
)

// Counts describe recorded observations, never actual concurrent playback or
// watched duration. Decimal strings preserve exact counts in browser clients.
type activityObservationCounts struct {
	Recorded string `json:"recorded_observations"`
	Ended    string `json:"ended_observations"`
	Current  string `json:"retained_current_observations"`
	Fresh    string `json:"fresh_current_observations"`
}
type activityServerSummary struct {
	activityReadStatus
	activityObservationCounts
}
type activitySummaryResponse struct {
	Actor string `json:"actor_uuid"`
	Scope string `json:"scope"`
	At    string `json:"read_at"`
	activityObservationCounts
	Servers []activityServerSummary `json:"servers"`
	Target  string                  `json:"target_uuid,omitempty"`
}
type activityCountValues struct{ Recorded, Ended, Current, Fresh int64 }

func formatActivityCounts(v activityCountValues) activityObservationCounts {
	return activityObservationCounts{strconv.FormatInt(v.Recorded, 10), strconv.FormatInt(v.Ended, 10), strconv.FormatInt(v.Current, 10), strconv.FormatInt(v.Fresh, 10)}
}

func readActivitySummaryCounts(ctx context.Context, tx *sql.Tx, actor string, q activityReadQuery, statuses []activityReadStatus) (activityCountValues, []activityServerSummary, error) {
	query := `SELECT h.server_id,count(*),coalesce(sum(h.ended_at IS NOT NULL),0),coalesce(sum(CASE WHEN c.history_id IS NOT NULL`
	if !q.All {
		query += ` AND EXISTS(SELECT 1 FROM service_accounts u JOIN media_servers s ON s.id=u.server_id JOIN provider_settings p ON p.provider_id=s.service_type JOIN media_activity_state a ON a.server_id=s.id WHERE u.uuid=h.service_uuid AND u.is_active=1 AND (u.access_expires_at IS NULL OR julianday(u.access_expires_at)>julianday('now')) AND s.is_active=1 AND p.enabled=1 AND a.observed_mapping_revision=a.mapping_revision AND a.observed_config_revision=s.config_revision)`
	}
	query += ` THEN 1 ELSE 0 END),0) FROM media_activity_history h LEFT JOIN media_activity_current c ON c.history_id=h.id WHERE (?=0 OR h.server_id=?)`
	args := []any{q.Server, q.Server}
	predicate, targetArgs := activityTargetPredicate(q)
	query += predicate
	args = append(args, targetArgs...)
	if !q.All {
		query += ` AND ` + activityOwnHistory
		args = append(args, actor, actor)
	}
	rows, err := tx.QueryContext(ctx, query+` GROUP BY h.server_id LIMIT 1001`, args...)
	if err != nil {
		return activityCountValues{}, nil, err
	}
	defer rows.Close()
	values := map[string]activityCountValues{}
	for rows.Next() {
		var server int64
		var value activityCountValues
		if err := rows.Scan(&server, &value.Recorded, &value.Ended, &value.Current); err != nil {
			return activityCountValues{}, nil, err
		}
		if value.Recorded < 0 || value.Ended < 0 || value.Current < 0 || value.Ended > value.Recorded || value.Current > value.Recorded-value.Ended {
			return activityCountValues{}, nil, ErrConflict
		}
		values[strconv.FormatInt(server, 10)] = value
	}
	if err := rows.Err(); err != nil {
		return activityCountValues{}, nil, err
	}
	total := activityCountValues{}
	servers := []activityServerSummary{}
	for _, status := range statuses {
		value := values[status.Server]
		delete(values, status.Server)
		if status.Freshness == "fresh" {
			value.Fresh = value.Current
		}
		const max = int64(9223372036854775807)
		if total.Recorded > max-value.Recorded || total.Ended > max-value.Ended || total.Current > max-value.Current || total.Fresh > max-value.Fresh {
			return activityCountValues{}, nil, ErrConflict
		}
		total.Recorded += value.Recorded
		total.Ended += value.Ended
		total.Current += value.Current
		total.Fresh += value.Fresh
		servers = append(servers, activityServerSummary{status, formatActivityCounts(value)})
	}
	if len(values) != 0 {
		return activityCountValues{}, nil, ErrConflict
	}
	return total, servers, nil
}
func (a *App) activitySummary(w http.ResponseWriter, r *http.Request) {
	actor, ok := a.principal(w, r, false)
	if !ok {
		return
	}
	q, err := parseActivityReadQuery(r)
	if err != nil || r.URL.Query().Has("before") {
		fail(w, 400, "INVALID_ACTIVITY_SUMMARY_QUERY", "Use only own/all scope and an optional canonical server ID")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	tx, err := a.store.beginActivityView(ctx, actor.UUID, bearer(r), q.All)
	if err != nil {
		domainError(w, err)
		return
	}
	defer tx.Rollback()
	now := time.Now().UTC()
	statuses, fences, err := readActivityStatuses(ctx, tx, actor.UUID, q, now)
	var total activityCountValues
	var servers []activityServerSummary
	if err == nil {
		total, servers, err = readActivitySummaryCounts(ctx, tx, actor.UUID, q, statuses)
	}
	if err == nil {
		err = tx.Commit()
	}
	if err == nil {
		err = a.store.checkActivityDelivery(ctx, actor.UUID, bearer(r), q, fences)
	}
	if err != nil {
		domainError(w, err)
		return
	}
	scope := "own"
	if q.All {
		scope = "all"
	}
	respond(w, 200, activitySummaryResponse{actor.UUID, scope, utcTimestamp(now), formatActivityCounts(total), servers, q.Target})
}
