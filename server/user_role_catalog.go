package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"net/http"
	"slices"
	"strconv"
	"time"
)

type userRoleCatalogEntry struct {
	ID          string  `json:"id"`
	Name        string  `json:"name"`
	Description *string `json:"description"`
	Color       *string `json:"color"`
	Icon        *string `json:"icon"`
	Badge       string  `json:"badge_style"`
	Position    int     `json:"position"`
	Automatic   bool    `json:"is_auto_managed"`
	Count       int     `json:"user_count"`
	CanUpdate   bool    `json:"can_update"`
	CanDelete   bool    `json:"can_delete"`
}
type userRoleCatalogRecord struct {
	Actor           string                 `json:"actor_uuid"`
	CatalogRevision string                 `json:"catalog_revision"`
	RoleRevision    string                 `json:"role_revision"`
	LinkRevision    string                 `json:"link_revision"`
	CanCreate       bool                   `json:"can_create"`
	CanReorder      bool                   `json:"can_reorder"`
	Roles           []userRoleCatalogEntry `json:"roles"`
}
type userRoleCatalogValues struct {
	Name        string  `json:"name"`
	Description *string `json:"description"`
	Color       *string `json:"color"`
	Icon        *string `json:"icon"`
	Badge       string  `json:"badge_style"`
}
type userRoleCatalogPosition struct {
	ID       string `json:"id"`
	Position int    `json:"position"`
}

func validUserRoleCatalogValues(v userRoleCatalogValues) bool {
	return (v.Description == nil || validProfileNotes(*v.Description)) && validAdminRoleValues(adminRoleValues{Name: v.Name, Description: v.Description, Color: v.Color, Icon: v.Icon, Badge: v.Badge, Permissions: []string{}})
}

func readUserRoleCatalog(ctx context.Context, tx *sql.Tx, actor, access string) (userRoleCatalogRecord, error) {
	out := userRoleCatalogRecord{Actor: actor, Roles: []userRoleCatalogEntry{}}
	if err := accountPreferenceAuthority(ctx, tx, actor, access); err != nil {
		return out, err
	}
	hierarchy, err := readAdminRoleHierarchyActor(ctx, tx, actor)
	if err != nil {
		return out, err
	}
	var catalog, role, link int64
	var working bool
	err = tx.QueryRowContext(ctx, `SELECT u.revision,a.revision,l.revision,
 EXISTS(SELECT 1 FROM provisioning_jobs WHERE review_token IS NOT NULL)
 OR EXISTS(SELECT 1 FROM plex_share_checkpoints WHERE operation_token IS NOT NULL)
 OR EXISTS(SELECT 1 FROM plex_invitation_credentials WHERE refresh_token IS NOT NULL)
 FROM user_role_state u CROSS JOIN admin_role_state a CROSS JOIN account_link_state l WHERE u.singleton=1 AND a.singleton=1 AND l.singleton=1`).Scan(&catalog, &role, &link, &working)
	if err != nil {
		return out, err
	}
	out.CatalogRevision = strconv.FormatInt(catalog, 10)
	out.RoleRevision = strconv.FormatInt(role, 10)
	out.LinkRevision = strconv.FormatInt(link, 10)
	rows, err := tx.QueryContext(ctx, `SELECT r.id,r.name,r.description,r.color,r.icon,r.badge_style,r.position,(r.is_auto_managed=1 OR EXISTS(SELECT 1 FROM download_role d WHERE d.role_id=r.id)),
 (SELECT count(*) FROM identity_user_roles m WHERE m.role_id=r.id),
 EXISTS(SELECT 1 FROM identity_user_roles m JOIN identities i ON i.uuid=m.user_uuid
 LEFT JOIN service_links l ON l.service_uuid=i.uuid AND l.link_kind='owner'
 LEFT JOIN user_accounts u ON u.uuid=CASE WHEN i.kind='service' THEN l.user_uuid ELSE i.uuid END
 WHERE m.role_id=r.id AND (u.kind='owner' OR u.uuid=?
 OR EXISTS(SELECT 1 FROM provisioning_jobs j WHERE j.user_uuid=u.uuid AND (j.status!='completed' OR j.reservation_held=1 OR j.review_token IS NOT NULL))
 OR EXISTS(SELECT 1 FROM plex_authorizations p WHERE p.owner_uuid=u.uuid AND (p.status='creating' OR p.operation_token IS NOT NULL))))
 FROM user_roles r ORDER BY r.position DESC,r.id LIMIT 1001`, actor)
	if err != nil {
		return out, err
	}
	defer rows.Close()
	for rows.Next() {
		var r userRoleCatalogEntry
		var protected bool
		if err = rows.Scan(&r.ID, &r.Name, &r.Description, &r.Color, &r.Icon, &r.Badge, &r.Position, &r.Automatic, &r.Count, &protected); err != nil {
			return out, err
		}
		// Automatic roles (Downloads, Home User, Shares Back) can be renamed and
		// restyled like any other, as in the Flask version; only the sync
		// changes who has them, so they are never deleted. Editing one changes
		// only how its badge looks, so members such as the owner do not block it.
		if r.Automatic {
			r.CanUpdate = hierarchy.Owner && !working && r.Count <= 1000
		} else {
			r.CanUpdate = hierarchy.Owner && !protected && !working && r.Count <= 1000
			r.CanDelete = r.CanUpdate && r.Count == 0
		}
		out.Roles = append(out.Roles, r)
	}
	if err = rows.Err(); err != nil {
		return out, err
	}
	if len(out.Roles) > 1000 {
		return out, ErrConflict
	}
	out.CanCreate = hierarchy.Owner && len(out.Roles) < 1000
	var members int
	if err = tx.QueryRowContext(ctx, "SELECT count(DISTINCT user_uuid) FROM identity_user_roles").Scan(&members); err != nil {
		return out, err
	}
	out.CanReorder = hierarchy.Owner && len(out.Roles) >= 2 && !working && members <= 1000
	// Automatic roles (Downloads, Home User, Shares Back) cannot be edited, but
	// they can be moved: reordering changes only where they are listed.
	for _, r := range out.Roles {
		if !r.CanUpdate && !r.Automatic {
			out.CanReorder = false
		}
	}
	return out, nil
}

func (a *App) userRoleCatalog(w http.ResponseWriter, r *http.Request) {
	actor, ok := a.principal(w, r, true)
	if !ok {
		return
	}
	if r.URL.RawQuery != "" {
		fail(w, 400, "INVALID_SELECTION", "Read the complete visual role catalog")
		return
	}
	if r.Method == http.MethodGet {
		tx, err := a.store.reader.BeginTx(r.Context(), &sql.TxOptions{ReadOnly: true})
		if err != nil {
			domainError(w, err)
			return
		}
		defer tx.Rollback()
		out, err := readUserRoleCatalog(r.Context(), tx, actor.UUID, bearer(r))
		if err == nil {
			err = tx.Commit()
		}
		if err != nil {
			domainError(w, err)
			return
		}
		respond(w, 200, out)
		return
	}
	var input struct {
		Actor           string                    `json:"expected_actor_uuid"`
		CatalogRevision string                    `json:"catalog_revision"`
		RoleRevision    string                    `json:"role_revision"`
		LinkRevision    string                    `json:"link_revision"`
		Operation       string                    `json:"operation"`
		ID              string                    `json:"role_id"`
		Values          *userRoleCatalogValues    `json:"role"`
		Positions       []userRoleCatalogPosition `json:"positions"`
		Acknowledge     bool                      `json:"acknowledge_visual_only"`
		Delete          bool                      `json:"acknowledge_delete"`
	}
	if !decodeStrictBody(w, r, &input) {
		return
	}
	valid := input.Acknowledge
	switch input.Operation {
	case "create":
		valid = valid && input.ID == "" && input.Values != nil && validUserRoleCatalogValues(*input.Values) && input.Positions == nil && !input.Delete
	case "update":
		valid = valid && validAdminRoleID(input.ID) && input.Values != nil && validUserRoleCatalogValues(*input.Values) && input.Positions == nil && !input.Delete
	case "delete":
		valid = valid && validAdminRoleID(input.ID) && input.Values == nil && input.Positions == nil && input.Delete
	case "reorder":
		valid = valid && input.ID == "" && input.Values == nil && len(input.Positions) >= 2 && len(input.Positions) <= 1000 && !input.Delete
	default:
		valid = false
	}
	if !valid {
		fail(w, 400, "INVALID_ROLE_CHANGE", "Provide one complete current visual-role change")
		return
	}
	var out struct {
		Actor           string `json:"actor_uuid"`
		Operation       string `json:"operation"`
		ID              string `json:"role_id"`
		CatalogRevision string `json:"catalog_revision"`
		RoleRevision    string `json:"role_revision"`
		LinkRevision    string `json:"link_revision"`
	}
	err := a.store.write(r.Context(), func(tx *sql.Tx) error {
		current, err := readUserRoleCatalog(r.Context(), tx, actor.UUID, bearer(r))
		if err != nil {
			return err
		}
		if input.Actor != actor.UUID {
			return ErrForbidden
		}
		hierarchy, err := readAdminRoleHierarchyActor(r.Context(), tx, actor.UUID)
		if err != nil {
			return err
		}
		if !hierarchy.Owner {
			return ErrForbidden
		}
		if input.CatalogRevision != current.CatalogRevision || input.RoleRevision != current.RoleRevision || input.LinkRevision != current.LinkRevision {
			return ErrConflict
		}
		index := slices.IndexFunc(current.Roles, func(role userRoleCatalogEntry) bool { return role.ID == input.ID })
		if (input.Operation == "update" || input.Operation == "delete") && index < 0 {
			return ErrNotFound
		}
		if input.Operation == "create" && !current.CanCreate {
			return ErrConflict
		}
		if input.Operation == "update" && !current.Roles[index].CanUpdate || input.Operation == "delete" && !current.Roles[index].CanDelete || input.Operation == "reorder" && !current.CanReorder {
			return ErrForbidden
		}
		if input.Values != nil {
			var duplicate bool
			if err = tx.QueryRowContext(r.Context(), "SELECT EXISTS(SELECT 1 FROM user_roles WHERE lower(name)=lower(?) AND id!=?)", input.Values.Name, input.ID).Scan(&duplicate); err != nil {
				return err
			}
			if duplicate {
				return ErrConflict
			}
		}
		before := []userRoleCatalogEntry{}
		after := []userRoleCatalogEntry{}
		affected := []string{}
		if input.Operation == "update" || input.Operation == "delete" {
			before = append(before, current.Roles[index])
		}
		if input.Operation == "reorder" {
			before = slices.Clone(current.Roles)
		}
		if input.Operation == "update" || input.Operation == "delete" || input.Operation == "reorder" {
			query := "SELECT user_uuid FROM identity_user_roles WHERE role_id=? ORDER BY user_uuid LIMIT 1001"
			args := []any{input.ID}
			if input.Operation == "reorder" {
				query = "SELECT DISTINCT user_uuid FROM identity_user_roles ORDER BY user_uuid LIMIT 1001"
				args = nil
			}
			rows, err := tx.QueryContext(r.Context(), query, args...)
			if err != nil {
				return err
			}
			for rows.Next() {
				var id string
				if err = rows.Scan(&id); err != nil {
					break
				}
				affected = append(affected, id)
			}
			if err == nil {
				err = rows.Err()
			}
			rows.Close()
			if err != nil {
				return err
			}
			if len(affected) > 1000 {
				return ErrConflict
			}
		}
		switch input.Operation {
		case "create":
			input.ID = newUUID()
			v := input.Values
			if _, err = tx.ExecContext(r.Context(), "INSERT INTO user_roles(id,name,description,color,icon,badge_style) VALUES(?,?,?,?,?,?)", input.ID, v.Name, v.Description, v.Color, v.Icon, v.Badge); err != nil {
				return err
			}
		case "update":
			old := current.Roles[index]
			v := input.Values
			oldJSON, _ := json.Marshal(userRoleCatalogValues{old.Name, old.Description, old.Color, old.Icon, old.Badge})
			newJSON, _ := json.Marshal(v)
			if string(oldJSON) == string(newJSON) {
				return ErrConflict
			}
			if _, err = tx.ExecContext(r.Context(), "UPDATE user_roles SET name=?,description=?,color=?,icon=?,badge_style=? WHERE id=?", v.Name, v.Description, v.Color, v.Icon, v.Badge, input.ID); err != nil {
				return err
			}
		case "delete":
			if _, err = tx.ExecContext(r.Context(), "DELETE FROM user_roles WHERE id=?", input.ID); err != nil {
				return err
			}
		case "reorder":
			if len(input.Positions) != len(current.Roles) {
				return ErrConflict
			}
			ids := map[string]bool{}
			positions := map[int]bool{}
			changed := false
			for _, p := range input.Positions {
				if !validAdminRoleID(p.ID) || p.Position < 0 || p.Position > 1000000 || ids[p.ID] || positions[p.Position] {
					return ErrConflict
				}
				ids[p.ID] = true
				positions[p.Position] = true
				i := slices.IndexFunc(current.Roles, func(role userRoleCatalogEntry) bool { return role.ID == p.ID })
				if i < 0 {
					return ErrConflict
				}
				changed = changed || current.Roles[i].Position != p.Position
			}
			if !changed {
				return ErrConflict
			}
			for _, p := range input.Positions {
				if _, err = tx.ExecContext(r.Context(), "UPDATE user_roles SET position=? WHERE id=? AND position!=?", p.Position, p.ID, p.Position); err != nil {
					return err
				}
			}
		}
		fresh, err := readUserRoleCatalog(r.Context(), tx, actor.UUID, bearer(r))
		if err != nil {
			return err
		}
		if input.Operation == "reorder" {
			after = slices.Clone(fresh.Roles)
		} else {
			for _, r := range fresh.Roles {
				if r.ID == input.ID {
					after = append(after, r)
				}
			}
		}
		details, err := json.Marshal(struct {
			Operation string                 `json:"operation"`
			Role      string                 `json:"role_id"`
			Before    []userRoleCatalogEntry `json:"before"`
			After     []userRoleCatalogEntry `json:"after"`
			Affected  []string               `json:"affected_identity_ids"`
		}{input.Operation, input.ID, before, after, affected})
		if err != nil {
			return err
		}
		if _, err = tx.ExecContext(r.Context(), "INSERT INTO audit_events(actor_uuid,action,details,occurred_at) VALUES(?,'user_role.catalog.change',?,?)", actor.UUID, string(details), utcTimestamp(time.Now())); err != nil {
			return err
		}
		out.Actor = actor.UUID
		out.ID = input.ID
		out.Operation = input.Operation
		out.CatalogRevision = fresh.CatalogRevision
		out.RoleRevision = fresh.RoleRevision
		out.LinkRevision = fresh.LinkRevision
		return nil
	})
	if err != nil {
		domainError(w, err)
		return
	}
	respond(w, 200, out)
}
