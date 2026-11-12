package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"net/http"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

type adminRoleValues struct {
	Name        string   `json:"name"`
	Description *string  `json:"description"`
	Position    int      `json:"position"`
	Color       *string  `json:"color"`
	Icon        *string  `json:"icon"`
	Badge       string   `json:"badge_style"`
	Permissions []string `json:"permission_ids"`
}
type adminRolePosition struct {
	ID       string `json:"id"`
	Position int    `json:"position"`
}
type adminRoleChange struct {
	Actor, Access, Operation, ID string
	Revision                     int64
	Values                       adminRoleValues
	Order                        []adminRolePosition
}
type adminRoleChangeResult struct {
	Actor     string `json:"actor_uuid"`
	Revision  int64  `json:"snapshot_revision"`
	Operation string `json:"operation"`
	Role      string `json:"role_id,omitempty"`
	affected  []string
}

type adminRoleChangeAudit struct {
	Role              string              `json:"role_id,omitempty"`
	BeforeRevision    int64               `json:"before_revision"`
	AfterRevision     int64               `json:"after_revision"`
	BeforePermissions []string            `json:"before_permission_ids,omitempty"`
	AfterPermissions  []string            `json:"after_permission_ids"`
	BeforePositions   []adminRolePosition `json:"before_positions,omitempty"`
	AfterPositions    []adminRolePosition `json:"after_positions,omitempty"`
}

func validAdminRoleValues(v adminRoleValues) bool {
	if v.Name != strings.TrimSpace(v.Name) || len(v.Name) < 1 || len(v.Name) > 100 || !utf8.ValidString(v.Name) || v.Position < 0 || v.Position > 1000000 || v.Permissions == nil || len(v.Permissions) > 1 {
		return false
	}
	for _, c := range v.Name {
		if unicode.IsControl(c) {
			return false
		}
	}
	if v.Description != nil && (len(*v.Description) > 4000 || !utf8.ValidString(*v.Description)) {
		return false
	}
	if v.Badge != "default" && v.Badge != "fill" && v.Badge != "outline" {
		return false
	}
	if v.Color != nil {
		if len(*v.Color) != 7 || (*v.Color)[0] != '#' {
			return false
		}
		for _, c := range (*v.Color)[1:] {
			if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f' || c >= 'A' && c <= 'F') {
				return false
			}
		}
	}
	if v.Icon != nil {
		if len(*v.Icon) > 128 {
			return false
		}
		for _, c := range *v.Icon {
			if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == ' ' || c == '-' || c == '_') {
				return false
			}
		}
	}
	return len(v.Permissions) == 0 || v.Permissions[0] == "admin"
}

func adminRoleChangeAuthority(ctx context.Context, tx *sql.Tx, p adminRoleChange) (adminRoleHierarchyActor, error) {
	hierarchy, err := readAdminRoleHierarchySession(ctx, tx, p.Actor, p.Access, p.Revision)
	if err != nil {
		return hierarchy, err
	}
	if !hierarchy.Owner && p.Operation != "update" && p.Operation != "delete" && p.Operation != "create" && p.Operation != "reorder" {
		return hierarchy, ErrForbidden
	}
	if !hierarchy.Owner && p.Operation == "create" && (hierarchy.Ceiling <= 0 || p.Values.Position >= hierarchy.Ceiling) {
		return hierarchy, ErrForbidden
	}
	return hierarchy, nil
}

func commitAdminRoleChange(ctx context.Context, tx *sql.Tx, p adminRoleChange) (adminRoleChangeResult, error) {
	result := adminRoleChangeResult{Actor: p.Actor, Operation: p.Operation, Role: p.ID}
	hierarchy, err := adminRoleChangeAuthority(ctx, tx, p)
	if err != nil {
		return result, err
	}
	roles, err := readAdminRoles(ctx, tx, "")
	if err != nil {
		return result, err
	}
	byID := make(map[string]adminRoleRecord, len(roles))
	for _, role := range roles {
		byID[role.ID] = role
	}
	if p.Operation == "reorder" {
		if len(p.Order) != len(roles) || len(p.Order) < 2 {
			return result, ErrConflict
		}
		seen := make(map[string]bool, len(roles))
		positions := make(map[int]bool, len(roles))
		changed := false
		for _, entry := range p.Order {
			role, ok := byID[entry.ID]
			if !ok || seen[entry.ID] || entry.Position < 0 || entry.Position > 1000000 || positions[entry.Position] {
				return result, ErrConflict
			}
			seen[entry.ID] = true
			positions[entry.Position] = true
			if role.Protected && role.Position != entry.Position {
				return result, ErrForbidden
			}
			if !hierarchy.Owner && role.Position != entry.Position {
				if err := checkAdminRoleHierarchyRole(ctx, tx, hierarchy, entry.ID, entry.Position); err != nil {
					return result, err
				}
				for _, permission := range role.Permissions {
					if !permission.Implemented {
						return result, ErrConflict
					}
				}
				if err := checkAdminRoleHierarchyMembers(ctx, tx, hierarchy, entry.ID); err != nil {
					return result, err
				}
			}
			changed = changed || role.Position != entry.Position
		}
		if !changed {
			return result, ErrConflict
		}
		for _, entry := range p.Order {
			if byID[entry.ID].Position != entry.Position {
				if _, err := tx.ExecContext(ctx, "UPDATE admin_roles SET position=? WHERE id=?", entry.Position, entry.ID); err != nil {
					return result, err
				}
			}
		}
	} else {
		if !validAdminRoleID(p.ID) {
			return result, ErrConflict
		}
		previous, exists := byID[p.ID]
		if p.Operation == "create" {
			if exists || len(roles) >= 1000 {
				return result, ErrConflict
			}
		} else {
			if !exists {
				return result, ErrNotFound
			}
			if previous.Protected {
				return result, ErrForbidden
			}
		}
		if !hierarchy.Owner && p.Operation != "create" {
			proposed := previous.Position
			if p.Operation == "update" {
				proposed = p.Values.Position
			}
			if err := checkAdminRoleHierarchyRole(ctx, tx, hierarchy, p.ID, proposed); err != nil {
				return result, err
			}
			for _, permission := range previous.Permissions {
				if !permission.Implemented {
					return result, ErrConflict
				}
			}
			if p.Operation == "update" {
				if err := checkAdminRoleHierarchyMembers(ctx, tx, hierarchy, p.ID); err != nil {
					return result, err
				}
			}
		}
		if p.Operation == "delete" {
			if previous.UserCount != 0 {
				return result, ErrConflict
			}
			if _, err := tx.ExecContext(ctx, "DELETE FROM admin_roles WHERE id=?", p.ID); err != nil {
				return result, err
			}
		} else if p.Operation == "create" || p.Operation == "update" {
			for _, permission := range previous.Permissions {
				if !permission.Implemented {
					return result, ErrConflict
				}
			}
			if !validAdminRoleValues(p.Values) {
				return result, ErrConflict
			}
			var duplicate bool
			if err := tx.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM admin_roles WHERE name=? AND id<>?)", p.Values.Name, p.ID).Scan(&duplicate); err != nil {
				return result, err
			}
			if duplicate {
				return result, ErrConflict
			}
			if len(p.Values.Permissions) > 0 {
				var supported bool
				if err := tx.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM admin_permissions WHERE id='admin' AND name='administrator')").Scan(&supported); err != nil {
					return result, err
				}
				if !supported {
					return result, ErrConflict
				}
			}
			oldIDs := []string{}
			for _, perm := range previous.Permissions {
				oldIDs = append(oldIDs, perm.ID)
			}
			oldJSON, _ := json.Marshal(oldIDs)
			newJSON, _ := json.Marshal(p.Values.Permissions)
			permissionChange := string(oldJSON) != string(newJSON)
			if p.Operation == "update" {
				before := adminRoleValues{previous.Name, previous.Description, previous.Position, previous.Color, previous.Icon, previous.BadgeStyle, oldIDs}
				oldBody, _ := json.Marshal(before)
				newBody, _ := json.Marshal(p.Values)
				if string(oldBody) == string(newBody) {
					return result, ErrConflict
				}
			}
			if permissionChange && exists {
				rows, err := tx.QueryContext(ctx, "SELECT user_uuid FROM admin_privileges WHERE role_id=? ORDER BY user_uuid LIMIT 10001", p.ID)
				if err != nil {
					return result, err
				}
				for rows.Next() {
					var user string
					if err = rows.Scan(&user); err != nil {
						break
					}
					result.affected = append(result.affected, user)
				}
				if err == nil {
					err = rows.Err()
				}
				rows.Close()
				if err != nil {
					return result, err
				}
				if len(result.affected) > 10000 {
					return result, ErrConflict
				}
			}
			v := p.Values
			if p.Operation == "create" {
				_, err = tx.ExecContext(ctx, "INSERT INTO admin_roles(id,name,description,position,color,icon,badge_style) VALUES(?,?,?,?,?,?,?)", p.ID, v.Name, v.Description, v.Position, v.Color, v.Icon, v.Badge)
			} else {
				_, err = tx.ExecContext(ctx, "UPDATE admin_roles SET name=?,description=?,position=?,color=?,icon=?,badge_style=? WHERE id=?", v.Name, v.Description, v.Position, v.Color, v.Icon, v.Badge, p.ID)
			}
			if err != nil {
				return result, err
			}
			if permissionChange || p.Operation == "create" {
				if _, err := tx.ExecContext(ctx, "DELETE FROM admin_role_permissions WHERE role_id=?", p.ID); err != nil {
					return result, err
				}
				for _, permission := range v.Permissions {
					if _, err := tx.ExecContext(ctx, "INSERT INTO admin_role_permissions VALUES(?,?)", p.ID, permission); err != nil {
						return result, err
					}
				}
			}
		} else {
			return result, ErrConflict
		}
	}
	err = tx.QueryRowContext(ctx, "SELECT revision FROM admin_role_state WHERE singleton=1").Scan(&result.Revision)
	if err != nil {
		return result, err
	}
	audit := adminRoleChangeAudit{Role: p.ID, BeforeRevision: p.Revision, AfterRevision: result.Revision, AfterPermissions: p.Values.Permissions}
	if previous, ok := byID[p.ID]; ok {
		for _, permission := range previous.Permissions {
			audit.BeforePermissions = append(audit.BeforePermissions, permission.ID)
		}
		audit.BeforePositions = []adminRolePosition{{p.ID, previous.Position}}
	}
	if p.Operation == "reorder" {
		audit.AfterPositions = p.Order
		for _, entry := range p.Order {
			audit.BeforePositions = append(audit.BeforePositions, adminRolePosition{entry.ID, byID[entry.ID].Position})
		}
	} else if p.Operation != "delete" {
		audit.AfterPositions = []adminRolePosition{{p.ID, p.Values.Position}}
	}
	details, err := json.Marshal(audit)
	if err != nil {
		return result, err
	}
	_, err = tx.ExecContext(ctx, "INSERT INTO audit_events(actor_uuid,action,details,occurred_at) VALUES(?,?,?,?)", p.Actor, "admin.role."+p.Operation, string(details), utcTimestamp(time.Now()))
	return result, err
}

func (a *App) changeAdminRole(w http.ResponseWriter, r *http.Request) {
	actor, ok := a.principal(w, r, true)
	if !ok {
		return
	}
	var input struct {
		Actor    string `json:"expected_actor_uuid"`
		Revision int64  `json:"snapshot_revision"`
		Role     *struct {
			Name        *string         `json:"name"`
			Description json.RawMessage `json:"description"`
			Position    *int            `json:"position"`
			Color       json.RawMessage `json:"color"`
			Icon        json.RawMessage `json:"icon"`
			Badge       *string         `json:"badge_style"`
			Permissions *[]string       `json:"permission_ids"`
		} `json:"role"`
		Order *[]struct {
			ID       string `json:"id"`
			Position *int   `json:"position"`
		} `json:"positions"`
		Delete bool `json:"acknowledge_delete"`
	}
	if !decodeStrictBody(w, r, &input) {
		return
	}
	if input.Actor != actor.UUID {
		domainError(w, ErrForbidden)
		return
	}
	p := adminRoleChange{Actor: actor.UUID, Access: bearer(r), Revision: input.Revision, ID: r.PathValue("role")}
	valid := input.Revision > 0 && len(r.URL.Query()) == 0
	switch {
	case r.URL.Path == "/api/admin-roles/reorder":
		p.Operation = "reorder"
		valid = valid && input.Order != nil && input.Role == nil && !input.Delete
		if input.Order != nil {
			for _, entry := range *input.Order {
				if entry.Position == nil || !validAdminRoleID(entry.ID) {
					valid = false
					break
				}
				p.Order = append(p.Order, adminRolePosition{entry.ID, *entry.Position})
			}
		}
		valid = valid && len(p.Order) <= 1000
	case r.Method == "DELETE":
		p.Operation = "delete"
		valid = valid && input.Delete && input.Role == nil && input.Order == nil
	default:
		p.Operation = "update"
		if r.Method == "POST" {
			p.Operation = "create"
			p.ID = newUUID()
		}
		v := input.Role
		valid = valid && v != nil && input.Order == nil && !input.Delete
		if v != nil && v.Name != nil && v.Position != nil && v.Badge != nil && v.Permissions != nil && len(v.Description) > 0 && len(v.Color) > 0 && len(v.Icon) > 0 {
			p.Values = adminRoleValues{Name: strings.TrimSpace(*v.Name), Position: *v.Position, Badge: *v.Badge, Permissions: *v.Permissions}
			valid = valid && json.Unmarshal(v.Description, &p.Values.Description) == nil && json.Unmarshal(v.Color, &p.Values.Color) == nil && json.Unmarshal(v.Icon, &p.Values.Icon) == nil && validAdminRoleValues(p.Values)
		} else {
			valid = false
		}
	}
	if !valid {
		fail(w, 400, "INVALID_ROLE_CHANGE", "Provide the current actor/revision and complete supported role values, full positions, or deletion consent")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	var result adminRoleChangeResult
	err := a.store.write(ctx, func(tx *sql.Tx) error { var err error; result, err = commitAdminRoleChange(ctx, tx, p); return err })
	if err != nil {
		domainError(w, err)
		return
	}
	for _, user := range result.affected {
		a.hub.closeAccountConnections(user)
	}
	status := 200
	if p.Operation == "create" {
		status = 201
	}
	respond(w, status, result)
}
