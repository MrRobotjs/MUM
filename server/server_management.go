package main

import (
	"app/server/providers/plex"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

type ManagedServer struct {
	ID              int64  `json:"id"`
	Name            string `json:"server_nickname"`
	ServerName      string `json:"server_name"`
	Type            string `json:"service_type"`
	URL             string `json:"url"`
	PublicURL       string `json:"public_url"`
	Active          bool   `json:"is_active"`
	ProviderEnabled bool   `json:"provider_enabled"`
	EffectiveActive bool   `json:"effective_active"`
	HasAPIKey       bool   `json:"has_api_key"`
	Version         string `json:"last_version"`
	LastSync        string `json:"last_sync_at"`
	LastStatus      *bool  `json:"last_status"`
	LastStatusCheck string `json:"last_status_check"`
	Created         string `json:"created_at"`
	Updated         string `json:"updated_at"`
	Revision        int64  `json:"revision"`
	ConfigRevision  int64  `json:"-"`
	Overseerr       bool   `json:"overseerr_enabled"`
	OverseerrURL    string `json:"overseerr_url"`
	HasOverseerrKey bool   `json:"has_overseerr_api_key"`
	apiKey          string
	overseerrKey    string
}

const serverSelect = `SELECT s.id,s.server_nickname,coalesce(s.server_name,''),s.service_type,s.url,
 coalesce(s.public_url,''),s.is_active,coalesce(p.enabled,0),coalesce(s.api_key,''),
 coalesce(s.last_version,''),coalesce(s.last_sync_at,''),coalesce(s.created_at,''),coalesce(s.updated_at,''),s.revision,s.last_status,coalesce(s.last_status_check,''),s.config_revision,s.overseerr_enabled,coalesce(s.overseerr_url,''),coalesce(s.overseerr_api_key,'')
 FROM media_servers s LEFT JOIN provider_settings p ON p.provider_id=s.service_type`

type rowScanner interface{ Scan(...any) error }

func scanServer(row rowScanner) (ManagedServer, error) {
	var s ManagedServer
	err := row.Scan(&s.ID, &s.Name, &s.ServerName, &s.Type, &s.URL, &s.PublicURL, &s.Active, &s.ProviderEnabled, &s.apiKey, &s.Version, &s.LastSync, &s.Created, &s.Updated, &s.Revision, &s.LastStatus, &s.LastStatusCheck, &s.ConfigRevision, &s.Overseerr, &s.OverseerrURL, &s.overseerrKey)
	s.HasAPIKey = s.apiKey != ""
	s.HasOverseerrKey = s.overseerrKey != ""
	s.EffectiveActive = s.Active && s.ProviderEnabled
	return s, err
}
func (a *App) loadServer(ctx context.Context, id int64) (ManagedServer, error) {
	return scanServer(a.store.reader.QueryRowContext(ctx, serverSelect+" WHERE s.id=?", id))
}
func pathID(w http.ResponseWriter, r *http.Request, key string) (int64, bool) {
	id, err := strconv.ParseInt(r.PathValue(key), 10, 64)
	if err != nil || id <= 0 {
		fail(w, 400, "INVALID_ID", "Positive numeric ID required")
		return 0, false
	}
	return id, true
}
func domainError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, errAutomaticRoleOwnership):
		fail(w, 409, "AUTOMATIC_LABEL_CONFLICT", "Automatic Downloads label ownership conflicts with existing data; the previous snapshot was retained")
	case errors.Is(err, sql.ErrNoRows), errors.Is(err, ErrNotFound):
		fail(w, 404, "NOT_FOUND", "Resource not found")
	case errors.Is(err, ErrForbidden):
		fail(w, 403, "FORBIDDEN", "Permission denied")
	case errors.Is(err, ErrConflict):
		fail(w, 409, "CONFLICT", "Resource changed, is in use, or is already linked")
	default:
		fail(w, 500, "PERSISTENCE_FAILED", "Could not save the operation")
	}
}

func (a *App) providers(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.principal(w, r, true); !ok {
		return
	}
	items := []map[string]any{}
	for _, def := range compiledProviders {
		var enabled bool
		var count int
		if err := a.store.reader.QueryRowContext(r.Context(), "SELECT enabled,(SELECT count(*) FROM media_servers WHERE service_type=?) FROM provider_settings WHERE provider_id=?", def.ID, def.ID).Scan(&enabled, &count); err != nil {
			domainError(w, err)
			return
		}
		capabilities := []string{"auth.api_key", "server.test", "libraries.read", "libraries.sync", "users.read", "users.sync"}
		capabilities = append(capabilities, "users.libraries.update")
		if catalogueSupported(def.ID) {
			capabilities = append(capabilities, "libraries.items.sync")
		}
		if supportsProvisioning(def.ID) {
			capabilities = append(capabilities, "users.provision", "invitations.redeem")
		}
		if supportsDownloadLabels(def.ID) {
			capabilities = append(capabilities, "labels.downloads.sync")
		}
		if def.ID == "plex" {
			capabilities = append(capabilities, "integrations.overseerr")
		}
		if m, ok := findMediaModule(def.ID); ok {
			capabilities = moduleCapabilities(m)
		}
		items = append(items, map[string]any{"id": def.ID, "name": def.Name, "description": def.Description, "enabled": enabled, "server_count": count, "capabilities": capabilities, "plugin_type": "core"})
	}
	respond(w, 200, items)
}
func (a *App) setProviderEnabled(w http.ResponseWriter, r *http.Request) {
	p, ok := a.principal(w, r, true)
	if !ok {
		return
	}
	id := r.PathValue("provider")
	if _, ok := providerDefinition(id); !ok {
		fail(w, 404, "UNKNOWN_PROVIDER", "Provider not implemented")
		return
	}
	enabled := strings.HasSuffix(r.URL.Path, "/enable")
	err := a.store.write(r.Context(), func(tx *sql.Tx) error {
		if err := requirePermission(r.Context(), tx, p.UUID, "administrator"); err != nil {
			return err
		}
		if _, err := tx.ExecContext(r.Context(), "UPDATE provider_settings SET enabled=? WHERE provider_id=?", enabled, id); err != nil {
			return err
		}
		if _, err := tx.ExecContext(r.Context(), "UPDATE media_servers SET revision=revision+1 WHERE service_type=?", id); err != nil {
			return err
		}
		return auditAction(r.Context(), tx, p.UUID, "provider.state.change")
	})
	if err != nil {
		domainError(w, err)
		return
	}
	respond(w, 200, map[string]any{"id": id, "enabled": enabled})
}

func (a *App) listServers(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.principal(w, r, true); !ok {
		return
	}
	where := " WHERE 1=1"
	args := []any{}
	if provider := r.PathValue("provider"); provider != "" {
		if _, ok := providerDefinition(provider); !ok {
			fail(w, 404, "UNKNOWN_PROVIDER", "Provider not implemented")
			return
		}
		where += " AND s.service_type=?"
		args = append(args, provider)
	} else if provider := r.URL.Query().Get("service_type"); provider != "" {
		where += " AND s.service_type=?"
		args = append(args, provider)
	}
	if r.URL.Query().Get("active_only") == "true" {
		where += " AND s.is_active=1 AND p.enabled=1"
	}
	rows, err := a.store.reader.QueryContext(r.Context(), serverSelect+where+" ORDER BY s.id", args...)
	if err != nil {
		domainError(w, err)
		return
	}
	defer rows.Close()
	items := []ManagedServer{}
	for rows.Next() {
		s, err := scanServer(rows)
		if err != nil {
			domainError(w, err)
			return
		}
		items = append(items, s)
	}
	if rows.Err() != nil {
		domainError(w, rows.Err())
		return
	}
	respond(w, 200, items)
}
func (a *App) getServer(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.principal(w, r, true); !ok {
		return
	}
	id, ok := pathID(w, r, "server")
	if !ok {
		return
	}
	s, err := a.loadServer(r.Context(), id)
	if err != nil {
		domainError(w, err)
		return
	}
	respond(w, 200, s)
}

type serverInput struct {
	Name         *string `json:"server_nickname"`
	Type         *string `json:"service_type"`
	URL          *string `json:"url"`
	APIKey       *string `json:"api_key"`
	PublicURL    *string `json:"public_url"`
	Active       *bool   `json:"is_active"`
	Revision     *int64  `json:"revision"`
	Overseerr    *bool   `json:"overseerr_enabled"`
	OverseerrURL *string `json:"overseerr_url"`
	OverseerrKey *string `json:"overseerr_api_key"`
}

func validPublicURL(raw string) bool {
	if raw == "" {
		return true
	}
	u, err := url.Parse(raw)
	return err == nil && u.Host != "" && (u.Scheme == "http" || u.Scheme == "https") && u.User == nil && u.Fragment == ""
}
func (a *App) saveServer(w http.ResponseWriter, r *http.Request) {
	p, ok := a.principal(w, r, true)
	if !ok {
		return
	}
	var input serverInput
	if !decodeBody(w, r, &input) {
		return
	}
	create := r.Method == "POST"
	s := ManagedServer{Active: true}
	if !create {
		id, ok := pathID(w, r, "server")
		if !ok {
			return
		}
		var err error
		s, err = a.loadServer(r.Context(), id)
		if err != nil {
			domainError(w, err)
			return
		}
	}
	if input.Name != nil {
		s.Name = strings.TrimSpace(*input.Name)
	}
	if input.Type != nil {
		if !create && s.Type != *input.Type {
			fail(w, 400, "IMMUTABLE_PROVIDER", "Create another server to change its provider")
			return
		}
		s.Type = *input.Type
	}
	if provider := r.PathValue("provider"); provider != "" {
		if s.Type != "" && s.Type != provider {
			fail(w, 400, "PROVIDER_MISMATCH", "Provider does not match request path")
			return
		}
		s.Type = provider
	}
	if input.URL != nil {
		s.URL = strings.TrimRight(strings.TrimSpace(*input.URL), "/")
	}
	if input.APIKey != nil {
		s.apiKey = *input.APIKey
	}
	if input.PublicURL != nil {
		s.PublicURL = *input.PublicURL
	}
	if input.Active != nil {
		s.Active = *input.Active
	}
	if s.Name == "" || len(s.Name) > 100 || len(s.URL) > 512 || !validPublicURL(s.PublicURL) {
		fail(w, 400, "INVALID_SERVER", "Valid server name and URLs required")
		return
	}
	if err := validateProviderConfig(ProviderConfig{s.Type, s.URL, s.apiKey}); err != nil {
		fail(w, 400, "INVALID_SERVER", err.Error())
		return
	}
	before := []any{s.Overseerr, s.OverseerrURL, s.overseerrKey}
	if input.Overseerr != nil {
		s.Overseerr = *input.Overseerr
	}
	if input.OverseerrURL != nil {
		s.OverseerrURL = strings.TrimRight(strings.TrimSpace(*input.OverseerrURL), "/")
	}
	// An omitted or empty key keeps the stored key; it is never returned.
	if input.OverseerrKey != nil && *input.OverseerrKey != "" {
		s.overseerrKey = *input.OverseerrKey
	}
	overseerrChanged := create || before[0] != s.Overseerr || before[1] != s.OverseerrURL || before[2] != s.overseerrKey
	if s.Overseerr {
		if s.Type != "plex" {
			fail(w, 422, "UNSUPPORTED_INTEGRATION", "Overseerr can be attached only to a Plex server")
			return
		}
		if err := validateOverseerrConfig(s.OverseerrURL, s.overseerrKey); err != nil {
			fail(w, 400, "INVALID_OVERSEERR", err.Error())
			return
		}
		// Verify a changed configuration before saving; the test runs outside the writer.
		if overseerrChanged {
			client, _ := newOverseerrClient(s.OverseerrURL, s.overseerrKey, a.ProviderHTTP)
			if _, _, err := client.test(r.Context()); err != nil {
				fail(w, 502, "OVERSEERR_UNAVAILABLE", overseerrMessage(err))
				return
			}
		}
	}
	if input.Revision != nil && *input.Revision != s.Revision {
		domainError(w, ErrConflict)
		return
	}
	now := utcTimestamp(time.Now())
	monitoringDefault := false
	err := a.store.write(r.Context(), func(tx *sql.Tx) error {
		if err := requirePermission(r.Context(), tx, p.UUID, "administrator"); err != nil {
			return err
		}
		var duplicate bool
		if err := tx.QueryRowContext(r.Context(), "SELECT EXISTS(SELECT 1 FROM media_servers WHERE server_nickname=? AND id!=?)", s.Name, s.ID).Scan(&duplicate); err != nil {
			return err
		}
		if duplicate {
			return ErrConflict
		}
		if create {
			result, err := tx.ExecContext(r.Context(), `INSERT INTO media_servers(server_nickname,service_type,url,api_key,public_url,is_active,created_at,updated_at,overseerr_enabled,overseerr_url,overseerr_api_key) VALUES(?,?,?,?,?,?,?,?,?,nullif(?,''),nullif(?,''))`, s.Name, s.Type, s.URL, s.apiKey, s.PublicURL, s.Active, now, now, s.Overseerr, s.OverseerrURL, s.overseerrKey)
			if err != nil {
				return err
			}
			s.ID, err = result.LastInsertId()
			if err != nil {
				return err
			}
			if err := recordServerNotification(r.Context(), tx, s.ID); err != nil {
				return err
			}
			if _, err = tx.ExecContext(r.Context(), "UPDATE provider_settings SET enabled=1 WHERE provider_id=?", s.Type); err != nil {
				return err
			}
			// Owner-added supported sources monitor by default (user policy).
			// Persist the current owner's authority and exact configuration in the
			// creation transaction; delegated additions still require owner review.
			if s.Active && activitySupported(s.Type) {
				if err := notificationAuthority(r.Context(), tx, p.UUID, bearer(r)); err != nil {
					return err
				}
				current, err := loadPrincipal(r.Context(), tx, p.UUID)
				if err != nil {
					return err
				}
				if current.Kind == "owner" {
					if _, err := tx.ExecContext(r.Context(), `UPDATE activity_monitor_schedules SET socket_enabled=1,socket_revision=socket_revision+1,enabled=1,authorized_by=?,configured_server_revision=(SELECT config_revision FROM media_servers WHERE id=?),next_run_at=?,revision=revision+1 WHERE server_id=?`, p.UUID, s.ID, now, s.ID); err != nil {
						return err
					}
					if err := activityMonitorAudit(r.Context(), tx, p.UUID, "activity.monitor.default", s.ID, "OWNER_SOURCE_ADDED"); err != nil {
						return err
					}
					monitoringDefault = true
				}
			}
		} else {
			result, err := tx.ExecContext(r.Context(), `UPDATE media_servers SET server_nickname=?,url=?,api_key=?,public_url=?,is_active=?,overseerr_enabled=?,overseerr_url=nullif(?,''),overseerr_api_key=nullif(?,''),updated_at=?,revision=revision+1,last_status=NULL,last_status_check=NULL,last_status_error=NULL WHERE id=? AND revision=?`, s.Name, s.URL, s.apiKey, s.PublicURL, s.Active, s.Overseerr, s.OverseerrURL, s.overseerrKey, now, s.ID, s.Revision)
			if err != nil {
				return err
			}
			n, err := result.RowsAffected()
			if err != nil {
				return err
			}
			if n != 1 {
				return ErrConflict
			}
		}
		return auditAction(r.Context(), tx, p.UUID, "server.save")
	})
	if err != nil {
		domainError(w, err)
		return
	}
	a.logger.Info("Server saved", "server_id", s.ID, "provider", s.Type, "created", create)
	if monitoringDefault {
		a.logger.Info("Activity monitoring enabled by default", "server_id", s.ID, "provider", s.Type, "interval_seconds", 30)
	}
	// Link a newly attached Overseerr right away; failures are recorded and the
	// next users sync retries. The save itself has already committed.
	if s.Overseerr && overseerrChanged {
		refreshCtx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
		_ = a.refreshOverseerrLinks(refreshCtx, s.ID)
		cancel()
	}
	saved, err := a.loadServer(r.Context(), s.ID)
	if err != nil {
		domainError(w, err)
		return
	}
	status := 200
	if create {
		status = 201
	}
	respond(w, status, saved)
}
func (a *App) deleteServer(w http.ResponseWriter, r *http.Request) {
	p, ok := a.principal(w, r, true)
	if !ok {
		return
	}
	id, ok := pathID(w, r, "server")
	if !ok {
		return
	}
	err := a.store.write(r.Context(), func(tx *sql.Tx) error {
		if err := requirePermission(r.Context(), tx, p.UUID, "administrator"); err != nil {
			return err
		}
		for _, table := range []string{"service_accounts", "media_libraries", "media_stream_history", "log_entries", "notifications", "invite_servers", "invite_server_features", "invitation_grants", "provisioning_steps", "overseerr_user_links"} {
			var count int
			if err := tx.QueryRowContext(r.Context(), "SELECT count(*) FROM "+table+" WHERE server_id=?", id).Scan(&count); err != nil {
				return err
			}
			if count != 0 {
				return ErrConflict
			}
		}
		result, err := tx.ExecContext(r.Context(), "DELETE FROM media_servers WHERE id=?", id)
		if err != nil {
			return err
		}
		n, err := result.RowsAffected()
		if err != nil {
			return err
		}
		if n != 1 {
			return ErrNotFound
		}
		return auditAction(r.Context(), tx, p.UUID, "server.delete")
	})
	if err != nil {
		domainError(w, err)
		return
	}
	respond(w, 200, map[string]bool{"success": true})
}
func (a *App) testProviderConnection(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.principal(w, r, true); !ok {
		return
	}
	var input struct {
		URL              string `json:"url"`
		APIKey           string `json:"api_key"`
		OverseerrEnabled bool   `json:"overseerr_enabled"`
		OverseerrURL     string `json:"overseerr_url"`
		OverseerrKey     string `json:"overseerr_api_key"`
	}
	if !decodeBody(w, r, &input) {
		return
	}
	provider, err := newServerConnection(ProviderConfig{r.PathValue("provider"), strings.TrimRight(input.URL, "/"), input.APIKey}, a.ProviderHTTP)
	if err != nil {
		fail(w, 400, "INVALID_SERVER", err.Error())
		return
	}
	info, err := provider.Test(r.Context())
	if err != nil {
		fail(w, 502, "UPSTREAM_FAILED", err.Error())
		return
	}
	result := map[string]any{"success": true, "message": "Connected to " + info.Name, "server": info}
	if input.OverseerrEnabled {
		// Links are computed only for a saved server after its users sync.
		check := map[string]any{"success": false, "linked_users": []any{}}
		client, err := newOverseerrClient(input.OverseerrURL, input.OverseerrKey, a.ProviderHTTP)
		if err != nil {
			check["message"] = err.Error()
		} else if version, total, err := client.test(r.Context()); err != nil {
			check["message"] = overseerrMessage(err)
		} else {
			check["success"], check["message"] = true, fmt.Sprintf("Connected to Overseerr v%s; %d users visible", version, total)
		}
		result["overseerr"] = check
	}
	respond(w, 200, result)
}
func (a *App) testSavedServer(w http.ResponseWriter, r *http.Request) {
	p, ok := a.principal(w, r, true)
	if !ok {
		return
	}
	id, ok := pathID(w, r, "server")
	if !ok {
		return
	}
	var input struct {
		Revision *int64 `json:"expected_server_revision"`
	}
	if r.ContentLength != 0 {
		if !decodeStrictBody(w, r, &input) {
			return
		}
		if input.Revision == nil || *input.Revision < 0 {
			fail(w, 400, "INVALID_REVISION", "Use a current server revision")
			return
		}
	}
	s, err := a.loadServer(r.Context(), id)
	if err != nil {
		domainError(w, err)
		return
	}
	if input.Revision != nil && *input.Revision != s.Revision {
		domainError(w, ErrConflict)
		return
	}
	provider, err := newServerConnection(ProviderConfig{s.Type, s.URL, s.apiKey}, a.ProviderHTTP)
	if err != nil {
		fail(w, 400, "INVALID_SERVER", err.Error())
		return
	}
	info, probeErr := provider.Test(r.Context())
	checkedAt := utcTimestamp(time.Now())
	err = a.store.write(r.Context(), func(tx *sql.Tx) error {
		if err := notificationAuthority(r.Context(), tx, p.UUID, bearer(r)); err != nil {
			return err
		}
		result, err := tx.ExecContext(r.Context(), `UPDATE media_servers SET server_name=CASE WHEN ? THEN ? ELSE server_name END,last_version=CASE WHEN ? THEN ? ELSE last_version END,last_status=?,last_status_check=? WHERE id=? AND revision=?`, probeErr == nil, info.Name, probeErr == nil, info.Version, probeErr == nil, checkedAt, s.ID, s.Revision)
		if err != nil {
			return err
		}
		n, err := result.RowsAffected()
		if err != nil {
			return err
		}
		if n != 1 {
			return ErrConflict
		}
		return nil
	})
	if err != nil {
		domainError(w, err)
		return
	}
	if probeErr != nil {
		fail(w, 502, "UPSTREAM_FAILED", probeErr.Error())
		return
	}
	respond(w, 200, map[string]any{"success": true, "server": info, "server_id": s.ID, "revision": s.Revision, "checked_at": checkedAt})
}

func checkServerSyncAuthority(ctx context.Context, tx *sql.Tx, actor, access string, claim *scheduledSyncClaim) error {
	if busy, err := bulkSourceBusy(ctx, tx, 0, ""); err != nil {
		return err
	} else if busy {
		return ErrConflict
	}
	if claim != nil {
		if actor != claim.Actor || access != "" {
			return ErrForbidden
		}
		if err := checkScheduledSyncClaim(ctx, tx, claim); err != nil {
			return err
		}
	} else if err := accountPreferenceAuthority(ctx, tx, actor, access); err != nil {
		return err
	}
	return requirePermission(ctx, tx, actor, "administrator")
}
func (a *App) readServerSyncAuthority(ctx context.Context, actor, access string, s ManagedServer, users bool, claim *scheduledSyncClaim) (int64, error) {
	if claim != nil && claim.Server != s.ID {
		return 0, ErrForbidden
	}
	tx, err := a.store.reader.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()
	if err = checkServerSyncAuthority(ctx, tx, actor, access, claim); err != nil {
		return 0, err
	}
	var revision int64
	if users && supportsDownloadLabels(s.Type) {
		if err = tx.QueryRowContext(ctx, "SELECT revision FROM download_role_state WHERE singleton=1").Scan(&revision); err != nil {
			return 0, err
		}
	}
	return revision, tx.Commit()
}
func (a *App) syncServer(ctx context.Context, actor, access string, s ManagedServer, libraries, users bool) (map[string]int, error) {
	return a.syncServerClaimed(ctx, actor, access, s, libraries, users, nil)
}
func (a *App) syncServerClaimed(ctx context.Context, actor, access string, s ManagedServer, libraries, users bool, claim *scheduledSyncClaim) (receipt map[string]int, outcome error) {
	started := time.Now()
	a.logger.Debug("Provider sync started", "server_id", s.ID, "provider", s.Type, "libraries", libraries, "users", users)
	defer func() {
		if outcome != nil {
			a.logger.Warn("Provider sync failed", "server_id", s.ID, "provider", s.Type, "code", consoleErrorCode(outcome), "duration_ms", time.Since(started).Milliseconds())
		} else {
			a.logger.Info("Provider sync completed", "server_id", s.ID, "provider", s.Type, "libraries", receipt["libraries"], "users", receipt["users"], "added", receipt["added"], "updated", receipt["updated"], "removed", receipt["removed"], "duration_ms", time.Since(started).Milliseconds())
		}
	}()
	if !s.EffectiveActive {
		return nil, ErrConflict
	}
	downloadRoleRevision, err := a.readServerSyncAuthority(ctx, actor, access, s, users, claim)
	if err != nil {
		return nil, err
	}
	provider, err := newServerConnection(ProviderConfig{s.Type, s.URL, s.apiKey}, a.ProviderHTTP)
	if err != nil {
		return nil, err
	}
	var libs []ProviderLibrary
	var accounts []ProviderUser
	// Fetch and validate the complete requested snapshot before any writes.
	if libraries {
		libs, err = provider.Libraries(ctx)
		if err != nil {
			return nil, err
		}
	}
	if users {
		var reader libraryAwareUserReader
		if libraries {
			reader, _ = provider.module().(libraryAwareUserReader)
		}
		if reader != nil {
			rows, readErr := reader.UsersWithLibraries(ctx, libs)
			if accounts, err = nil, readErr; err == nil {
				accounts, err = validateUsers(rows)
			}
		} else {
			accounts, err = provider.Users(ctx)
		}
		if err != nil {
			return nil, err
		}
		accounts, err = validateUsers(accounts)
		if err != nil {
			return nil, err
		}
	}
	added, updated, removed := 0, 0, 0
	err = a.store.write(ctx, func(tx *sql.Tx) error {
		if err := checkServerSyncAuthority(ctx, tx, actor, access, claim); err != nil {
			return err
		}
		var active bool
		if err := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM media_servers s JOIN provider_settings p ON p.provider_id=s.service_type WHERE s.id=? AND s.revision=? AND s.is_active=1 AND p.enabled=1)`, s.ID, s.Revision).Scan(&active); err != nil {
			return err
		}
		if !active {
			return ErrConflict
		}
		now := utcTimestamp(time.Now())
		downloadRole := ""
		if users && supportsDownloadLabels(s.Type) {
			for _, account := range accounts {
				if account.Access != nil && account.Access.DownloadsKnown {
					var err error
					downloadRole, err = ensureDownloadRole(ctx, tx, downloadRoleRevision)
					if err != nil {
						return err
					}
					break
				}
			}
		}
		downloadChanges := []downloadLabelChange{}
		if libraries {
			if _, err := tx.ExecContext(ctx, "UPDATE media_libraries SET is_available=0 WHERE server_id=?", s.ID); err != nil {
				return err
			}
			for _, lib := range libs {
				if _, err := tx.ExecContext(ctx, `INSERT INTO media_libraries(internal_id,server_id,external_id,name,library_type,item_count,last_scanned,is_available) VALUES(?,?,?,?,?,?,?,1)
			 ON CONFLICT(server_id,external_id) DO UPDATE SET name=excluded.name,library_type=excluded.library_type,item_count=excluded.item_count,last_scanned=excluded.last_scanned,updated_at=excluded.last_scanned,is_available=1`, newUUID(), s.ID, lib.ID, lib.Name, lib.Type, lib.ItemCount, now); err != nil {
					return err
				}
			}
		}
		if users {
			priorActive := map[string]bool{}
			rows, err := tx.QueryContext(ctx, "SELECT external_user_id FROM service_accounts WHERE server_id=? AND is_active=1", s.ID)
			if err != nil {
				return err
			}
			for rows.Next() {
				var external sql.NullString
				if err := rows.Scan(&external); err != nil {
					rows.Close()
					return err
				}
				removed++
				if external.Valid {
					priorActive[external.String] = true
				}
			}
			if err := errors.Join(rows.Err(), rows.Close()); err != nil {
				return err
			}
			// Everything is first marked inactive and, unless it is an invitation
			// still awaiting acceptance, removed; accounts in this snapshot are
			// restored below. Removed accounts keep their records and history.
			if _, err := tx.ExecContext(ctx, `UPDATE service_accounts SET is_active=0,removed_at=CASE WHEN coalesce(json_extract(service_settings,'$.invitation_pending'),0)=1 THEN removed_at ELSE coalesce(removed_at,?) END WHERE server_id=? AND NOT (?='plex' AND coalesce(json_extract(service_settings,'$.activity_observed'),0)=1)`, now, s.ID, s.Type); err != nil {
				return err
			}
			for _, account := range accounts {
				if _, err := tx.ExecContext(ctx, "DELETE FROM bulk_removed_identities WHERE server_id=? AND external_user_id=?", s.ID, account.ID); err != nil {
					return err
				}
				var uuid string
				wasActive := priorActive[account.ID]
				err := tx.QueryRowContext(ctx, "SELECT uuid FROM service_accounts WHERE server_id=? AND external_user_id=?", s.ID, account.ID).Scan(&uuid)
				if errors.Is(err, sql.ErrNoRows) {
					added++
					uuid = newUUID()
					if _, err := tx.ExecContext(ctx, "INSERT INTO identities(uuid,kind) VALUES(?,'service')", uuid); err != nil {
						return err
					}
				} else if err != nil {
					return err
				} else {
					updated++
				}
				if wasActive && account.Active {
					removed--
				}
				allowed, _ := json.Marshal(account.LibraryIDs)
				policy := map[string]bool{"all_libraries": account.AllLibraries, "library_policy_known": true}
				knownDownloads, allowDownloads := false, false
				if account.Access != nil {
					policy["library_policy_known"] = account.Access.LibrariesKnown
					policy["download_policy_known"] = account.Access.DownloadsKnown
					if reporter, ok := moduleRules(s.Type).(contentRestrictionReporter); ok && reporter.ContentRestrictionsReported() {
						policy["content_restrictions_present"] = account.Access.ContentRestricted
					}
					knownDownloads = account.Access.DownloadsKnown
					allowDownloads = account.Access.AllowDownloads
				}
				settings, _ := json.Marshal(policy)
				avatar, joined := "", ""
				if account.Profile != nil && s.Type == "plex" {
					avatar = plex.UserAvatar(account.Profile.AvatarURL)
					if value, err := time.Parse(time.RFC3339, account.Profile.JoinDate); err == nil {
						joined = value.UTC().Format(time.RFC3339)
					}
				}
				// Missing optional fields are not evidence of removal. In particular,
				// providers without profile discovery must preserve verified metadata.
				if _, err := tx.ExecContext(ctx, `INSERT INTO service_accounts(uuid,server_id,external_user_id,external_username,external_email,allowed_library_ids,service_settings,is_active,created_at,updated_at,allow_downloads,external_avatar_url,service_join_date)
				 VALUES(?,?,?,?,?,?,?,?,?,?,?,nullif(?,''),nullif(?,'')) ON CONFLICT(server_id,external_user_id) DO UPDATE SET removed_at=NULL,external_username=excluded.external_username,external_email=excluded.external_email,allowed_library_ids=excluded.allowed_library_ids,service_settings=excluded.service_settings,is_active=excluded.is_active,updated_at=excluded.updated_at,allow_downloads=CASE WHEN ? THEN excluded.allow_downloads ELSE service_accounts.allow_downloads END,external_avatar_url=coalesce(excluded.external_avatar_url,service_accounts.external_avatar_url),service_join_date=coalesce(excluded.service_join_date,service_accounts.service_join_date)`, uuid, s.ID, account.ID, account.Name, account.Email, string(allowed), string(settings), account.Active, now, now, allowDownloads, avatar, joined, knownDownloads); err != nil {
					return err
				}
				if downloadRole != "" {
					change, err := reconcileDownloadLabel(ctx, tx, s, downloadRole, uuid, account, now)
					if err != nil {
						return err
					}
					if change != nil {
						downloadChanges = append(downloadChanges, *change)
					}
				}
			}
			// PMS-observed identities are outside the cloud friend snapshot.
			// Preserve them without claiming that an absent friend is a deleted account.
			if s.Type == "plex" {
				var preserved int
				if err := tx.QueryRowContext(ctx, `SELECT count(*) FROM service_accounts WHERE server_id=? AND is_active=1 AND coalesce(json_extract(service_settings,'$.activity_observed'),0)=1`, s.ID).Scan(&preserved); err != nil {
					return err
				}
				removed -= preserved
			}

		}
		if len(downloadChanges) > 0 {
			details, err := json.Marshal(struct {
				Server   int64                 `json:"server_id"`
				Revision int64                 `json:"source_revision"`
				Role     string                `json:"role_id"`
				Changes  []downloadLabelChange `json:"observations"`
			}{s.ID, s.Revision + 1, downloadRole, downloadChanges})
			if err != nil {
				return err
			}
			if _, err = tx.ExecContext(ctx, "INSERT INTO audit_events(actor_uuid,action,details,occurred_at) VALUES(?,'provider.labels.reconcile',?,?)", actor, string(details), now); err != nil {
				return err
			}
		}
		if _, err := tx.ExecContext(ctx, "UPDATE media_servers SET last_sync_at=?,updated_at=?,revision=revision+1 WHERE id=?", now, now, s.ID); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, "UPDATE admin_notifications SET resolved=1 WHERE server_id=? AND resolved=0", s.ID); err != nil {
			return err
		}
		if claim != nil {
			if err := finishScheduledSync(ctx, tx, claim, "SUCCEEDED"); err != nil {
				return err
			}
		}
		return auditAction(ctx, tx, actor, "server.sync")
	})
	if err != nil {
		return nil, err
	}
	// Overseerr links follow the committed Plex users; a failure is recorded on
	// the Overseerr state and never fails the Plex sync.
	if users && s.Type == "plex" {
		_ = a.refreshOverseerrLinks(ctx, s.ID)
	}
	return map[string]int{"libraries": len(libs), "users": len(accounts), "added": added, "updated": updated, "removed": removed}, nil
}

func (a *App) syncServerEndpoint(w http.ResponseWriter, r *http.Request) {
	p, ok := a.principal(w, r, true)
	if !ok {
		return
	}
	id, ok := pathID(w, r, "server")
	if !ok {
		return
	}
	var input struct {
		Revision *int64 `json:"expected_server_revision"`
	}
	if r.ContentLength != 0 {
		if !decodeStrictBody(w, r, &input) {
			return
		}
		if input.Revision == nil || *input.Revision < 0 {
			fail(w, 400, "INVALID_REVISION", "Use a current server revision")
			return
		}
	}
	s, err := a.loadServer(r.Context(), id)
	if err != nil {
		domainError(w, err)
		return
	}
	if input.Revision != nil && *input.Revision != s.Revision {
		domainError(w, ErrConflict)
		return
	}
	if !a.syncRun.TryLock() {
		fail(w, 409, "SYNC_BUSY", "Another synchronization is running")
		return
	}
	defer a.syncRun.Unlock()
	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()
	a.setSyncProgress(true, p, 1, 1, s.Name)
	defer a.setSyncProgress(false, p, 0, 0, "")
	libraries, users := true, true
	if strings.HasSuffix(r.URL.Path, "/sync-libraries") {
		users = false
	}
	if strings.HasSuffix(r.URL.Path, "/sync-users") {
		libraries = false
	}
	counts, err := a.syncServer(ctx, p.UUID, bearer(r), s, libraries, users)
	if err != nil {
		if errors.Is(err, ErrConflict) || errors.Is(err, ErrForbidden) {
			domainError(w, err)
		} else {
			fail(w, 502, "SYNC_FAILED", "Provider synchronization failed; previous snapshot retained")
		}
		return
	}
	scope := "all"
	if !users {
		scope = "libraries"
	} else if !libraries {
		scope = "users"
	}
	result := map[string]any{"server_id": s.ID, "source_revision": s.Revision, "revision": s.Revision + 1, "scope": scope}
	for key, value := range counts {
		result[key] = value
	}
	respond(w, 200, result)
}

func (a *App) setSyncProgress(active bool, p Principal, current, total int, name string) {
	a.syncMu.Lock()
	var started any
	if active {
		started = utcTimestamp(time.Now())
		if a.syncState != nil && a.syncState["is_syncing"] == true {
			started = a.syncState["started_at"]
		}
	}
	state := map[string]any{"is_syncing": active, "started_at": started, "started_by": p.ID, "started_by_username": p.Username, "progress": map[string]any{"current_server": current, "total_servers": total, "current_server_name": name}}
	a.syncState = state
	a.syncMu.Unlock()
	a.hub.publish("system.sync_status", "TaskProgress", state)
}
func (a *App) getSyncStatus(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.principal(w, r, true); !ok {
		return
	}
	a.syncMu.Lock()
	state := a.syncState
	a.syncMu.Unlock()
	if state == nil {
		state = map[string]any{"is_syncing": false, "progress": map[string]any{"current_server": 0, "total_servers": 0, "current_server_name": nil}}
	}
	respond(w, 200, state)
}

func (a *App) listLibraries(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.principal(w, r, true); !ok {
		return
	}
	where := " WHERE l.is_available=1"
	args := []any{}
	if raw := r.URL.Query().Get("server_id"); raw != "" {
		id, err := strconv.ParseInt(raw, 10, 64)
		if err != nil || id <= 0 {
			fail(w, 400, "INVALID_ID", "Invalid server ID")
			return
		}
		where += " AND l.server_id=?"
		args = append(args, id)
	}
	if kind := r.URL.Query().Get("library_type"); kind != "" {
		where += " AND l.library_type=?"
		args = append(args, kind)
	}
	if search := r.URL.Query().Get("search"); search != "" {
		where += " AND instr(lower(l.name),lower(?))>0"
		args = append(args, search)
	}
	if raw := r.PathValue("library"); raw != "" {
		id, ok := pathID(w, r, "library")
		if !ok {
			return
		}
		where += " AND l.id=?"
		args = append(args, id)
	}
	rows, err := a.store.reader.QueryContext(r.Context(), `SELECT l.id,l.internal_id,l.server_id,l.external_id,l.name,coalesce(l.library_type,''),l.item_count,coalesce(l.last_scanned,''),s.server_nickname,s.service_type,l.catalogue_revision,coalesce(l.catalogue_synced_at,''),l.catalogue_item_count FROM media_libraries l JOIN media_servers s ON s.id=l.server_id`+where+" ORDER BY l.id", args...)
	if err != nil {
		domainError(w, err)
		return
	}
	defer rows.Close()
	items := []map[string]any{}
	for rows.Next() {
		var id, server int64
		var internal, external, name, kind, scanned, nickname, provider string
		var count, catalogueCount sql.NullInt64
		var catalogueRevision int64
		var catalogueSynced string
		if err := rows.Scan(&id, &internal, &server, &external, &name, &kind, &count, &scanned, &nickname, &provider, &catalogueRevision, &catalogueSynced, &catalogueCount); err != nil {
			domainError(w, err)
			return
		}
		var number any
		if count.Valid {
			number = count.Int64
		}
		items = append(items, map[string]any{"id": id, "internal_id": internal, "server_id": server, "external_id": external, "name": name, "library_type": kind, "item_count": number, "last_scanned": scanned, "server": map[string]any{"id": server, "server_nickname": nickname, "service_type": provider},
			"catalogue": map[string]any{"supported": catalogueLibrarySupported(provider, kind, external), "collections_supported": collectionsSupported(provider, kind, external), "revision": catalogueRevision, "synced_at": nullableText(catalogueSynced), "item_count": nullableCount(catalogueCount)}})
	}
	if rows.Err() != nil {
		domainError(w, rows.Err())
		return
	}
	if r.PathValue("library") != "" {
		if len(items) == 0 {
			domainError(w, ErrNotFound)
			return
		}
		respond(w, 200, items[0])
		return
	}
	respond(w, 200, items)
}

func nullableText(v string) any {
	if v == "" {
		return nil
	}
	return v
}
func nullableCount(v sql.NullInt64) any {
	if !v.Valid {
		return nil
	}
	return v.Int64
}
