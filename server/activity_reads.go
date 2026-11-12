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

// Own history requires both frozen attribution and a current primary-owner
// link. Delegation or acquiring a service later grants no past viewing data.
const activityOwnHistory = `h.owner_uuid=? AND EXISTS(SELECT 1 FROM service_links l WHERE l.service_uuid=h.service_uuid AND l.user_uuid=? AND l.link_kind='owner')`

type activityReadQuery struct {
	All, History   bool
	Server, Before int64
	Target         string
}
type activityReadItem struct {
	Display *activityDisplay `json:"display,omitempty"`
	ID      string           `json:"id"`
	Server  string           `json:"server_id"`
	Service string           `json:"service_uuid"`
	Owner   *string          `json:"owner_uuid,omitempty"`
	// Display names are included only in the administrator all scope.
	OwnerName   *string `json:"owner_name,omitempty"`
	ServiceName *string `json:"service_username,omitempty"`
	Item        string  `json:"item_id"`
	Kind        string  `json:"media_type"`
	Title       string  `json:"title"`
	First       string  `json:"first_observed_at"`
	Last        string  `json:"last_observed_at"`
	Ended       *string `json:"ended_observation_at"`
	Reason      *string `json:"end_reason"`
	Paused      bool    `json:"paused"`
	Position    *string `json:"position_ticks"`
	Duration    *string `json:"duration_ticks"`
	// History presentation kept with the play. The poster is only a signed
	// link, added in the administrator scope where the image proxy applies.
	ParentTitle *string `json:"parent_title,omitempty"`
	LibraryName *string `json:"library_name,omitempty"`
	Client      *string `json:"client,omitempty"`
	PlayMethod  *string `json:"play_method,omitempty"`
	PosterURL   string  `json:"poster_url,omitempty"`
	hasPoster   bool
}
type activityReadStatus struct {
	Source     string  `json:"observation_source"`
	Server     string  `json:"server_id"`
	Provider   string  `json:"provider"`
	Observed   *string `json:"observed_at"`
	Age        *int64  `json:"age_seconds"`
	Freshness  string  `json:"freshness"`
	Pending    string  `json:"pending"`
	LastResult string  `json:"last_result"`
}
type activityReadResponse struct {
	Actor   string               `json:"actor_uuid"`
	Scope   string               `json:"scope"`
	At      string               `json:"read_at"`
	Items   []activityReadItem   `json:"items"`
	Servers []activityReadStatus `json:"servers"`
	Next    *string              `json:"next_before"`
	Target  string               `json:"target_uuid,omitempty"`
}
type activityReadFence struct {
	Revision, Mapping, ConfigRevision int64
	Active                            bool
	Eligible                          int64
}

func parseActivityReadQuery(r *http.Request) (activityReadQuery, error) {
	q := activityReadQuery{History: strings.HasSuffix(r.URL.Path, "/history"), Before: 9223372036854775807, Target: r.PathValue("identity")}
	if q.Target != "" && !validAdminMemberCursor(q.Target) {
		return q, ErrConflict
	}
	valuesByKey, err := url.ParseQuery(r.URL.RawQuery)
	if err != nil {
		return q, ErrConflict
	}
	for key, values := range valuesByKey {
		if len(values) != 1 {
			return q, ErrConflict
		}
		value := values[0]
		switch key {
		case "scope":
			if value != "own" && value != "all" {
				return q, ErrConflict
			}
			q.All = value == "all"
		case "server", "before":
			id, err := strconv.ParseInt(value, 10, 64)
			if err != nil || id < 1 || strconv.FormatInt(id, 10) != value {
				return q, ErrConflict
			}
			if key == "server" {
				q.Server = id
			} else {
				q.Before = id
			}
		default:
			return q, ErrConflict
		}
	}
	return q, nil
}
func (s *Store) beginActivityView(ctx context.Context, actor, access string, all bool) (*sql.Tx, error) {
	tx, err := s.reader.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return nil, err
	}
	err = accountPreferenceAuthority(ctx, tx, actor, access)
	if err == nil && all {
		err = requirePermission(ctx, tx, actor, "administrator")
	}
	if err != nil {
		tx.Rollback()
		return nil, err
	}
	return tx, nil
}
func readActivityStatuses(ctx context.Context, tx *sql.Tx, actor string, q activityReadQuery, now time.Time) ([]activityReadStatus, map[int64]activityReadFence, error) {
	if err := checkActivityTarget(ctx, tx, actor, q); err != nil {
		return nil, nil, err
	}
	args := []any{actor, q.Server, q.Server}
	query := `SELECT a.server_id,s.service_type,a.revision,a.mapping_revision,s.config_revision,(s.is_active=1 AND p.enabled=1),a.observed_at,a.observed_config_revision,a.observed_mapping_revision,a.last_result,a.pending_until,a.observed_source,(SELECT count(*) FROM service_accounts z JOIN service_links l ON l.service_uuid=z.uuid WHERE z.server_id=a.server_id AND l.user_uuid=? AND l.link_kind='owner' AND z.is_active=1 AND (z.access_expires_at IS NULL OR julianday(z.access_expires_at)>julianday('now'))) FROM media_activity_state a JOIN media_servers s ON s.id=a.server_id JOIN provider_settings p ON p.provider_id=s.service_type WHERE (?=0 OR a.server_id=?)`
	if !q.All {
		query += ` AND EXISTS(SELECT 1 FROM service_accounts u JOIN service_links l ON l.service_uuid=u.uuid WHERE u.server_id=a.server_id AND l.user_uuid=? AND l.link_kind='owner')`
		args = append(args, actor)
	}
	if q.Target != "" {
		query += ` AND (EXISTS(SELECT 1 FROM media_activity_history h WHERE h.server_id=a.server_id AND (h.service_uuid=? OR h.owner_uuid=?)) OR EXISTS(SELECT 1 FROM service_accounts u LEFT JOIN service_links l ON l.service_uuid=u.uuid AND l.link_kind='owner' WHERE u.server_id=a.server_id AND (u.uuid=? OR l.user_uuid=?)))`
		args = append(args, q.Target, q.Target, q.Target, q.Target)
	}
	rows, err := tx.QueryContext(ctx, query+` ORDER BY a.server_id LIMIT 1001`, args...)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	items := []activityReadStatus{}
	fences := map[int64]activityReadFence{}
	for rows.Next() {
		var item activityReadStatus
		var fence activityReadFence
		var id int64
		var observed, pending sql.NullString
		var configRevision, mappingRevision sql.NullInt64
		if err := rows.Scan(&id, &item.Provider, &fence.Revision, &fence.Mapping, &fence.ConfigRevision, &fence.Active, &observed, &configRevision, &mappingRevision, &item.LastResult, &pending, &item.Source, &fence.Eligible); err != nil {
			return nil, nil, err
		}
		item.Server = strconv.FormatInt(id, 10)
		item.Pending = "none"
		item.Freshness = "never"
		if pending.Valid {
			until, err := time.Parse(time.RFC3339Nano, pending.String)
			if err != nil {
				return nil, nil, ErrConflict
			}
			item.Pending = "running"
			if !until.After(now) {
				item.Pending = "expired"
			}
		}
		if observed.Valid {
			at, err := time.Parse(time.RFC3339Nano, observed.String)
			if err != nil || at.After(now.Add(time.Second)) {
				return nil, nil, ErrConflict
			}
			age := int64(now.Sub(at) / time.Second)
			if age < 0 {
				age = 0
			}
			item.Observed = &observed.String
			item.Age = &age
			item.Freshness = "fresh"
			if age >= 60 {
				item.Freshness = "stale"
			}
			if !configRevision.Valid || !mappingRevision.Valid || configRevision.Int64 != fence.ConfigRevision || mappingRevision.Int64 != fence.Mapping {
				item.Freshness = "invalidated"
			}
		}
		if item.LastResult == "failed" {
			item.Freshness = "failed"
		}
		if item.Pending == "expired" && item.Freshness == "fresh" {
			item.Freshness = "stale"
		}
		if !fence.Active {
			item.Freshness = "disabled"
		}
		items = append(items, item)
		fences[id] = fence
	}
	if err := rows.Err(); err != nil {
		return nil, nil, err
	}
	if len(items) > 1000 {
		return nil, nil, ErrConflict
	}
	return items, fences, nil
}
func readActivityItems(ctx context.Context, tx *sql.Tx, actor string, q activityReadQuery) ([]activityReadItem, *string, error) {
	displayColumn := `'{}'`
	if q.All && !q.History {
		displayColumn = `c.display_json`
	}
	presentation := `,NULL,NULL,NULL,NULL,0`
	if q.History {
		presentation = `,h.parent_title,h.library_name,h.client,h.play_method,h.poster_path IS NOT NULL`
	}
	query := `SELECT h.id,h.server_id,h.service_uuid,h.owner_uuid,h.item_id,h.media_type,h.title,h.first_seen_at,h.last_seen_at,h.ended_at,h.end_reason,h.paused,h.position_ticks,h.duration_ticks,(SELECT coalesce(local_username,deleted_username) FROM user_accounts WHERE uuid=h.owner_uuid),(SELECT external_username FROM service_accounts WHERE uuid=h.service_uuid),` + displayColumn + presentation + ` FROM media_activity_history h`
	if !q.History {
		query += ` JOIN media_activity_current c ON c.history_id=h.id`
	}
	query += ` WHERE h.id<? AND (?=0 OR h.server_id=?)`
	args := []any{q.Before, q.Server, q.Server}
	predicate, targetArgs := activityTargetPredicate(q)
	query += predicate
	args = append(args, targetArgs...)
	if !q.All {
		query += ` AND ` + activityOwnHistory
		args = append(args, actor, actor)
		if !q.History {
			query += ` AND EXISTS(SELECT 1 FROM service_accounts u JOIN media_servers s ON s.id=u.server_id JOIN provider_settings p ON p.provider_id=s.service_type JOIN media_activity_state a ON a.server_id=s.id WHERE u.uuid=h.service_uuid AND u.is_active=1 AND (u.access_expires_at IS NULL OR julianday(u.access_expires_at)>julianday('now')) AND s.is_active=1 AND p.enabled=1 AND a.observed_mapping_revision=a.mapping_revision AND a.observed_config_revision=s.config_revision)`
		}
	}
	rows, err := tx.QueryContext(ctx, query+` ORDER BY h.id DESC LIMIT 101`, args...)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	items := []activityReadItem{}
	for rows.Next() {
		var item activityReadItem
		var id, server int64
		var position, duration sql.NullInt64
		var ownerName, serviceName sql.NullString
		var display string
		if err := rows.Scan(&id, &server, &item.Service, &item.Owner, &item.Item, &item.Kind, &item.Title, &item.First, &item.Last, &item.Ended, &item.Reason, &item.Paused, &position, &duration, &ownerName, &serviceName, &display, &item.ParentTitle, &item.LibraryName, &item.Client, &item.PlayMethod, &item.hasPoster); err != nil {
			return nil, nil, err
		}
		if q.All && !q.History && display != "{}" {
			if err := json.Unmarshal([]byte(display), &item.Display); err != nil {
				return nil, nil, ErrConflict
			}
		}
		item.ID = strconv.FormatInt(id, 10)
		item.Server = strconv.FormatInt(server, 10)
		if !q.All {
			item.Owner = nil
		} else {
			if ownerName.Valid && ownerName.String != "" {
				item.OwnerName = &ownerName.String
			}
			if serviceName.Valid && serviceName.String != "" {
				item.ServiceName = &serviceName.String
			}
		}
		if position.Valid {
			v := strconv.FormatInt(position.Int64, 10)
			item.Position = &v
		}
		if duration.Valid {
			v := strconv.FormatInt(duration.Int64, 10)
			item.Duration = &v
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return nil, nil, err
	}
	var next *string
	if len(items) > 100 {
		items = items[:100]
		v := items[99].ID
		next = &v
	}
	return items, next, nil
}

// A second query-only snapshot fences authority and source/ownership changes
// after DTO construction, immediately before HTTP delivery. No writer or I/O
// is held while encoding the response. Every page repeats live authorization.
func (s *Store) checkActivityDelivery(ctx context.Context, actor, access string, q activityReadQuery, expected map[int64]activityReadFence) error {
	tx, err := s.beginActivityView(ctx, actor, access, q.All)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	_, actual, err := readActivityStatuses(ctx, tx, actor, q, time.Now().UTC())
	if err != nil {
		return err
	}
	if len(actual) != len(expected) {
		return ErrConflict
	}
	for id, fence := range expected {
		if current, ok := actual[id]; !ok || current != fence {
			return ErrConflict
		}
	}
	return tx.Commit()
}
func (a *App) activityRead(w http.ResponseWriter, r *http.Request) {
	actor, ok := a.principal(w, r, false)
	if !ok {
		return
	}
	q, err := parseActivityReadQuery(r)
	if err != nil {
		fail(w, 400, "INVALID_ACTIVITY_QUERY", "Use scope own/all and canonical positive server/before IDs")
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
	result := activityReadResponse{Actor: actor.UUID, Scope: "own", At: utcTimestamp(now), Target: q.Target}
	if q.All {
		result.Scope = "all"
	}
	var fences map[int64]activityReadFence
	result.Servers, fences, err = readActivityStatuses(ctx, tx, actor.UUID, q, now)
	if err == nil {
		result.Items, result.Next, err = readActivityItems(ctx, tx, actor.UUID, q)
	}
	if err == nil {
		for i := range result.Items {
			if d := result.Items[i].Display; d != nil {
				if d.PosterPath != "" || d.AvatarPath != "" {
					session, sessionErr := readCatalogueAuthority(ctx, tx, actor.UUID, bearer(r))
					if sessionErr != nil {
						domainError(w, sessionErr)
						return
					}
					id, _ := strconv.ParseInt(result.Items[i].ID, 10, 64)
					if d.PosterPath != "" {
						d.Thumb = a.signedImageURL("activity-poster", "/api/activity/images", session, id, now)
					}
					if d.AvatarPath != "" {
						d.Avatar = a.signedImageURL("activity-avatar", "/api/activity/avatars", session, id, now)
					}
				}
				d.PosterItem, d.PosterPath, d.AvatarPath = "", "", ""
			}
		}
	}
	// Retained history posters: signed, administrator-only links to the
	// stored reference, rechecked by the history image proxy on every fetch.
	if err == nil && q.History && q.All {
		var session string
		for i := range result.Items {
			if !result.Items[i].hasPoster {
				continue
			}
			if session == "" {
				if session, err = readCatalogueAuthority(ctx, tx, actor.UUID, bearer(r)); err != nil {
					domainError(w, err)
					return
				}
			}
			id, _ := strconv.ParseInt(result.Items[i].ID, 10, 64)
			result.Items[i].PosterURL = a.signedImageURL(activityHistoryPosterPurpose, "/api/activity/history-images", session, id, now)
		}
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
	respond(w, 200, result)
}
