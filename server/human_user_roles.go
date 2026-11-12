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

type humanUserRole struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Automatic bool   `json:"is_auto_managed"`
	Assigned  bool   `json:"assigned"`
}

type humanUserRolesRecord struct {
	Actor           string          `json:"actor_uuid"`
	Target          string          `json:"user_uuid"`
	Kind            string          `json:"user_type"`
	Username        string          `json:"username"`
	CatalogRevision string          `json:"catalog_revision"`
	ProfileRevision string          `json:"profile_revision"`
	RoleRevision    string          `json:"role_revision"`
	CanEdit         bool            `json:"can_edit"`
	CanCreate       bool            `json:"can_create"`
	Reason          string          `json:"availability"`
	Roles           []humanUserRole `json:"roles"`
}

func readHumanUserRoles(ctx context.Context, tx *sql.Tx, actor, access, target string) (humanUserRolesRecord, error) {
	// Visual membership changes share hierarchy/session/work guards with account
	// changes, but inactive/expired/passwordless target labels remain editable.
	activation, err := readHumanActivation(ctx, tx, actor, access, target)
	if err != nil {
		return humanUserRolesRecord{}, err
	}
	out := humanUserRolesRecord{Actor: actor, Target: target, Kind: activation.Kind, Username: activation.Username, ProfileRevision: activation.ProfileRevision, RoleRevision: activation.RoleRevision, Reason: activation.Reason, Roles: []humanUserRole{}}
	if out.Reason == "expired" || out.Reason == "credentials_unavailable" {
		out.Reason = "available"
	}
	out.CanEdit = out.Reason == "available"
	var owner bool
	var revision int64
	if err = tx.QueryRowContext(ctx, "SELECT revision,(SELECT kind='owner' FROM user_accounts WHERE uuid=?) FROM user_role_state WHERE singleton=1", actor).Scan(&revision, &owner); err != nil {
		return out, err
	}
	out.CanCreate = owner && out.CanEdit
	out.CatalogRevision = strconv.FormatInt(revision, 10)
	rows, err := tx.QueryContext(ctx, `SELECT r.id,r.name,(r.is_auto_managed=1 OR EXISTS(SELECT 1 FROM download_role d WHERE d.role_id=r.id)),EXISTS(SELECT 1 FROM identity_user_roles m WHERE m.role_id=r.id AND m.user_uuid=?) FROM user_roles r ORDER BY r.id LIMIT 1001`, target)
	if err != nil {
		return out, err
	}
	defer rows.Close()
	for rows.Next() {
		var role humanUserRole
		if err = rows.Scan(&role.ID, &role.Name, &role.Automatic, &role.Assigned); err != nil {
			return out, err
		}
		out.Roles = append(out.Roles, role)
	}
	if err = rows.Err(); err != nil {
		return out, err
	}
	if len(out.Roles) > 1000 {
		return out, ErrConflict
	}
	return out, nil
}

func validUserRoleIDs(ids []string) bool {
	if ids == nil || len(ids) > 1000 {
		return false
	}
	seen := map[string]bool{}
	for _, id := range ids {
		if len(id) < 1 || len(id) > 128 || seen[id] {
			return false
		}
		seen[id] = true
		for _, c := range id {
			if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '-' || c == '_') {
				return false
			}
		}
	}
	return true
}

func (a *App) humanUserRoles(w http.ResponseWriter, r *http.Request) {
	actor, ok := a.principal(w, r, true)
	if !ok {
		return
	}
	if r.URL.RawQuery != "" {
		fail(w, 400, "INVALID_SELECTION", "Select one human profile")
		return
	}
	if r.Method == http.MethodGet {
		tx, err := a.store.reader.BeginTx(r.Context(), &sql.TxOptions{ReadOnly: true})
		if err != nil {
			domainError(w, err)
			return
		}
		defer tx.Rollback()
		out, err := readHumanUserRoles(r.Context(), tx, actor.UUID, bearer(r), r.PathValue("user"))
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
		Actor           string   `json:"expected_actor_uuid"`
		Target          string   `json:"expected_user_uuid"`
		CatalogRevision string   `json:"catalog_revision"`
		ProfileRevision string   `json:"profile_revision"`
		RoleRevision    string   `json:"role_revision"`
		IDs             []string `json:"manual_role_ids"`
		VisualOnly      bool     `json:"acknowledge_visual_only"`
	}
	if !decodeStrictBody(w, r, &input) {
		return
	}
	if !input.VisualOnly || !validUserRoleIDs(input.IDs) {
		fail(w, 400, "INVALID_ROLES", "Provide the complete distinct manual role selection and acknowledge visual-only changes")
		return
	}
	var out humanUserRolesRecord
	err := a.store.write(r.Context(), func(tx *sql.Tx) error {
		current, err := readHumanUserRoles(r.Context(), tx, actor.UUID, bearer(r), r.PathValue("user"))
		if err != nil {
			return err
		}
		if input.Actor != actor.UUID {
			return ErrForbidden
		}
		if input.Target != current.Target || input.CatalogRevision != current.CatalogRevision || input.ProfileRevision != current.ProfileRevision || input.RoleRevision != current.RoleRevision {
			return ErrConflict
		}
		if !current.CanEdit {
			if current.Reason == "protected_owner" || current.Reason == "protected_self" {
				return ErrForbidden
			}
			return ErrConflict
		}
		selected := map[string]bool{}
		for _, id := range input.IDs {
			selected[id] = true
		}
		before, automatic := []string{}, []string{}
		for _, role := range current.Roles {
			if role.Automatic {
				if selected[role.ID] {
					return ErrForbidden
				}
				if role.Assigned {
					automatic = append(automatic, role.ID)
				}
				continue
			}
			if role.Assigned {
				before = append(before, role.ID)
			}
			delete(selected, role.ID)
		}
		if len(selected) != 0 {
			return ErrConflict
		}
		after := slices.Clone(input.IDs)
		slices.Sort(after)
		if slices.Equal(before, after) {
			return ErrConflict
		}
		for _, role := range current.Roles {
			if role.Automatic {
				continue
			}
			wanted := slices.Contains(after, role.ID)
			if role.Assigned && !wanted {
				if _, err = tx.ExecContext(r.Context(), "DELETE FROM identity_user_roles WHERE user_uuid=? AND role_id=?", current.Target, role.ID); err != nil {
					return err
				}
			}
			if !role.Assigned && wanted {
				if _, err = tx.ExecContext(r.Context(), "INSERT INTO identity_user_roles(user_uuid,role_id) VALUES(?,?)", current.Target, role.ID); err != nil {
					return err
				}
			}
		}
		if _, err = tx.ExecContext(r.Context(), "UPDATE user_accounts SET profile_revision=profile_revision+1,updated_at=? WHERE uuid=?", utcTimestamp(time.Now()), current.Target); err != nil {
			return err
		}
		details, err := json.Marshal(struct {
			Target    string   `json:"target_uuid"`
			Before    []string `json:"before_manual_role_ids"`
			After     []string `json:"after_manual_role_ids"`
			Automatic []string `json:"retained_auto_role_ids"`
		}{current.Target, before, after, automatic})
		if err != nil {
			return err
		}
		if _, err = tx.ExecContext(r.Context(), "INSERT INTO audit_events(actor_uuid,action,details,occurred_at) VALUES(?,'account.user_roles.change',?,?)", actor.UUID, string(details), utcTimestamp(time.Now())); err != nil {
			return err
		}
		out, err = readHumanUserRoles(r.Context(), tx, actor.UUID, bearer(r), current.Target)
		return err
	})
	if err != nil {
		domainError(w, err)
		return
	}
	respond(w, 200, out)
}

// Catalog creation is deliberately owner-only. Visual labels grant neither
// administrator permission nor remote media capabilities.
func (a *App) createUserRole(w http.ResponseWriter, r *http.Request) {
	actor, ok := a.principal(w, r, true)
	if !ok {
		return
	}
	if r.URL.RawQuery != "" {
		fail(w, 400, "INVALID_SELECTION", "Use the current role catalog")
		return
	}
	var input struct {
		Actor           string `json:"expected_actor_uuid"`
		CatalogRevision string `json:"catalog_revision"`
		RoleRevision    string `json:"role_revision"`
		Name            string `json:"name"`
	}
	if !decodeStrictBody(w, r, &input) {
		return
	}
	if !validAdminRoleValues(adminRoleValues{Name: input.Name, Badge: "default", Permissions: []string{}}) {
		fail(w, 400, "INVALID_ROLE", "Provide a valid visual role name")
		return
	}
	var out struct {
		Actor           string `json:"actor_uuid"`
		CatalogRevision string `json:"catalog_revision"`
		RoleRevision    string `json:"role_revision"`
		ID              string `json:"role_id"`
		Name            string `json:"name"`
	}
	err := a.store.write(r.Context(), func(tx *sql.Tx) error {
		if input.Actor != actor.UUID {
			return ErrForbidden
		}
		if err := accountPreferenceAuthority(r.Context(), tx, actor.UUID, bearer(r)); err != nil {
			return err
		}
		hierarchy, err := readAdminRoleHierarchyActor(r.Context(), tx, actor.UUID)
		if err != nil {
			return err
		}
		if !hierarchy.Owner {
			return ErrForbidden
		}
		var catalog, roles int64
		var count int
		var duplicate bool
		if err = tx.QueryRowContext(r.Context(), `SELECT s.revision,a.revision,(SELECT count(*) FROM user_roles),EXISTS(SELECT 1 FROM user_roles WHERE lower(name)=lower(?)) FROM user_role_state s CROSS JOIN admin_role_state a WHERE s.singleton=1 AND a.singleton=1`, input.Name).Scan(&catalog, &roles, &count, &duplicate); err != nil {
			return err
		}
		if input.CatalogRevision != strconv.FormatInt(catalog, 10) || input.RoleRevision != strconv.FormatInt(roles, 10) || count >= 1000 || duplicate {
			return ErrConflict
		}
		id := newUUID()
		if _, err = tx.ExecContext(r.Context(), "INSERT INTO user_roles(id,name) VALUES(?,?)", id, input.Name); err != nil {
			return err
		}
		if _, err = tx.ExecContext(r.Context(), `INSERT INTO audit_events(actor_uuid,action,details,occurred_at) VALUES(?,'user_role.create',json_object('role_id',?,'name',?),?)`, actor.UUID, id, input.Name, utcTimestamp(time.Now())); err != nil {
			return err
		}
		if err = tx.QueryRowContext(r.Context(), "SELECT revision FROM user_role_state WHERE singleton=1").Scan(&catalog); err != nil {
			return err
		}
		out.Actor = actor.UUID
		out.ID = id
		out.Name = input.Name
		out.CatalogRevision = strconv.FormatInt(catalog, 10)
		out.RoleRevision = strconv.FormatInt(roles, 10)
		return nil
	})
	if err != nil {
		domainError(w, err)
		return
	}
	respond(w, 201, out)
}
