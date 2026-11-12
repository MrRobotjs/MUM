package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// serviceRemoteRecord is the owner-only view of one recorded service account's
// remote access state. Provider URLs, keys, fingerprints and lease tokens stay
// private; the remote ID is used only server-side.
type serviceRemoteRecord struct {
	Actor      string  `json:"actor_uuid"`
	Target     string  `json:"service_uuid"`
	Server     string  `json:"server_id"`
	Provider   string  `json:"service_type"`
	Username   string  `json:"username"`
	Owner      *string `json:"owner_uuid"`
	Active     bool    `json:"is_active"`
	Expires    *string `json:"access_expires_at"`
	Revision   string  `json:"operation_revision"`
	Link       string  `json:"link_revision"`
	Source     string  `json:"server_revision"`
	State      string  `json:"state"`
	Code       *string `json:"error_code"`
	Checked    *string `json:"checked_at"`
	Scope      string  `json:"cleanup_scope"`
	Reason     string  `json:"availability"`
	CanDisable bool    `json:"can_disable"`
	Enable     string  `json:"enable_availability"`
	CanEnable  bool    `json:"can_enable"`
	Delete     string  `json:"delete_availability"`
	CanDelete  bool    `json:"can_delete"`

	serverID    int64
	revision    int64
	configRev   int64
	linkRev     int64
	externalID  string
	fingerprint string
}

// Only providers whose verified inspect/disable adapters already exist. A
// module without an account-disable flag (Komga) reports "media": its
// cleanup removes media access only.
func serviceRemoteScope(kind string) string {
	if m := moduleRules(kind); m != nil {
		_, inspects := m.(accountInspector)
		_, disables := m.(accountDisabler)
		if !inspects || !disables {
			return ""
		}
		if scope, ok := m.(cleanupScoper); ok {
			return scope.CleanupScope()
		}
		return "account"
	}
	return ""
}

// The recorded identity must satisfy the same adapter contract recovery uses.
// Nothing is looked up or adopted by username.
func serviceRemoteIdentity(kind, id, name string) bool {
	if m := moduleRules(kind); m != nil {
		return moduleIdentityValid(m, id, name)
	}
	return validProvisionedID(id) && name != ""
}

func readServiceRemote(ctx context.Context, tx *sql.Tx, actor, access, target string) (serviceRemoteRecord, error) {
	out := serviceRemoteRecord{Actor: actor, Target: target}
	if err := notificationAuthority(ctx, tx, actor, access); err != nil {
		return out, err
	}
	authority, err := readAdminRoleHierarchyActor(ctx, tx, actor)
	if err != nil {
		return out, err
	}
	if !validAdminMemberCursor(target) {
		return out, ErrNotFound
	}
	var external sql.NullString
	var link int64
	err = tx.QueryRowContext(ctx, `SELECT coalesce(a.external_username,''),a.external_user_id,a.server_id,a.is_active,a.access_expires_at,(SELECT user_uuid FROM service_links WHERE service_uuid=a.uuid AND link_kind='owner'),o.revision,o.state,o.error_code,o.checked_at,(SELECT revision FROM account_link_state WHERE singleton=1) FROM service_accounts a JOIN service_remote_access o ON o.service_uuid=a.uuid WHERE a.uuid=?`, target).Scan(&out.Username, &external, &out.serverID, &out.Active, &out.Expires, &out.Owner, &out.revision, &out.State, &out.Code, &out.Checked, &link)
	if err != nil {
		return out, err
	}
	server, err := scanServer(tx.QueryRowContext(ctx, serverSelect+" WHERE s.id=?", out.serverID))
	if err != nil {
		return out, err
	}
	// Delegated administrators act only on accounts primarily owned by a
	// lower-ranked local human, never the owner's, their own or unowned ones.
	protection := ""
	if !authority.Owner {
		var ownerKind string
		switch {
		case out.Owner == nil:
			protection = "owner_only"
		case *out.Owner == actor:
			protection = "protected_self"
		default:
			if err = tx.QueryRowContext(ctx, "SELECT kind FROM user_accounts WHERE uuid=?", *out.Owner).Scan(&ownerKind); err != nil {
				return out, err
			}
			if ownerKind == "owner" {
				protection = "protected_owner"
			} else if err = checkAdminRoleHierarchyTarget(ctx, tx, authority, *out.Owner); err != nil {
				return out, err
			}
		}
	}
	out.linkRev = link
	out.externalID = external.String
	out.configRev = server.ConfigRevision
	out.fingerprint = providerFingerprint(server)
	out.Provider = server.Type
	out.Scope = serviceRemoteScope(server.Type)
	out.Server = strconv.FormatInt(out.serverID, 10)
	out.Revision = strconv.FormatInt(out.revision, 10)
	out.Link = strconv.FormatInt(link, 10)
	out.Source = strconv.FormatInt(server.ConfigRevision, 10)
	pending, err := servicePendingWork(ctx, tx, out.serverID)
	if err != nil {
		return out, err
	}
	switch {
	case protection != "":
		out.Reason = protection
	case out.State == "running":
		out.Reason = "running"
	case out.Scope == "":
		out.Reason = "unsupported"
	case !server.EffectiveActive || !server.HasAPIKey:
		out.Reason = "server_inactive"
	case !external.Valid || !serviceRemoteIdentity(server.Type, out.externalID, out.Username):
		out.Reason = "identity_unknown"
	case pending:
		out.Reason = "pending_work"
	default:
		out.Reason = "available"
	}
	out.CanDisable = out.Reason == "available"
	// Re-enabling must not contradict local policy: an elapsed service expiry
	// or an inactive/expired owning human blocks it until that policy changes.
	out.Enable = out.Reason
	if out.Enable == "available" {
		ownerActive := true
		if out.Owner != nil {
			if err = tx.QueryRowContext(ctx, "SELECT is_active=1 AND (access_expires_at IS NULL OR coalesce(julianday(access_expires_at)>julianday('now'),0)) FROM user_accounts WHERE uuid=?", *out.Owner).Scan(&ownerActive); err != nil {
				return out, err
			}
		}
		expired := false
		if out.Expires != nil {
			deadline, err := time.Parse(time.RFC3339Nano, *out.Expires)
			expired = err != nil || !deadline.After(time.Now())
		}
		switch {
		case out.Scope != "account":
			out.Enable = "unsupported"
		case expired:
			out.Enable = "service_expired"
		case !ownerActive:
			out.Enable = "owner_inactive"
		}
	}
	out.CanEnable = out.Enable == "available"
	// Delete is irreversible: owner-only, ID-addressed providers only, and only
	// after MUM has verified the account disabled.
	out.Delete = out.Reason
	if out.Delete == "available" {
		switch {
		case !authority.Owner:
			out.Delete = "owner_only"
		case !serviceRemoteDeletable(server.Type):
			out.Delete = "unsupported"
		case out.State != "disabled":
			out.Delete = "disable_first"
		}
	}
	out.CanDelete = out.Delete == "available"
	return out, nil
}

// The lease is valid only while the claiming owner's exact live session, role
// revision, configured endpoint and unexpired claim all still match.
const serviceRemoteAuthorityQuery = `SELECT EXISTS(SELECT 1 FROM service_remote_access o
 JOIN session_access_tokens t ON t.token_hash=o.access_hash
 JOIN app_sessions s ON s.id=t.session_id AND s.user_uuid=o.actor_uuid
 JOIN user_accounts u ON u.uuid=o.actor_uuid AND u.kind IN ('owner','local') AND u.is_active=1 AND (u.access_expires_at IS NULL OR julianday(u.access_expires_at)>julianday('now'))
 JOIN admin_role_state r ON r.singleton=1 AND r.revision=o.role_revision
 JOIN account_link_state l ON l.singleton=1 AND l.revision=o.link_revision
 JOIN service_accounts a ON a.uuid=o.service_uuid AND a.external_user_id=o.external_user_id
 JOIN media_servers m ON m.id=a.server_id AND m.config_revision=o.config_revision AND m.is_active=1
 JOIN provider_settings p ON p.provider_id=m.service_type AND p.enabled=1
 WHERE o.service_uuid=? AND o.operation_token=? AND o.actor_uuid=? AND o.state='running'
 AND julianday(o.operation_expires_at)>julianday('now') AND t.expires_at>? AND s.refresh_expires_at>?)`

func serviceRemoteLease(ctx context.Context, tx *sql.Tx, actor, target, token string) error {
	var valid bool
	now := utcTimestamp(time.Now())
	if err := tx.QueryRowContext(ctx, serviceRemoteAuthorityQuery, target, token, actor, now, now).Scan(&valid); err != nil {
		return err
	}
	if !valid {
		return ErrForbidden
	}
	return nil
}

// serviceRemoteAuthority is checked by the provider transport before and after
// every remote request, like reviewRequestAuthority. Nil means not attached.
type serviceRemoteAuthority struct {
	Store  *Store
	Actor  string
	Target string
	Token  string
}

func (p *serviceRemoteAuthority) check(ctx context.Context) error {
	if p == nil {
		return nil
	}
	tx, err := p.Store.reader.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err = serviceRemoteLease(ctx, tx, p.Actor, p.Target, p.Token); err != nil {
		return err
	}
	return tx.Commit()
}

type serviceRemoteInput struct {
	Actor     string          `json:"expected_actor_uuid"`
	Target    string          `json:"expected_service_uuid"`
	Revision  string          `json:"operation_revision"`
	Link      string          `json:"link_revision"`
	Source    string          `json:"server_revision"`
	Active    *bool           `json:"expected_is_active"`
	Owner     json.RawMessage `json:"expected_owner_uuid"`
	Reason    string          `json:"reason"`
	AckWrite  bool            `json:"acknowledge_remote_write"`
	AckUncert bool            `json:"acknowledge_in_flight_risk"`
	// Delete only: the exact recorded username and an irreversibility acknowledgment.
	ConfirmName     string `json:"confirm_username"`
	AckIrreversible bool   `json:"acknowledge_irreversible"`
}

func (a *App) serviceRemoteAccess(w http.ResponseWriter, r *http.Request) {
	p, ok := a.principal(w, r, true)
	if !ok {
		return
	}
	if r.URL.RawQuery != "" {
		domainError(w, ErrConflict)
		return
	}
	tx, err := a.store.reader.BeginTx(r.Context(), &sql.TxOptions{ReadOnly: true})
	if err != nil {
		domainError(w, err)
		return
	}
	defer tx.Rollback()
	out, err := readServiceRemote(r.Context(), tx, p.UUID, bearer(r), r.PathValue("service"))
	if err == nil {
		err = tx.Commit()
	}
	if err != nil {
		domainError(w, err)
		return
	}
	respond(w, 200, out)
}

func (a *App) disableServiceRemoteAccess(w http.ResponseWriter, r *http.Request) {
	a.serviceRemoteOperation(w, r, "disable")
}

func (a *App) enableServiceRemoteAccess(w http.ResponseWriter, r *http.Request) {
	a.serviceRemoteOperation(w, r, "enable")
}

func (a *App) deleteServiceRemoteAccess(w http.ResponseWriter, r *http.Request) {
	a.serviceRemoteOperation(w, r, "delete")
}

func (a *App) serviceRemoteOperation(w http.ResponseWriter, r *http.Request, kind string) {
	p, ok := a.principal(w, r, true)
	if !ok {
		return
	}
	if r.URL.RawQuery != "" {
		domainError(w, ErrConflict)
		return
	}
	var input serviceRemoteInput
	if !decodeStrictBody(w, r, &input) {
		return
	}
	reason := strings.TrimSpace(input.Reason)
	var owner *string
	if !input.AckWrite || !input.AckUncert || input.Active == nil || len(input.Owner) == 0 || json.Unmarshal(input.Owner, &owner) != nil || len(reason) < 10 || len(reason) > 1000 {
		fail(w, 400, "REMOTE_ACCESS_CONFIRMATION_REQUIRED", "Provide the current selection, a reason of 10–1000 bytes and both remote-write acknowledgments")
		return
	}
	if (kind == "delete") != (input.AckIrreversible || input.ConfirmName != "") || kind == "delete" && (!input.AckIrreversible || input.ConfirmName == "") {
		fail(w, 400, "REMOTE_DELETE_CONFIRMATION_REQUIRED", "Remote delete requires the exact username and an irreversibility acknowledgment; other operations must omit them")
		return
	}
	ctx, done, ok := a.startReviewOperation(w, r)
	if !ok {
		return
	}
	defer done()
	target, access := r.PathValue("service"), bearer(r)
	token := newUUID()
	var claimed serviceRemoteRecord
	err := a.store.write(ctx, func(tx *sql.Tx) error {
		current, err := readServiceRemote(ctx, tx, p.UUID, access, target)
		if err != nil {
			return err
		}
		if input.Actor != p.UUID {
			return ErrForbidden
		}
		allowed := current.CanDisable
		switch kind {
		case "enable":
			allowed = current.CanEnable
		case "delete":
			allowed = current.CanDelete && input.ConfirmName == current.Username
		}
		if !allowed || input.Target != current.Target || input.Revision != current.Revision || input.Link != current.Link || input.Source != current.Source || *input.Active != current.Active || !sameHumanExpiry(owner, current.Owner) {
			return ErrConflict
		}
		result, err := tx.ExecContext(ctx, `UPDATE service_remote_access SET state='running',error_code=NULL,operation_token=?,operation_kind=?,actor_uuid=?,access_hash=?,role_revision=(SELECT revision FROM admin_role_state WHERE singleton=1),config_revision=?,link_revision=?,provider_fingerprint=?,external_user_id=?,operation_expires_at=?,revision=revision+1 WHERE service_uuid=? AND revision=? AND operation_token IS NULL`,
			token, kind, p.UUID, tokenHash(access), current.configRev, current.linkRev, current.fingerprint, current.externalID, utcTimestamp(time.Now().Add(time.Minute)), target, current.revision)
		if err != nil {
			return err
		}
		if count, _ := result.RowsAffected(); count != 1 {
			return ErrConflict
		}
		claimed = current
		return auditServiceRemote(ctx, tx, p.UUID, "service.remote_access.start", map[string]any{"target_uuid": target, "operation": kind, "reason": reason, "provider": current.Provider, "cleanup_scope": current.Scope})
	})
	if err != nil {
		domainError(w, err)
		return
	}
	// The lease always ends: an unrecorded outcome becomes 'unknown'.
	finished := false
	defer func() {
		if !finished {
			_ = a.releaseServiceRemote(target, token)
		}
	}()
	state, code, wrote := a.runServiceRemoteOperation(ctx, p.UUID, claimed, token, kind)
	var out serviceRemoteRecord
	err = a.store.write(ctx, func(tx *sql.Tx) error {
		if err := serviceRemoteLease(ctx, tx, p.UUID, target, token); err != nil {
			return err
		}
		server, err := scanServer(tx.QueryRowContext(ctx, serverSelect+" WHERE s.id=?", claimed.serverID))
		if err != nil {
			return err
		}
		if providerFingerprint(server) != claimed.fingerprint {
			return ErrConflict
		}
		if serviceRemoteVerified(state) {
			now := utcTimestamp(time.Now())
			if _, err := tx.ExecContext(ctx, "UPDATE service_accounts SET is_active=?,updated_at=? WHERE uuid=?", state == "enabled", now, target); err != nil {
				return err
			}
			// Invalidate syncs that read the remote list before this outcome.
			if _, err := tx.ExecContext(ctx, "UPDATE media_servers SET revision=revision+1 WHERE id=?", claimed.serverID); err != nil {
				return err
			}
			if _, err := tx.ExecContext(ctx, "UPDATE media_activity_state SET mapping_revision=mapping_revision+1 WHERE server_id=?", claimed.serverID); err != nil {
				return err
			}
		}
		if _, err := tx.ExecContext(ctx, `UPDATE service_remote_access SET state=?,error_code=nullif(?,''),checked_at=?,operation_token=NULL,operation_kind=NULL,actor_uuid=NULL,access_hash=NULL,role_revision=NULL,config_revision=NULL,link_revision=NULL,provider_fingerprint=NULL,external_user_id=NULL,operation_expires_at=NULL,revision=revision+1 WHERE service_uuid=? AND operation_token=?`, state, code, utcTimestamp(time.Now()), target, token); err != nil {
			return err
		}
		if err := auditServiceRemote(ctx, tx, p.UUID, "service.remote_access."+kind, map[string]any{"target_uuid": target, "outcome": state, "error_code": code, "reason": reason, "remote_write_dispatched": wrote, "provider": claimed.Provider, "cleanup_scope": claimed.Scope}); err != nil {
			return err
		}
		out, err = readServiceRemote(ctx, tx, p.UUID, access, target)
		return err
	})
	finished = true
	if err != nil {
		// A remote write may already have happened; never report a plain rejection.
		_ = a.releaseServiceRemote(target, token)
		fail(w, 503, "REMOTE_ACCESS_STATE_UNCERTAIN", "The remote access outcome was not recorded; read the account and inspect again before another change")
		return
	}
	if serviceRemoteVerified(state) && out.Owner != nil {
		a.hub.closeAccountConnections(*out.Owner)
	}
	respond(w, 200, out)
}

func serviceRemoteVerified(state string) bool {
	return state == "disabled" || state == "enabled" || state == "deleted" || state == "absent"
}

// Inspect first; write at most once and only when the account is observed in
// the opposite state; verify by re-inspection. Nothing here is retried.
func (a *App) runServiceRemoteOperation(ctx context.Context, actor string, claimed serviceRemoteRecord, token, kind string) (state, code string, wrote bool) {
	server, err := a.loadServer(ctx, claimed.serverID)
	if err != nil || providerFingerprint(server) != claimed.fingerprint {
		return "failed", "SERVER_CHANGED", false
	}
	provider, err := newServerConnection(ProviderConfig{server.Type, server.URL, server.apiKey}, a.ProviderHTTP)
	if err != nil {
		return "failed", "PROVIDER_UNAVAILABLE", false
	}
	client := provider
	client.serviceAuthority = &serviceRemoteAuthority{a.store, actor, claimed.Target, token}
	user, err := client.inspectProvisionedUser(ctx, claimed.externalID, claimed.Username)
	if err != nil {
		if errors.Is(err, ErrConflict) {
			return "failed", "REMOTE_ACCOUNT_UNSUPPORTED", false
		}
		return "failed", "REMOTE_INSPECTION_FAILED", false
	}
	if user.Absent {
		return "absent", "", false
	}
	if kind == "delete" {
		// Someone may have re-enabled the account remotely since MUM disabled it.
		if !user.Disabled {
			return "failed", "REMOTE_NOT_DISABLED", false
		}
		if err = client.deleteRecordedUser(ctx, user); err != nil {
			return "unknown", "REMOTE_OUTCOME_UNCERTAIN", true
		}
		verified, err := client.inspectProvisionedUser(ctx, claimed.externalID, claimed.Username)
		switch {
		case err != nil:
			return "unknown", "REMOTE_OUTCOME_UNCERTAIN", true
		case verified.Absent:
			return "deleted", "", true
		}
		return "failed", "REMOTE_DELETE_NOT_VERIFIED", true
	}
	if kind == "enable" {
		if !user.Disabled {
			return "enabled", "", false
		}
		err = client.enableRecordedUser(ctx, user)
	} else {
		if user.Disabled {
			return "disabled", "", false
		}
		err = client.disableProvisionedUser(ctx, user)
	}
	if err != nil {
		return "unknown", "REMOTE_OUTCOME_UNCERTAIN", true
	}
	verified, err := client.inspectProvisionedUser(ctx, claimed.externalID, claimed.Username)
	switch {
	case err != nil:
		return "unknown", "REMOTE_OUTCOME_UNCERTAIN", true
	case verified.Absent:
		return "absent", "", true
	case kind == "disable" && verified.Disabled:
		return "disabled", "", true
	case kind == "enable" && !verified.Disabled:
		return "enabled", "", true
	}
	if kind == "enable" {
		return "failed", "REMOTE_ENABLE_NOT_VERIFIED", true
	}
	return "failed", "REMOTE_DISABLE_NOT_VERIFIED", true
}

func (a *App) releaseServiceRemote(target, token string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	return a.store.write(ctx, func(tx *sql.Tx) error {
		result, err := tx.ExecContext(ctx, `UPDATE service_remote_access SET state='unknown',error_code='RECONCILIATION_REQUIRED',checked_at=?,operation_token=NULL,operation_kind=NULL,actor_uuid=NULL,access_hash=NULL,role_revision=NULL,config_revision=NULL,link_revision=NULL,provider_fingerprint=NULL,external_user_id=NULL,operation_expires_at=NULL,revision=revision+1 WHERE service_uuid=? AND operation_token=?`, utcTimestamp(time.Now()), target, token)
		if err != nil {
			return err
		}
		if count, _ := result.RowsAffected(); count == 1 {
			return auditServiceRemote(ctx, tx, "", "service.remote_access.interrupted", map[string]any{"target_uuid": target})
		}
		return nil
	})
}

func auditServiceRemote(ctx context.Context, tx *sql.Tx, actor, action string, details map[string]any) error {
	encoded, err := json.Marshal(details)
	if err != nil {
		return err
	}
	var actorValue any
	if actor != "" {
		actorValue = actor
	}
	_, err = tx.ExecContext(ctx, "INSERT INTO audit_events(actor_uuid,action,details,occurred_at) VALUES(?,?,?,?)", actorValue, action, string(encoded), utcTimestamp(time.Now()))
	return err
}

// serviceRemotePlan lists every service account the human primarily owns, read
// in one snapshot. It authorizes nothing: each account is still changed only
// through its own exact, freshly read operation.
type serviceRemotePlan struct {
	Actor    string                `json:"actor_uuid"`
	Target   string                `json:"user_uuid"`
	Link     string                `json:"link_revision"`
	Accounts []serviceRemoteRecord `json:"accounts"`
}

const serviceRemotePlanLimit = 200

func (a *App) profileRemoteAccess(w http.ResponseWriter, r *http.Request) {
	p, ok := a.principal(w, r, true)
	if !ok {
		return
	}
	if r.URL.RawQuery != "" {
		domainError(w, ErrConflict)
		return
	}
	target := r.PathValue("user")
	tx, err := a.store.reader.BeginTx(r.Context(), &sql.TxOptions{ReadOnly: true})
	if err != nil {
		domainError(w, err)
		return
	}
	defer tx.Rollback()
	out, err := readServiceRemotePlan(r.Context(), tx, p.UUID, bearer(r), target)
	if err == nil {
		err = tx.Commit()
	}
	if err != nil {
		domainError(w, err)
		return
	}
	respond(w, 200, out)
}

func readServiceRemotePlan(ctx context.Context, tx *sql.Tx, actor, access, target string) (serviceRemotePlan, error) {
	out := serviceRemotePlan{Actor: actor, Target: target, Accounts: []serviceRemoteRecord{}}
	if err := notificationAuthority(ctx, tx, actor, access); err != nil {
		return out, err
	}
	authority, err := readAdminRoleHierarchyActor(ctx, tx, actor)
	if err != nil {
		return out, err
	}
	if !validAdminMemberCursor(target) {
		return out, ErrNotFound
	}
	if !authority.Owner && target != actor {
		var kind string
		if err = tx.QueryRowContext(ctx, "SELECT kind FROM user_accounts WHERE uuid=?", target).Scan(&kind); err != nil {
			return out, err
		}
		// The protected owner's accounts are listed as protected, not hidden.
		if kind != "owner" {
			if err = checkAdminRoleHierarchyTarget(ctx, tx, authority, target); err != nil {
				return out, err
			}
		}
	}
	var link int64
	if err = tx.QueryRowContext(ctx, "SELECT (SELECT revision FROM account_link_state WHERE singleton=1) FROM user_accounts WHERE uuid=?", target).Scan(&link); err != nil {
		return out, err
	}
	out.Link = strconv.FormatInt(link, 10)
	rows, err := tx.QueryContext(ctx, "SELECT service_uuid FROM service_links WHERE user_uuid=? AND link_kind='owner' ORDER BY service_uuid LIMIT ?", target, serviceRemotePlanLimit+1)
	if err != nil {
		return out, err
	}
	var services []string
	for rows.Next() {
		var service string
		if err = rows.Scan(&service); err != nil {
			break
		}
		services = append(services, service)
	}
	if err == nil {
		err = rows.Err()
	}
	rows.Close()
	if err != nil {
		return out, err
	}
	// Fail rather than present a silently truncated revocation plan.
	if len(services) > serviceRemotePlanLimit {
		return out, ErrConflict
	}
	for _, service := range services {
		record, err := readServiceRemote(ctx, tx, actor, access, service)
		if err != nil {
			return out, err
		}
		out.Accounts = append(out.Accounts, record)
	}
	return out, nil
}
