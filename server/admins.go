package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"time"
)

// The administrator management page composes existing rules: the same role
// hierarchy, implemented-permission and eligibility checks as role
// memberships, applied atomically. Password resets and account deletion are
// not offered here: resets require the owner re-authentication flow on the
// profile, and MUM retains human profiles for identity and history.

type adminRoleBadge struct {
	ID       string  `json:"id"`
	Name     string  `json:"name"`
	Position int     `json:"position"`
	Color    *string `json:"color"`
	Icon     *string `json:"icon"`
	Badge    string  `json:"badge_style"`
}

type adminListItem struct {
	ID          int64            `json:"id"`
	UUID        string           `json:"uuid"`
	Username    string           `json:"username"`
	DisplayName string           `json:"display_name"`
	UserType    string           `json:"user_type"`
	Email       *string          `json:"email"`
	LastLogin   *string          `json:"last_login_at"`
	Roles       []adminRoleBadge `json:"admin_roles"`
	Revision    int64            `json:"profile_revision"`
}

const adminListLimit = 1000

func readAdminList(ctx context.Context, tx *sql.Tx) ([]adminListItem, int64, error) {
	var snapshot int64
	if err := tx.QueryRowContext(ctx, "SELECT revision FROM admin_role_state WHERE singleton=1").Scan(&snapshot); err != nil {
		return nil, 0, err
	}
	rows, err := tx.QueryContext(ctx, `SELECT i.id,u.uuid,coalesce(u.local_username,''),u.kind,u.email,u.last_login_at,u.profile_revision FROM user_accounts u JOIN identities i ON i.uuid=u.uuid
 WHERE u.kind='owner' OR EXISTS(SELECT 1 FROM admin_privileges g WHERE g.user_uuid=u.uuid) ORDER BY u.kind='owner' DESC,u.local_username COLLATE NOCASE,i.id LIMIT ?`, adminListLimit+1)
	if err != nil {
		return nil, 0, err
	}
	items := []adminListItem{}
	for rows.Next() {
		var item adminListItem
		if err = rows.Scan(&item.ID, &item.UUID, &item.Username, &item.UserType, &item.Email, &item.LastLogin, &item.Revision); err != nil {
			break
		}
		item.DisplayName, item.Roles = item.Username, []adminRoleBadge{}
		items = append(items, item)
	}
	if err == nil {
		err = rows.Err()
	}
	rows.Close()
	if err == nil && len(items) > adminListLimit {
		err = ErrConflict
	}
	for i := range items {
		if err != nil {
			break
		}
		items[i].Roles, err = readAdminBadges(ctx, tx, items[i].UUID)
	}
	return items, snapshot, err
}

func readAdminBadges(ctx context.Context, tx *sql.Tx, user string) ([]adminRoleBadge, error) {
	rows, err := tx.QueryContext(ctx, "SELECT r.id,r.name,r.position,r.color,r.icon,r.badge_style FROM admin_privileges g JOIN admin_roles r ON r.id=g.role_id WHERE g.user_uuid=? ORDER BY r.position DESC,r.name", user)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []adminRoleBadge{}
	for rows.Next() {
		var b adminRoleBadge
		if err := rows.Scan(&b.ID, &b.Name, &b.Position, &b.Color, &b.Icon, &b.Badge); err != nil {
			return nil, err
		}
		out = append(out, b)
	}
	return out, rows.Err()
}

func (a *App) listAdmins(w http.ResponseWriter, r *http.Request) {
	p, ok := a.principal(w, r, true)
	if !ok {
		return
	}
	if r.URL.RawQuery != "" {
		domainError(w, ErrConflict)
		return
	}
	tx, err := a.beginAdminRoleRead(r.Context(), p.UUID, bearer(r))
	if err != nil {
		domainError(w, err)
		return
	}
	defer tx.Rollback()
	items, snapshot, err := readAdminList(r.Context(), tx)
	if err == nil {
		err = tx.Commit()
	}
	if err != nil {
		domainError(w, err)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"data": items, "meta": map[string]any{"snapshot_revision": snapshot, "actor_uuid": p.UUID}})
}

// checkAssignableRoles applies the membership rules to each requested role:
// hierarchy (not protected/auto-managed, below a delegate's ceiling) and only
// implemented permissions.
func checkAssignableRoles(ctx context.Context, tx *sql.Tx, hierarchy adminRoleHierarchyActor, roles []string) error {
	for _, role := range roles {
		if err := checkAdminRoleHierarchyRole(ctx, tx, hierarchy, role, -1); err != nil {
			return err
		}
		var unimplemented bool
		if err := tx.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM admin_role_permissions rp JOIN admin_permissions p ON p.id=rp.permission_id WHERE rp.role_id=? AND p.name<>'administrator')", role).Scan(&unimplemented); err != nil {
			return err
		}
		if unimplemented {
			return ErrConflict
		}
	}
	return nil
}

func uniqueRoleIDs(roles []string) ([]string, bool) {
	out := slices.Clone(roles)
	slices.Sort(out)
	out = slices.Compact(out)
	if len(out) != len(roles) || len(out) > 50 {
		return nil, false
	}
	for _, role := range out {
		if role == "" || len(role) > 128 {
			return nil, false
		}
	}
	return out, true
}

func auditAdmin(ctx context.Context, tx *sql.Tx, actor, action string, details map[string]any) error {
	encoded, err := json.Marshal(details)
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, "INSERT INTO audit_events(actor_uuid,action,details,occurred_at) VALUES(?,?,?,?)", actor, action, string(encoded), utcTimestamp(time.Now()))
	return err
}

// createAdmin creates a local account and assigns its roles in one transaction,
// so a refused role never leaves a half-created administrator.
func (a *App) createAdmin(w http.ResponseWriter, r *http.Request) {
	p, ok := a.principal(w, r, true)
	if !ok {
		return
	}
	var input struct {
		Username string   `json:"username"`
		Password string   `json:"password"`
		Roles    []string `json:"role_ids"`
		Revision int64    `json:"snapshot_revision"`
	}
	if !decodeStrictBody(w, r, &input) {
		return
	}
	username := strings.TrimSpace(input.Username)
	roles, unique := uniqueRoleIDs(input.Roles)
	if username == "" || len(username) > 255 || !unique || len(roles) == 0 || input.Revision < 1 {
		fail(w, 400, "INVALID_ADMIN", "Provide a username, one or more unique role IDs and the current role snapshot revision")
		return
	}
	if !a.passwordAdmission(w, r) {
		return
	}
	defer func() { <-a.passwordSlots }()
	hash, err := hashPassword(input.Password)
	if err != nil {
		fail(w, 400, "INVALID_PASSWORD", err.Error())
		return
	}
	uuid := newUUID()
	err = a.store.write(r.Context(), func(tx *sql.Tx) error {
		if err := accountPreferenceAuthority(r.Context(), tx, p.UUID, bearer(r)); err != nil {
			return err
		}
		if err := requirePermission(r.Context(), tx, p.UUID, "administrator"); err != nil {
			return err
		}
		hierarchy, err := readAdminRoleHierarchyActor(r.Context(), tx, p.UUID)
		if err != nil {
			return err
		}
		var snapshot int64
		var duplicate bool
		if err := tx.QueryRowContext(r.Context(), "SELECT revision,EXISTS(SELECT 1 FROM user_accounts WHERE local_username=?) FROM admin_role_state WHERE singleton=1", username).Scan(&snapshot, &duplicate); err != nil {
			return err
		}
		if snapshot != input.Revision || duplicate {
			return ErrConflict
		}
		if err := checkAssignableRoles(r.Context(), tx, hierarchy, roles); err != nil {
			return err
		}
		now := utcTimestamp(time.Now())
		if _, err := tx.ExecContext(r.Context(), "INSERT INTO identities(uuid,kind) VALUES(?,'local')", uuid); err != nil {
			return err
		}
		if _, err := tx.ExecContext(r.Context(), "INSERT INTO user_accounts(uuid,kind,local_username,password_hash,created_at,updated_at) VALUES(?,'local',?,?,?,?)", uuid, username, hash, now, now); err != nil {
			return err
		}
		for _, role := range roles {
			if _, err := tx.ExecContext(r.Context(), "INSERT INTO admin_privileges(user_uuid,role_id) VALUES(?,?)", uuid, role); err != nil {
				return err
			}
		}
		return auditAdmin(r.Context(), tx, p.UUID, "admin.create", map[string]any{"target_uuid": uuid, "role_ids": roles})
	})
	if err != nil {
		domainError(w, err)
		return
	}
	respond(w, 201, map[string]any{"uuid": uuid, "username": username, "role_ids": roles})
}

// updateAdminRoles replaces one administrator's role set exactly, guarded by
// the role snapshot and profile revisions. The owner and the actor are refused.
func (a *App) updateAdminRoles(w http.ResponseWriter, r *http.Request) {
	p, ok := a.principal(w, r, true)
	if !ok {
		return
	}
	id, err := strconv.ParseInt(r.PathValue("admin"), 10, 64)
	if err != nil || id < 1 {
		domainError(w, ErrNotFound)
		return
	}
	var input struct {
		Roles    []string `json:"role_ids"`
		Revision int64    `json:"snapshot_revision"`
		Profile  int64    `json:"profile_revision"`
	}
	if !decodeStrictBody(w, r, &input) {
		return
	}
	roles, unique := uniqueRoleIDs(input.Roles)
	if !unique || len(roles) == 0 || input.Revision < 1 || input.Profile < 1 {
		fail(w, 400, "INVALID_ADMIN", "Provide one or more unique role IDs with the current snapshot and profile revisions; remove all roles from the role pages")
		return
	}
	changed := ""
	err = a.store.write(r.Context(), func(tx *sql.Tx) error {
		if err := accountPreferenceAuthority(r.Context(), tx, p.UUID, bearer(r)); err != nil {
			return err
		}
		if err := requirePermission(r.Context(), tx, p.UUID, "administrator"); err != nil {
			return err
		}
		hierarchy, err := readAdminRoleHierarchyActor(r.Context(), tx, p.UUID)
		if err != nil {
			return err
		}
		var target, kind string
		var profile, snapshot int64
		var eligible bool
		err = tx.QueryRowContext(r.Context(), `SELECT u.uuid,u.kind,u.profile_revision,(SELECT revision FROM admin_role_state WHERE singleton=1),(u.is_active=1 AND (u.access_expires_at IS NULL OR coalesce(julianday(u.access_expires_at)>julianday('now'),0)) AND u.password_hash IS NOT NULL AND u.password_hash<>'' AND u.local_username IS NOT NULL AND u.local_username<>'') FROM identities i JOIN user_accounts u ON u.uuid=i.uuid WHERE i.id=?`, id).Scan(&target, &kind, &profile, &snapshot, &eligible)
		if errors.Is(err, sql.ErrNoRows) {
			return ErrNotFound
		}
		if err != nil {
			return err
		}
		if kind != "local" || target == p.UUID {
			return ErrForbidden
		}
		if err := checkAdminRoleHierarchyTarget(r.Context(), tx, hierarchy, target); err != nil {
			return err
		}
		if snapshot != input.Revision || profile != input.Profile {
			return ErrConflict
		}
		current, err := readAdminBadges(r.Context(), tx, target)
		if err != nil {
			return err
		}
		have := []string{}
		for _, b := range current {
			have = append(have, b.ID)
		}
		added, removed := []string{}, []string{}
		for _, role := range roles {
			if !slices.Contains(have, role) {
				added = append(added, role)
			}
		}
		for _, role := range have {
			if !slices.Contains(roles, role) {
				removed = append(removed, role)
			}
		}
		if len(added) == 0 && len(removed) == 0 {
			return ErrConflict
		}
		if len(added) > 0 && !eligible {
			return ErrForbidden
		}
		// Every changed role, added or removed, must be one the actor may manage.
		if err := checkAssignableRoles(r.Context(), tx, hierarchy, added); err != nil {
			return err
		}
		for _, role := range removed {
			if err := checkAdminRoleHierarchyRole(r.Context(), tx, hierarchy, role, -1); err != nil {
				return err
			}
			if _, err := tx.ExecContext(r.Context(), "DELETE FROM admin_privileges WHERE user_uuid=? AND role_id=?", target, role); err != nil {
				return err
			}
		}
		for _, role := range added {
			if _, err := tx.ExecContext(r.Context(), "INSERT INTO admin_privileges(user_uuid,role_id) VALUES(?,?)", target, role); err != nil {
				return err
			}
		}
		changed = target
		return auditAdmin(r.Context(), tx, p.UUID, "admin.roles.update", map[string]any{"target_uuid": target, "added": added, "removed": removed})
	})
	if err != nil {
		domainError(w, err)
		return
	}
	// Like role memberships, live sockets re-authorize with the new grants.
	a.hub.closeAccountConnections(changed)
	respond(w, 200, map[string]any{"id": id, "role_ids": roles})
}

func (a *App) unsupportedAdminAction(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.principal(w, r, true); !ok {
		return
	}
	fail(w, 409, "ADMIN_RESET_UNAVAILABLE", "Reset this password from the profile's Local Credentials card, which confirms your owner password.")
}

// deleteAdmin deletes an administrator account: it loses its admin roles and
// is then retired like any deleted local account (sign-in ends, it is unlinked
// and its username freed, while the row stays for history). The same rules as
// role changes apply: never the owner or yourself, and only administrators
// and roles the actor ranks above.
func (a *App) deleteAdmin(w http.ResponseWriter, r *http.Request) {
	p, ok := a.principal(w, r, true)
	if !ok {
		return
	}
	id, err := strconv.ParseInt(r.PathValue("admin"), 10, 64)
	if err != nil || id < 1 {
		domainError(w, ErrNotFound)
		return
	}
	skipped := ""
	err = a.store.write(r.Context(), func(tx *sql.Tx) error {
		skipped = ""
		if err := accountPreferenceAuthority(r.Context(), tx, p.UUID, bearer(r)); err != nil {
			return err
		}
		if err := requirePermission(r.Context(), tx, p.UUID, "administrator"); err != nil {
			return err
		}
		hierarchy, err := readAdminRoleHierarchyActor(r.Context(), tx, p.UUID)
		if err != nil {
			return err
		}
		var target, kind string
		var retired bool
		err = tx.QueryRowContext(r.Context(), `SELECT u.uuid,u.kind,u.deleted_at IS NOT NULL FROM identities i JOIN user_accounts u ON u.uuid=i.uuid WHERE i.id=?`, id).Scan(&target, &kind, &retired)
		if errors.Is(err, sql.ErrNoRows) || err == nil && retired {
			return ErrNotFound
		}
		if err != nil {
			return err
		}
		if kind != "local" || target == p.UUID {
			return ErrForbidden
		}
		if err := checkAdminRoleHierarchyTarget(r.Context(), tx, hierarchy, target); err != nil {
			return err
		}
		current, err := readAdminBadges(r.Context(), tx, target)
		if err != nil {
			return err
		}
		for _, role := range current {
			if err := checkAdminRoleHierarchyRole(r.Context(), tx, hierarchy, role.ID, -1); err != nil {
				return err
			}
		}
		if _, err := tx.ExecContext(r.Context(), "DELETE FROM admin_privileges WHERE user_uuid=?", target); err != nil {
			return err
		}
		result, err := editDeleteOne(r, tx, p.UUID, target, utcTimestamp(time.Now()))
		if err != nil {
			return err
		}
		if result.Outcome != "deleted" {
			// Nothing is kept: the roles removed above roll back with it.
			skipped = result.Reason
			return ErrConflict
		}
		return auditAction(r.Context(), tx, p.UUID, "admin.delete")
	})
	switch {
	case skipped == "invite_in_progress":
		fail(w, 409, "ADMIN_DELETE_BUSY", "An invitation for this account is being processed. Try again in a few seconds.")
	case skipped == "plex_connection":
		fail(w, 409, "ADMIN_DELETE_PLEX_CONNECTED", "Disconnect this administrator's personal Plex account before deleting it.")
	case skipped != "":
		fail(w, 409, "ADMIN_DELETE_UNAVAILABLE", "This administrator cannot be deleted right now.")
	case err != nil:
		domainError(w, err)
	default:
		respond(w, 200, map[string]any{"deleted": true})
	}
}
