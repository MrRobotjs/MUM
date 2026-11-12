package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"net/http"
	"time"
)

type adminRoleTarget struct {
	User     string `json:"user_uuid"`
	Revision int64  `json:"profile_revision"`
}
type adminRoleMembershipChange struct {
	Actor, Access, Role, Operation string
	Revision                       int64
	Targets                        []adminRoleTarget
}
type adminRoleMembershipResult struct {
	Actor     string            `json:"actor_uuid"`
	Role      string            `json:"role_id"`
	Operation string            `json:"operation"`
	Revision  int64             `json:"snapshot_revision"`
	Targets   []adminRoleTarget `json:"targets"`
}
type adminRoleMembershipAudit struct {
	Role        string            `json:"role_id"`
	Before      int64             `json:"before_revision"`
	After       int64             `json:"after_revision"`
	Targets     []adminRoleTarget `json:"targets"`
	Permissions []string          `json:"permission_ids"`
}

func validAdminRoleTargets(targets []adminRoleTarget) bool {
	if len(targets) < 1 || len(targets) > 100 {
		return false
	}
	seen := make(map[string]bool, len(targets))
	for _, target := range targets {
		if !validAdminMemberCursor(target.User) || target.Revision < 1 || seen[target.User] {
			return false
		}
		seen[target.User] = true
	}
	return true
}

func commitAdminRoleMembership(ctx context.Context, tx *sql.Tx, p adminRoleMembershipChange) (adminRoleMembershipResult, error) {
	result := adminRoleMembershipResult{Actor: p.Actor, Role: p.Role, Operation: p.Operation, Targets: p.Targets}
	hierarchy, err := readAdminRoleHierarchySession(ctx, tx, p.Actor, p.Access, p.Revision)
	if err != nil {
		return result, err
	}
	if !validAdminRoleID(p.Role) || !validAdminRoleTargets(p.Targets) || (p.Operation != "assign" && p.Operation != "remove") {
		return result, ErrConflict
	}
	roles, err := readAdminRoles(ctx, tx, p.Role)
	if err != nil {
		return result, err
	}
	if len(roles) != 1 {
		return result, ErrNotFound
	}
	role := roles[0]
	if err := checkAdminRoleHierarchyRole(ctx, tx, hierarchy, p.Role, -1); err != nil {
		return result, err
	}
	permissions := []string{}
	for _, permission := range role.Permissions {
		permissions = append(permissions, permission.ID)
		if p.Operation == "assign" && !permission.Implemented {
			return result, ErrConflict
		}
	}
	if p.Operation == "assign" && role.UserCount+len(p.Targets) > 10000 {
		return result, ErrConflict
	}
	// Validate the whole selection before altering any grant. UUIDs, profile
	// revisions and this one role are explicit; other role assignments are kept.
	for _, target := range p.Targets {
		if err := checkAdminRoleHierarchyTarget(ctx, tx, hierarchy, target.User); err != nil {
			return result, err
		}
		var kind string
		var revision int64
		var eligible, member bool
		err := tx.QueryRowContext(ctx, `SELECT kind,profile_revision,(is_active=1 AND (access_expires_at IS NULL OR coalesce(julianday(access_expires_at)>julianday('now'),0)) AND password_hash IS NOT NULL AND password_hash<>'' AND local_username IS NOT NULL AND local_username<>''),EXISTS(SELECT 1 FROM admin_privileges WHERE role_id=? AND user_uuid=?) FROM user_accounts WHERE uuid=?`, p.Role, target.User, target.User).Scan(&kind, &revision, &eligible, &member)
		if err != nil {
			return result, err
		}
		if kind != "local" || target.User == p.Actor {
			return result, ErrForbidden
		}
		if revision != target.Revision {
			return result, ErrConflict
		}
		if p.Operation == "assign" {
			if !eligible {
				return result, ErrForbidden
			}
			if member {
				return result, ErrConflict
			}
		} else if !member {
			return result, ErrConflict
		}
	}
	for _, target := range p.Targets {
		var err error
		if p.Operation == "assign" {
			_, err = tx.ExecContext(ctx, "INSERT INTO admin_privileges(user_uuid,role_id) VALUES(?,?)", target.User, p.Role)
		} else {
			_, err = tx.ExecContext(ctx, "DELETE FROM admin_privileges WHERE user_uuid=? AND role_id=?", target.User, p.Role)
		}
		if err != nil {
			return result, err
		}
	}
	if err := tx.QueryRowContext(ctx, "SELECT revision FROM admin_role_state WHERE singleton=1").Scan(&result.Revision); err != nil {
		return result, err
	}
	details, err := json.Marshal(adminRoleMembershipAudit{p.Role, p.Revision, result.Revision, p.Targets, permissions})
	if err != nil {
		return result, err
	}
	_, err = tx.ExecContext(ctx, "INSERT INTO audit_events(actor_uuid,action,details,occurred_at) VALUES(?,?,?,?)", p.Actor, "admin.role.members."+p.Operation, string(details), utcTimestamp(time.Now()))
	return result, err
}

func (a *App) changeAdminRoleMembership(w http.ResponseWriter, r *http.Request) {
	actor, ok := a.principal(w, r, true)
	if !ok {
		return
	}
	var input struct {
		Actor       string            `json:"expected_actor_uuid"`
		Revision    int64             `json:"snapshot_revision"`
		Operation   string            `json:"operation"`
		Targets     []adminRoleTarget `json:"targets"`
		Acknowledge bool              `json:"acknowledge_permission_change"`
	}
	if !decodeStrictBody(w, r, &input) {
		return
	}
	if input.Actor != actor.UUID {
		domainError(w, ErrForbidden)
		return
	}
	if len(r.URL.Query()) != 0 || input.Revision < 1 || !input.Acknowledge || !validAdminRoleID(r.PathValue("role")) || !validAdminRoleTargets(input.Targets) || (input.Operation != "assign" && input.Operation != "remove") {
		fail(w, 400, "INVALID_ROLE_MEMBERSHIP", "Provide the current actor/catalog revision, exact target profile revisions and permission-change acknowledgment")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	p := adminRoleMembershipChange{Actor: actor.UUID, Access: bearer(r), Role: r.PathValue("role"), Operation: input.Operation, Revision: input.Revision, Targets: input.Targets}
	var result adminRoleMembershipResult
	err := a.store.write(ctx, func(tx *sql.Tx) error { var err error; result, err = commitAdminRoleMembership(ctx, tx, p); return err })
	if err != nil {
		domainError(w, err)
		return
	}
	for _, target := range result.Targets {
		a.hub.closeAccountConnections(target.User)
	}
	respond(w, 200, result)
}

func (a *App) adminRoleCandidatesRead(w http.ResponseWriter, r *http.Request) {
	actor, ok := a.principal(w, r, true)
	if !ok {
		return
	}
	id, after := r.PathValue("role"), r.URL.Query().Get("after")
	valid := validAdminRoleID(id)
	for key, values := range r.URL.Query() {
		if key != "after" || len(values) != 1 || !validAdminMemberCursor(values[0]) {
			valid = false
		}
	}
	if !valid {
		fail(w, 400, "INVALID_ROLE_QUERY", "Use the current role ID and optional UUID after cursor")
		return
	}
	tx, err := a.beginAdminRoleRead(r.Context(), actor.UUID, bearer(r))
	if err != nil {
		domainError(w, err)
		return
	}
	defer tx.Rollback()
	hierarchy, err := readAdminRoleHierarchyActor(r.Context(), tx, actor.UUID)
	if err != nil {
		domainError(w, err)
		return
	}
	roles, err := readAdminRoles(r.Context(), tx, id)
	if err != nil {
		domainError(w, err)
		return
	}
	if len(roles) != 1 {
		domainError(w, ErrNotFound)
		return
	}
	if err := checkAdminRoleHierarchyRole(r.Context(), tx, hierarchy, id, -1); err != nil {
		domainError(w, err)
		return
	}
	for _, permission := range roles[0].Permissions {
		if !permission.Implemented {
			domainError(w, ErrConflict)
			return
		}
	}
	var revision int64
	var total int
	if err := tx.QueryRowContext(r.Context(), "SELECT revision FROM admin_role_state WHERE singleton=1").Scan(&revision); err != nil {
		domainError(w, err)
		return
	}
	filter := ` FROM user_accounts u WHERE u.kind='local' AND u.is_active=1 AND (u.access_expires_at IS NULL OR julianday(u.access_expires_at)>julianday('now')) AND u.password_hash IS NOT NULL AND u.password_hash<>'' AND u.local_username IS NOT NULL AND u.local_username<>'' AND NOT EXISTS(SELECT 1 FROM admin_privileges p WHERE p.role_id=? AND p.user_uuid=u.uuid) AND u.uuid<>? AND (? OR coalesce((SELECT max(r.position) FROM admin_privileges g JOIN admin_roles r ON r.id=g.role_id WHERE g.user_uuid=u.uuid),-1)<?)`
	if err := tx.QueryRowContext(r.Context(), "SELECT count(*)"+filter, id, actor.UUID, hierarchy.Owner, hierarchy.Ceiling).Scan(&total); err != nil {
		domainError(w, err)
		return
	}
	rows, err := tx.QueryContext(r.Context(), "SELECT u.uuid,u.local_username,u.kind,u.email,u.is_active,u.profile_revision"+filter+" AND u.uuid>? ORDER BY u.uuid LIMIT 101", id, actor.UUID, hierarchy.Owner, hierarchy.Ceiling, after)
	if err != nil {
		domainError(w, err)
		return
	}
	candidates := []adminRoleMemberRecord{}
	for rows.Next() {
		var candidate adminRoleMemberRecord
		if err = rows.Scan(&candidate.UUID, &candidate.Username, &candidate.Kind, &candidate.Email, &candidate.Active, &candidate.Revision); err != nil {
			break
		}
		candidate.CanAssign = true
		candidates = append(candidates, candidate)
	}
	if err == nil {
		err = rows.Err()
	}
	rows.Close()
	var next *string
	if len(candidates) > 100 {
		candidates = candidates[:100]
		last := candidates[99].UUID
		next = &last
	}
	if err == nil {
		err = tx.Commit()
	}
	if err != nil {
		domainError(w, err)
		return
	}
	respond(w, 200, map[string]any{"actor_uuid": actor.UUID, "snapshot_revision": revision, "role_id": id, "member_changes_available": true, "mutations_available": hierarchy.Owner, "candidates": candidates, "total": total, "next_after": next})
}
