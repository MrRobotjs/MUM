package main

import (
	"app/server/providers/plex"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"time"
)

type activityReadClaim struct {
	Server, ConfigRevision, Generation, MappingRevision int64
	Provider, Actor, Access, Token                      string
	Source                                              string
	Started                                             time.Time
	MonitorRevision                                     int64
}
type resolvedActivity struct {
	Session activitySession
	Service string
	Owner   *string
}
type activeActivity struct {
	History    int64
	Service    string
	Owner      *string
	Item, Kind string
}
type activityApplyResult struct {
	Started, Updated, Ended int
	Revision                int64
}

func (s *Store) beginActivityRead(ctx context.Context, actor, access string, server int64) (activityReadClaim, error) {
	claim := activityReadClaim{Actor: actor, Access: access, Server: server, Token: newUUID(), Started: time.Now().UTC()}
	err := s.write(ctx, func(tx *sql.Tx) error {
		if err := notificationAuthority(ctx, tx, actor, access); err != nil {
			return err
		}
		var active bool
		if err := tx.QueryRowContext(ctx, `SELECT s.service_type,s.config_revision,(s.is_active=1 AND p.enabled=1) FROM media_servers s JOIN provider_settings p ON p.provider_id=s.service_type WHERE s.id=?`, server).Scan(&claim.Provider, &claim.ConfigRevision, &active); err != nil {
			return err
		}
		if !active || !activitySupported(claim.Provider) {
			return ErrConflict
		}
		if err := tx.QueryRowContext(ctx, `SELECT generation+1,mapping_revision FROM media_activity_state WHERE server_id=?`, server).Scan(&claim.Generation, &claim.MappingRevision); err != nil {
			return err
		}
		_, err := tx.ExecContext(ctx, `UPDATE media_activity_state SET generation=?,pending_token=?,pending_at=?,pending_until=?,revision=revision+1 WHERE server_id=?`, claim.Generation, claim.Token, utcTimestamp(claim.Started), utcTimestamp(claim.Started.Add(20*time.Second)), server)
		return err
	})
	return claim, err
}
func checkActivityClaim(ctx context.Context, tx *sql.Tx, c activityReadClaim) error {
	var authorityErr error
	if c.MonitorRevision != 0 {
		authorityErr = checkActivityMonitorClaim(ctx, tx, c)
	} else {
		authorityErr = notificationAuthority(ctx, tx, c.Actor, c.Access)
	}
	if authorityErr != nil {
		return authorityErr
	}
	var valid bool
	err := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM media_activity_state a JOIN media_servers s ON s.id=a.server_id JOIN provider_settings p ON p.provider_id=s.service_type WHERE a.server_id=? AND a.generation=? AND a.mapping_revision=? AND a.pending_token=? AND julianday(a.pending_until)>julianday('now') AND s.config_revision=? AND s.service_type=? AND s.is_active=1 AND p.enabled=1)`, c.Server, c.Generation, c.MappingRevision, c.Token, c.ConfigRevision, c.Provider).Scan(&valid)
	if err != nil {
		return err
	}
	if !valid {
		return ErrConflict
	}
	return nil
}
func sameActivityOwner(a, b *string) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return *a == *b
}
func endActivity(ctx context.Context, tx *sql.Tx, server int64, id string, current activeActivity, observed, reason string) error {
	if _, err := tx.ExecContext(ctx, `UPDATE media_activity_history SET ended_at=?,end_reason=? WHERE id=? AND ended_at IS NULL`, observed, reason, current.History); err != nil {
		return err
	}
	_, err := tx.ExecContext(ctx, `DELETE FROM media_activity_current WHERE server_id=? AND external_session_id=?`, server, id)
	return err
}
func commitActivitySnapshot(ctx context.Context, tx *sql.Tx, c activityReadClaim, snapshot activitySnapshot) (activityApplyResult, error) {
	if busy, err := editSourceBusy(ctx, tx, c.Server, ""); err != nil {
		return activityApplyResult{}, err
	} else if busy {
		return activityApplyResult{}, ErrConflict
	}

	result := activityApplyResult{}
	if err := checkActivityClaim(ctx, tx, c); err != nil {
		return result, err
	}
	if snapshot.Provider != c.Provider || snapshot.Sessions == nil || len(snapshot.Sessions) > 1000 || snapshot.ObservedAt.IsZero() || snapshot.ObservedAt.Before(c.Started) || snapshot.ObservedAt.After(time.Now().Add(time.Second)) {
		return result, errActivitySnapshot
	}
	var previous *string
	if err := tx.QueryRowContext(ctx, "SELECT observed_at FROM media_activity_state WHERE server_id=?", c.Server).Scan(&previous); err != nil {
		return result, err
	}
	if previous != nil {
		last, err := time.Parse(time.RFC3339Nano, *previous)
		if err != nil || snapshot.ObservedAt.Before(last) {
			return result, ErrConflict
		}
	}
	seen := map[string]bool{}
	resolved := []resolvedActivity{}
	// Resolve the whole snapshot before closing or opening any history.
	for _, session := range snapshot.Sessions {
		if !validActivitySession(session) || seen[session.Session] {
			return result, errActivitySnapshot
		}
		seen[session.Session] = true
		if c.Provider == "plex" {
			var exists bool
			if err := tx.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM service_accounts WHERE server_id=? AND external_user_id=?)", c.Server, session.User).Scan(&exists); err != nil {
				return result, err
			}
			if !exists {
				var removed bool
				if err := tx.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM edit_removed_identities WHERE server_id=? AND external_user_id=?)", c.Server, session.User).Scan(&removed); err != nil {
					return result, err
				}
				if removed {
					continue
				}
				id := newUUID()
				now := utcTimestamp(time.Now())
				if _, err := tx.ExecContext(ctx, "INSERT INTO identities(uuid,kind) VALUES(?,'service')", id); err != nil {
					return result, err
				}
				if _, err := tx.ExecContext(ctx, `INSERT INTO service_accounts(uuid,server_id,external_user_id,external_username,service_settings,created_at,updated_at) VALUES(?,?,?,?,?, ?,?)`, id, c.Server, session.User, session.UserName, `{"activity_observed":true}`, now, now); err != nil {
					return result, err
				}
				if err := auditAction(ctx, tx, c.Actor, "activity.identity.observe"); err != nil {
					return result, err
				}
				if err := tx.QueryRowContext(ctx, "SELECT mapping_revision FROM media_activity_state WHERE server_id=?", c.Server).Scan(&c.MappingRevision); err != nil {
					return result, err
				}
			}
			// A playback session can supply a missing profile picture (the server
			// owner never appears in the cloud user list). It only fills an empty
			// avatar, so a cloud profile from user sync is never overwritten, and it
			// commits or rolls back with the rest of this validated snapshot.
			if session.Display != nil && session.Display.AvatarPath != "" && plex.UserAvatar(session.Display.AvatarPath) == session.Display.AvatarPath {
				if _, err := tx.ExecContext(ctx, `UPDATE service_accounts SET external_avatar_url=? WHERE server_id=? AND external_user_id=? AND coalesce(external_avatar_url,'')=''`, session.Display.AvatarPath, c.Server, session.User); err != nil {
					return result, err
				}
			}
		}
		row := resolvedActivity{Session: session}
		err := tx.QueryRowContext(ctx, `SELECT s.uuid,(SELECT l.user_uuid FROM service_links l WHERE l.service_uuid=s.uuid AND l.link_kind='owner') FROM service_accounts s WHERE s.server_id=? AND s.external_user_id=? AND s.is_active=1`, c.Server, session.User).Scan(&row.Service, &row.Owner)
		if err != nil {
			return result, err
		}
		resolved = append(resolved, row)
	}
	rows, err := tx.QueryContext(ctx, `SELECT c.external_session_id,h.id,h.service_uuid,h.owner_uuid,h.item_id,h.media_type FROM media_activity_current c JOIN media_activity_history h ON h.id=c.history_id WHERE c.server_id=? ORDER BY c.external_session_id LIMIT 1001`, c.Server)
	if err != nil {
		return result, err
	}
	current := map[string]activeActivity{}
	for rows.Next() {
		var key string
		var row activeActivity
		if err = rows.Scan(&key, &row.History, &row.Service, &row.Owner, &row.Item, &row.Kind); err != nil {
			break
		}
		current[key] = row
	}
	if err == nil {
		err = rows.Err()
	}
	rows.Close()
	if err != nil {
		return result, err
	}
	if len(current) > 1000 {
		return result, ErrConflict
	}
	observed := utcTimestamp(snapshot.ObservedAt)
	for _, row := range resolved {
		session := row.Session
		old, exists := current[session.Session]
		if exists {
			reason := ""
			if old.Service != row.Service {
				reason = "identity_changed"
			} else if !sameActivityOwner(old.Owner, row.Owner) {
				reason = "ownership_changed"
			} else if old.Item != session.Item || old.Kind != session.Kind {
				reason = "item_changed"
			}
			if reason != "" {
				if err := endActivity(ctx, tx, c.Server, session.Session, old, observed, reason); err != nil {
					return result, err
				}
				result.Ended++
				exists = false
			}
		}
		historyID := old.History
		if exists {
			if _, err := tx.ExecContext(ctx, `UPDATE media_activity_history SET title=?,last_seen_at=?,paused=?,position_ticks=?,duration_ticks=?,client=coalesce(nullif(?,''),client),device_name=coalesce(nullif(?,''),device_name),play_method=coalesce(nullif(?,''),play_method) WHERE id=?`, session.Title, observed, session.Paused, session.Position, session.Duration, session.Client, session.Device, session.PlayMethod, old.History); err != nil {
				return result, err
			}
			result.Updated++
		} else {
			inserted, err := tx.ExecContext(ctx, `INSERT INTO media_activity_history(server_id,external_session_id,service_uuid,owner_uuid,item_id,media_type,title,first_seen_at,last_seen_at,paused,position_ticks,duration_ticks,parent_item_id,parent_title,client,device_name,play_method) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,nullif(?,''),nullif(?,''),nullif(?,''),nullif(?,''),nullif(?,''))`, c.Server, session.Session, row.Service, row.Owner, session.Item, session.Kind, session.Title, observed, observed, session.Paused, session.Position, session.Duration, session.Parent, session.ParentTitle, session.Client, session.Device, session.PlayMethod)
			if err != nil {
				return result, err
			}
			id, err := inserted.LastInsertId()
			if err != nil {
				return result, err
			}
			historyID = id
			if _, err := tx.ExecContext(ctx, `INSERT INTO media_activity_current(server_id,external_session_id,history_id) VALUES(?,?,?)`, c.Server, session.Session, id); err != nil {
				return result, err
			}
			result.Started++
		}
		delete(current, session.Session)
		display := []byte("{}")
		if session.Display != nil {
			var err error
			display, err = json.Marshal(session.Display)
			if err == nil && len(display) > 16384 && session.Display.RawDataJSON != "" {
				// Enrichment may grow the display after parsing. Diagnostics are
				// optional; never lose valid playback because of their budget.
				withoutDiagnostics := *session.Display
				withoutDiagnostics.RawDataJSON = ""
				display, err = json.Marshal(&withoutDiagnostics)
			}
			if err != nil || len(display) > 16384 {
				return result, errActivitySnapshot
			}
		}
		if _, err := tx.ExecContext(ctx, `UPDATE media_activity_current SET display_json=? WHERE server_id=? AND external_session_id=?`, string(display), c.Server, session.Session); err != nil {
			return result, err
		}
		// Keep the poster reference and library with the retained play, so
		// history can show them after the live display is gone. A later
		// snapshot without them never erases known values.
		if session.Display != nil {
			posterItem, posterPath := session.Display.PosterItem, session.Display.PosterPath
			if !validPlexCataloguePoster(posterItem, posterPath) {
				posterItem, posterPath = "", ""
			}
			library := session.Display.Library
			if len(library) > 1024 {
				library = ""
			}
			if _, err := tx.ExecContext(ctx, `UPDATE media_activity_history SET poster_item=CASE WHEN ?<>'' THEN ? ELSE poster_item END,poster_path=CASE WHEN ?<>'' THEN ? ELSE poster_path END,library_name=coalesce(nullif(?,''),library_name) WHERE id=?`, posterPath, posterItem, posterPath, posterPath, library, historyID); err != nil {
				return result, err
			}
		}
	}
	for id, old := range current {
		if err := endActivity(ctx, tx, c.Server, id, old, observed, "not_observed"); err != nil {
			return result, err
		}
		result.Ended++
	}
	if _, err := tx.ExecContext(ctx, `UPDATE media_activity_state SET pending_token=NULL,pending_at=NULL,pending_until=NULL,observed_at=?,observed_config_revision=?,observed_mapping_revision=?,observed_source=?,last_result='fresh',revision=revision+1 WHERE server_id=?`, observed, c.ConfigRevision, c.MappingRevision, activityObservationSource(c.Source), c.Server); err != nil {
		return result, err
	}
	if err := tx.QueryRowContext(ctx, `SELECT revision FROM media_activity_state WHERE server_id=?`, c.Server).Scan(&result.Revision); err != nil {
		return result, err
	}
	details, _ := json.Marshal(struct {
		Server, Generation      int64
		Started, Updated, Ended int
	}{c.Server, c.Generation, result.Started, result.Updated, result.Ended})
	if c.MonitorRevision != 0 {
		if err := finishActivityMonitor(ctx, tx, c, "SUCCEEDED"); err != nil {
			return result, err
		}
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO audit_events(actor_uuid,action,details,occurred_at) VALUES(?,'activity.snapshot',?,?)`, c.Actor, string(details), observed)
	return result, err
}
func (s *Store) applyActivitySnapshot(ctx context.Context, c activityReadClaim, snapshot activitySnapshot) (activityApplyResult, error) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	var result activityApplyResult
	err := s.write(ctx, func(tx *sql.Tx) error {
		var err error
		result, err = commitActivitySnapshot(ctx, tx, c, snapshot)
		return err
	})
	if err != nil {
		return activityApplyResult{}, err
	}
	return result, nil
}
func (s *Store) failActivityRead(ctx context.Context, c activityReadClaim) error {
	return s.write(ctx, func(tx *sql.Tx) error {
		if err := notificationAuthority(ctx, tx, c.Actor, c.Access); err != nil {
			return err
		}
		result, err := tx.ExecContext(ctx, `UPDATE media_activity_state SET pending_token=NULL,pending_at=NULL,pending_until=NULL,last_result='failed',revision=revision+1 WHERE server_id=? AND generation=? AND pending_token=?`, c.Server, c.Generation, c.Token)
		if err != nil {
			return err
		}
		count, err := result.RowsAffected()
		if err != nil {
			return err
		}
		if count != 1 {
			return ErrConflict
		}
		return nil
	})
}

// Private interactive helper. Scheduled polling uses a separately scoped
// persisted system claim; user access tokens are never cached for workers.
func (a *App) captureProviderActivity(ctx context.Context, actor, access string, serverID int64) (activityApplyResult, error) {
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	c, err := a.store.beginActivityRead(ctx, actor, access, serverID)
	if err != nil {
		return activityApplyResult{}, err
	}
	server, err := a.loadServer(ctx, serverID)
	var snapshot activitySnapshot
	if err == nil && (server.ConfigRevision != c.ConfigRevision || !server.EffectiveActive) {
		err = ErrConflict
	}
	if err == nil {
		var provider *serverConnection
		provider, err = newServerConnection(ProviderConfig{server.Type, server.URL, server.apiKey}, a.ProviderHTTP)
		if err == nil {
			provider.locations = &a.locationCache
			snapshot, err = provider.readActivitySnapshot(ctx)
		}
	}
	var result activityApplyResult
	if err == nil {
		result, err = a.store.applyActivitySnapshot(ctx, c, snapshot)
	}
	if err != nil {
		cleanup, stop := context.WithTimeout(context.Background(), 5*time.Second)
		defer stop()
		if recordErr := a.store.failActivityRead(cleanup, c); recordErr != nil && !errors.Is(recordErr, ErrConflict) && !errors.Is(recordErr, ErrForbidden) {
			return activityApplyResult{}, errors.Join(err, recordErr)
		}
		return activityApplyResult{}, err
	}
	return result, nil
}

func activityObservationSource(source string) string {
	if source == "ws" {
		return "ws"
	}
	return "http"
}
