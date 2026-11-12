package main

import (
	"context"
	"database/sql"
	"net/http"
)

type adminPermissionRecord struct {
	ID          string  `json:"id"`
	Name        string  `json:"name"`
	Description *string `json:"description"`
	Implemented bool    `json:"implemented"`
}

type adminRoleRecord struct {
	CanReorder       bool                    `json:"can_reorder"`
	ReorderMaximum   *int                    `json:"reorder_max_position"`
	CanUpdate        bool                    `json:"can_update"`
	CanDelete        bool                    `json:"can_delete"`
	MemberChanges    bool                    `json:"member_changes_available"`
	MemberAssignment bool                    `json:"member_assignment_available"`
	ID               string                  `json:"id"`
	Name             string                  `json:"name"`
	Description      *string                 `json:"description"`
	Position         int                     `json:"position"`
	Color            *string                 `json:"color"`
	Icon             *string                 `json:"icon"`
	BadgeStyle       string                  `json:"badge_style"`
	Auto             bool                    `json:"is_auto_managed"`
	Protected        bool                    `json:"is_protected"`
	Permissions      []adminPermissionRecord `json:"permissions"`
	UserCount        int                     `json:"user_count"`
}

type adminRoleMemberRecord struct {
	CanAssign bool    `json:"can_assign"`
	CanRemove bool    `json:"can_remove"`
	UUID      string  `json:"uuid"`
	Username  string  `json:"username"`
	Kind      string  `json:"user_type"`
	Email     *string `json:"email"`
	Active    bool    `json:"is_active"`
	Revision  int64   `json:"profile_revision"`
}

type adminRoleReadMeta struct {
	Revision  int64   `json:"snapshot_revision"`
	Actor     string  `json:"actor_uuid"`
	Mutations bool    `json:"mutations_available"`
	NextAfter *string `json:"next_after,omitempty"`
	Role      string  `json:"role_id,omitempty"`
	Total     *int    `json:"total,omitempty"`
}

func validAdminRoleID(value string) bool {
	if len(value) < 1 || len(value) > 128 {
		return false
	}
	for _, c := range value {
		if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '_' || c == '-') {
			return false
		}
	}
	return true
}

func validAdminMemberCursor(value string) bool {
	if len(value) != 36 {
		return false
	}
	for i, c := range value {
		if i == 8 || i == 13 || i == 18 || i == 23 {
			if c != '-' {
				return false
			}
			continue
		}
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f') {
			return false
		}
	}
	return true
}

// Authorization and all DTO reads use one coherent query-only snapshot. Role
// names, display settings and service ownership are never authorization inputs.
func (a *App) beginAdminRoleRead(ctx context.Context, actor, access string) (*sql.Tx, error) {
	tx, err := a.store.reader.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return nil, err
	}
	if err = accountPreferenceAuthority(ctx, tx, actor, access); err == nil {
		err = requirePermission(ctx, tx, actor, "administrator")
	}
	if err != nil {
		tx.Rollback()
		return nil, err
	}
	return tx, nil
}

func readAdminPermissions(ctx context.Context, tx *sql.Tx, role string) ([]adminPermissionRecord, error) {
	query := "SELECT p.id,p.name,p.description FROM admin_permissions p"
	args := []any{}
	if role != "" {
		query += " JOIN admin_role_permissions rp ON rp.permission_id=p.id WHERE rp.role_id=?"
		args = append(args, role)
	}
	query += " ORDER BY p.id LIMIT 257"
	rows, err := tx.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []adminPermissionRecord{}
	for rows.Next() {
		var p adminPermissionRecord
		if err := rows.Scan(&p.ID, &p.Name, &p.Description); err != nil {
			return nil, err
		}
		p.Implemented = p.Name == "administrator"
		result = append(result, p)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(result) > 256 {
		return nil, ErrConflict
	}
	return result, nil
}

func readAdminRoles(ctx context.Context, tx *sql.Tx, id string) ([]adminRoleRecord, error) {
	query := `SELECT r.id,r.name,r.description,r.position,r.color,r.icon,r.badge_style,r.is_auto_managed,(r.is_auto_managed=1 OR EXISTS(SELECT 1 FROM admin_privileges a JOIN user_accounts u ON u.uuid=a.user_uuid WHERE a.role_id=r.id AND u.kind='owner')),(SELECT count(*) FROM admin_privileges a WHERE a.role_id=r.id) FROM admin_roles r`
	args := []any{}
	if id != "" {
		query += " WHERE r.id=?"
		args = append(args, id)
	}
	query += " ORDER BY r.position,r.id LIMIT 1001"
	rows, err := tx.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	result := []adminRoleRecord{}
	for rows.Next() {
		var role adminRoleRecord
		if err := rows.Scan(&role.ID, &role.Name, &role.Description, &role.Position, &role.Color, &role.Icon, &role.BadgeStyle, &role.Auto, &role.Protected, &role.UserCount); err != nil {
			rows.Close()
			return nil, err
		}
		result = append(result, role)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, err
	}
	if len(result) > 1000 {
		return nil, ErrConflict
	}
	// Close the role cursor before further queries on this single transaction.
	for i := range result {
		result[i].Permissions, err = readAdminPermissions(ctx, tx, result[i].ID)
		if err != nil {
			return nil, err
		}
	}
	return result, nil
}

func projectAdminRoleCapabilities(ctx context.Context, tx *sql.Tx, roles []adminRoleRecord, hierarchy adminRoleHierarchyActor) error {
	blocked := map[string]bool{}
	if !hierarchy.Owner {
		rows, err := tx.QueryContext(ctx, `SELECT DISTINCT g.role_id FROM admin_privileges g JOIN user_accounts u ON u.uuid=g.user_uuid
		 WHERE u.uuid=? OR u.kind<>'local' OR coalesce((SELECT max(r.position) FROM admin_privileges other JOIN admin_roles r ON r.id=other.role_id WHERE other.user_uuid=u.uuid),-1)>=?`, hierarchy.UUID, hierarchy.Ceiling)
		if err != nil {
			return err
		}
		for rows.Next() {
			var id string
			if err = rows.Scan(&id); err != nil {
				break
			}
			blocked[id] = true
		}
		if err == nil {
			err = rows.Err()
		}
		rows.Close()
		if err != nil {
			return err
		}
	}
	for i := range roles {
		role := &roles[i]
		role.MemberChanges = !role.Protected && (hierarchy.Owner || role.Position < hierarchy.Ceiling)
		role.MemberAssignment = role.MemberChanges
		for _, permission := range role.Permissions {
			if !permission.Implemented {
				role.MemberAssignment = false
			}
		}
		role.CanUpdate = role.MemberAssignment && (hierarchy.Owner || !blocked[role.ID] && role.UserCount <= 10000)
		role.CanDelete = role.MemberChanges && role.UserCount == 0 && (hierarchy.Owner || role.MemberAssignment)
		role.CanReorder = !role.Protected && (hierarchy.Owner || role.CanUpdate)
		if role.CanReorder {
			maximum := 1000000
			if !hierarchy.Owner && hierarchy.Ceiling-1 < maximum {
				maximum = hierarchy.Ceiling - 1
			}
			role.ReorderMaximum = &maximum
		}
	}
	return nil
}

func roleReorderAvailable(roles []adminRoleRecord) bool {
	if len(roles) < 2 {
		return false
	}
	for _, role := range roles {
		if role.CanReorder {
			return true
		}
	}
	return false
}

type adminRoleCreationCapability struct {
	Available bool `json:"available"`
	Maximum   *int `json:"max_position"`
}

func roleCreationCapability(hierarchy adminRoleHierarchyActor, count int) adminRoleCreationCapability {
	capability := adminRoleCreationCapability{}
	if count >= 1000 || !hierarchy.Owner && hierarchy.Ceiling <= 0 {
		return capability
	}
	maximum := 1000000
	if !hierarchy.Owner && hierarchy.Ceiling-1 < maximum {
		maximum = hierarchy.Ceiling - 1
	}
	capability.Available = true
	capability.Maximum = &maximum
	return capability
}

func (a *App) adminRolesRead(w http.ResponseWriter, r *http.Request) {
	actor, ok := a.principal(w, r, true)
	if !ok {
		return
	}
	id := r.PathValue("role")
	if len(r.URL.Query()) != 0 || id != "" && !validAdminRoleID(id) {
		fail(w, 400, "INVALID_ROLE_QUERY", "Use the current role ID without query options")
		return
	}
	tx, err := a.beginAdminRoleRead(r.Context(), actor.UUID, bearer(r))
	if err != nil {
		domainError(w, err)
		return
	}
	defer tx.Rollback()
	roles, err := readAdminRoles(r.Context(), tx, id)
	var hierarchy adminRoleHierarchyActor
	if err == nil {
		hierarchy, err = readAdminRoleHierarchyActor(r.Context(), tx, actor.UUID)
		if err == nil {
			err = projectAdminRoleCapabilities(r.Context(), tx, roles, hierarchy)
		}
	}
	var revision int64
	if err == nil {
		err = tx.QueryRowContext(r.Context(), "SELECT revision FROM admin_role_state WHERE singleton=1").Scan(&revision)
	}
	if err == nil && id != "" && len(roles) == 0 {
		err = ErrNotFound
	}
	if err == nil {
		err = tx.Commit()
	}
	if err != nil {
		domainError(w, err)
		return
	}
	meta := adminRoleReadMeta{Actor: actor.UUID, Revision: revision}
	if id != "" {
		respond(w, 200, map[string]any{"role": roles[0], "actor_uuid": meta.Actor, "snapshot_revision": meta.Revision, "mutations_available": actor.Kind == "owner"})
		return
	}
	respond(w, 200, map[string]any{"roles": roles, "actor_uuid": meta.Actor, "snapshot_revision": meta.Revision, "mutations_available": hierarchy.Owner, "creation": roleCreationCapability(hierarchy, len(roles)), "reorder_available": roleReorderAvailable(roles)})
}

func (a *App) adminPermissionsRead(w http.ResponseWriter, r *http.Request) {
	actor, ok := a.principal(w, r, true)
	if !ok {
		return
	}
	if len(r.URL.Query()) != 0 {
		fail(w, 400, "INVALID_ROLE_QUERY", "Permission reads take no query options")
		return
	}
	tx, err := a.beginAdminRoleRead(r.Context(), actor.UUID, bearer(r))
	if err != nil {
		domainError(w, err)
		return
	}
	defer tx.Rollback()
	permissions, err := readAdminPermissions(r.Context(), tx, "")
	var revision int64
	if err == nil {
		err = tx.QueryRowContext(r.Context(), "SELECT revision FROM admin_role_state WHERE singleton=1").Scan(&revision)
	}
	if err == nil {
		err = tx.Commit()
	}
	if err != nil {
		domainError(w, err)
		return
	}
	respond(w, 200, map[string]any{"permissions": permissions, "actor_uuid": actor.UUID, "snapshot_revision": revision, "mutations_available": actor.Kind == "owner"})
}

func (a *App) adminRoleMembersRead(w http.ResponseWriter, r *http.Request) {
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
		fail(w, 400, "INVALID_ROLE_QUERY", "Use a current role ID and optional UUID after cursor")
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
	if err := projectAdminRoleCapabilities(r.Context(), tx, roles, hierarchy); err != nil {
		domainError(w, err)
		return
	}
	memberChanges := roles[0].MemberChanges
	var total int
	var revision int64
	if err = tx.QueryRowContext(r.Context(), "SELECT revision FROM admin_role_state WHERE singleton=1").Scan(&revision); err != nil {
		domainError(w, err)
		return
	}
	if err = tx.QueryRowContext(r.Context(), "SELECT count(*) FROM admin_privileges WHERE role_id=?", id).Scan(&total); err != nil {
		domainError(w, err)
		return
	}
	rows, err := tx.QueryContext(r.Context(), `SELECT u.uuid,coalesce(u.local_username,''),u.kind,u.email,u.is_active,u.profile_revision,(? AND u.kind='local' AND u.uuid<>? AND (? OR coalesce((SELECT max(r.position) FROM admin_privileges g JOIN admin_roles r ON r.id=g.role_id WHERE g.user_uuid=u.uuid),-1)<?)) FROM admin_privileges a JOIN user_accounts u ON u.uuid=a.user_uuid WHERE a.role_id=? AND u.uuid>? ORDER BY u.uuid LIMIT 101`, memberChanges, actor.UUID, hierarchy.Owner, hierarchy.Ceiling, id, after)
	if err != nil {
		domainError(w, err)
		return
	}
	members := []adminRoleMemberRecord{}
	for rows.Next() {
		var p adminRoleMemberRecord
		if err = rows.Scan(&p.UUID, &p.Username, &p.Kind, &p.Email, &p.Active, &p.Revision, &p.CanRemove); err != nil {
			break
		}
		members = append(members, p)
	}
	if err == nil {
		err = rows.Err()
	}
	rows.Close()
	meta := adminRoleReadMeta{Actor: actor.UUID, Revision: revision, Role: id, Total: &total}
	if len(members) > 100 {
		members = members[:100]
		last := members[99].UUID
		meta.NextAfter = &last
	}
	if err == nil {
		err = tx.Commit()
	}
	if err != nil {
		domainError(w, err)
		return
	}
	// Keep a null terminal cursor explicit, including for an empty role.
	respond(w, 200, map[string]any{"members": members, "actor_uuid": meta.Actor, "snapshot_revision": meta.Revision, "mutations_available": actor.Kind == "owner", "role_id": id, "member_changes_available": memberChanges, "total": total, "next_after": meta.NextAfter})
}
