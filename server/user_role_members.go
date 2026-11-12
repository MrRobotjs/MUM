package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"time"
)

type userRoleIdentity struct {
	UUID      string  `json:"uuid"`
	Kind      string  `json:"user_type"`
	Username  string  `json:"username"`
	Provider  string  `json:"service_type"`
	Server    string  `json:"server_nickname"`
	Owner     *string `json:"primary_owner_uuid"`
	Member    bool    `json:"is_member"`
	CanChange bool    `json:"can_change"`
	Reason    string  `json:"availability"`
}
type userRoleMembersRecord struct {
	Actor            string             `json:"actor_uuid"`
	Role             string             `json:"role_id"`
	Name             string             `json:"role_name"`
	Automatic        bool               `json:"is_auto_managed"`
	CatalogRevision  string             `json:"catalog_revision"`
	RoleRevision     string             `json:"role_revision"`
	LinkRevision     string             `json:"link_revision"`
	SelectorRevision string             `json:"selector_revision"`
	Complete         bool               `json:"complete"`
	Mutations        bool               `json:"mutations_available"`
	Items            []userRoleIdentity `json:"items"`
}

func readUserRoleMembers(ctx context.Context, tx *sql.Tx, actor, access, role string) (userRoleMembersRecord, error) {
	out := userRoleMembersRecord{Actor: actor, Role: role, Items: []userRoleIdentity{}}
	if !validAdminRoleID(role) {
		return out, ErrNotFound
	}
	if err := accountPreferenceAuthority(ctx, tx, actor, access); err != nil {
		return out, err
	}
	authority, err := readAdminRoleHierarchyActor(ctx, tx, actor)
	if err != nil {
		return out, err
	}
	if !authority.Owner {
		return out, ErrForbidden
	}
	if err = tx.QueryRowContext(ctx, "SELECT name,(is_auto_managed=1 OR EXISTS(SELECT 1 FROM download_role d WHERE d.role_id=user_roles.id)) FROM user_roles WHERE id=?", role).Scan(&out.Name, &out.Automatic); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			err = ErrNotFound
		}
		return out, err
	}
	var catalog, roles, links, selector int64
	var working bool
	err = tx.QueryRowContext(ctx, `SELECT c.revision,a.revision,l.revision,s.revision,
 EXISTS(SELECT 1 FROM provisioning_jobs WHERE review_token IS NOT NULL)
 OR EXISTS(SELECT 1 FROM plex_share_checkpoints WHERE operation_token IS NOT NULL)
 OR EXISTS(SELECT 1 FROM plex_invitation_credentials WHERE refresh_token IS NOT NULL)
 FROM user_role_state c CROSS JOIN admin_role_state a CROSS JOIN account_link_state l CROSS JOIN user_role_selector_state s
 WHERE c.singleton=1 AND a.singleton=1 AND l.singleton=1 AND s.singleton=1`).Scan(&catalog, &roles, &links, &selector, &working)
	if err != nil {
		return out, err
	}
	out.CatalogRevision = strconv.FormatInt(catalog, 10)
	out.RoleRevision = strconv.FormatInt(roles, 10)
	out.LinkRevision = strconv.FormatInt(links, 10)
	out.SelectorRevision = strconv.FormatInt(selector, 10)
	out.Mutations = !out.Automatic && !working
	rows, err := tx.QueryContext(ctx, `SELECT i.uuid,i.kind,coalesce(u.local_username,a.external_username,''),coalesce(s.service_type,''),coalesce(s.server_nickname,''),l.user_uuid,
 EXISTS(SELECT 1 FROM identity_user_roles m WHERE m.user_uuid=i.uuid AND m.role_id=?),coalesce(h.kind='owner',0),
 EXISTS(SELECT 1 FROM provisioning_jobs j WHERE j.user_uuid=h.uuid AND (j.status!='completed' OR j.reservation_held=1 OR j.review_token IS NOT NULL))
 OR EXISTS(SELECT 1 FROM plex_authorizations p WHERE p.owner_uuid=h.uuid AND (p.status='creating' OR p.operation_token IS NOT NULL))
 FROM identities i LEFT JOIN user_accounts u ON u.uuid=i.uuid LEFT JOIN service_accounts a ON a.uuid=i.uuid
 LEFT JOIN media_servers s ON s.id=a.server_id LEFT JOIN service_links l ON l.service_uuid=i.uuid AND l.link_kind='owner'
 LEFT JOIN user_accounts h ON h.uuid=CASE WHEN i.kind='service' THEN l.user_uuid ELSE i.uuid END
 WHERE u.uuid IS NOT NULL OR a.uuid IS NOT NULL ORDER BY i.uuid LIMIT 1001`, role)
	if err != nil {
		return out, err
	}
	defer rows.Close()
	for rows.Next() {
		var item userRoleIdentity
		var protected, pending bool
		if err = rows.Scan(&item.UUID, &item.Kind, &item.Username, &item.Provider, &item.Server, &item.Owner, &item.Member, &protected, &pending); err != nil {
			return out, err
		}
		switch {
		case out.Automatic:
			item.Reason = "automatic"
		case protected || item.UUID == actor:
			item.Reason = "protected_owner"
		case working || pending:
			item.Reason = "pending_work"
		default:
			item.Reason = "available"
			item.CanChange = true
		}
		out.Items = append(out.Items, item)
	}
	if err = rows.Err(); err != nil {
		return out, err
	}
	if len(out.Items) > 1000 {
		return out, ErrConflict
	}
	out.Complete = true
	return out, nil
}

func (a *App) userRoleMembers(w http.ResponseWriter, r *http.Request) {
	actor, ok := a.principal(w, r, true)
	if !ok {
		return
	}
	if r.URL.RawQuery != "" {
		fail(w, 400, "INVALID_SELECTION", "Read one complete role-member selector")
		return
	}
	if r.Method == http.MethodGet {
		tx, err := a.store.reader.BeginTx(r.Context(), &sql.TxOptions{ReadOnly: true})
		if err != nil {
			domainError(w, err)
			return
		}
		defer tx.Rollback()
		out, err := readUserRoleMembers(r.Context(), tx, actor.UUID, bearer(r), r.PathValue("role"))
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
		Actor            string `json:"expected_actor_uuid"`
		Role             string `json:"expected_role_id"`
		CatalogRevision  string `json:"catalog_revision"`
		RoleRevision     string `json:"role_revision"`
		LinkRevision     string `json:"link_revision"`
		SelectorRevision string `json:"selector_revision"`
		Operation        string `json:"operation"`
		Visual           bool   `json:"acknowledge_visual_only"`
		Targets          []struct {
			UUID     string `json:"user_uuid"`
			Expected *bool  `json:"expected_member"`
		} `json:"targets"`
	}
	if !decodeStrictBody(w, r, &input) {
		return
	}
	valid := input.Visual && (input.Operation == "add" || input.Operation == "remove") && len(input.Targets) > 0 && len(input.Targets) <= 100
	seen := map[string]bool{}
	for _, target := range input.Targets {
		if !validAdminMemberCursor(target.UUID) || target.Expected == nil || seen[target.UUID] {
			valid = false
		}
		seen[target.UUID] = true
	}
	if !valid {
		fail(w, 400, "INVALID_MEMBERSHIP", "Provide one distinct bounded member batch with expected states and acknowledge visual-only changes")
		return
	}
	var out userRoleMembersRecord
	err := a.store.write(r.Context(), func(tx *sql.Tx) error {
		current, err := readUserRoleMembers(r.Context(), tx, actor.UUID, bearer(r), r.PathValue("role"))
		if err != nil {
			return err
		}
		if input.Actor != actor.UUID {
			return ErrForbidden
		}
		if input.Role != current.Role || input.CatalogRevision != current.CatalogRevision || input.RoleRevision != current.RoleRevision || input.LinkRevision != current.LinkRevision || input.SelectorRevision != current.SelectorRevision {
			return ErrConflict
		}
		if !current.Mutations {
			return ErrForbidden
		}
		chosen := []userRoleIdentity{}
		want := input.Operation == "add"
		for _, target := range input.Targets {
			found := false
			for _, item := range current.Items {
				if item.UUID != target.UUID {
					continue
				}
				found = true
				if item.Member != *target.Expected || item.Member == want {
					return ErrConflict
				}
				if !item.CanChange {
					return ErrForbidden
				}
				chosen = append(chosen, item)
				break
			}
			if !found {
				return ErrNotFound
			}
		}
		for _, item := range chosen {
			if want {
				_, err = tx.ExecContext(r.Context(), "INSERT INTO identity_user_roles(user_uuid,role_id) VALUES(?,?)", item.UUID, current.Role)
			} else {
				_, err = tx.ExecContext(r.Context(), "DELETE FROM identity_user_roles WHERE user_uuid=? AND role_id=?", item.UUID, current.Role)
			}
			if err != nil {
				return err
			}
			if item.Kind == "local" {
				if _, err = tx.ExecContext(r.Context(), "UPDATE user_accounts SET profile_revision=profile_revision+1,updated_at=? WHERE uuid=?", utcTimestamp(time.Now()), item.UUID); err != nil {
					return err
				}
			}
		}
		details, err := json.Marshal(struct {
			Role      string             `json:"role_id"`
			Operation string             `json:"operation"`
			Before    []userRoleIdentity `json:"before"`
			Member    bool               `json:"after_member"`
		}{current.Role, input.Operation, chosen, want})
		if err != nil {
			return err
		}
		if _, err = tx.ExecContext(r.Context(), "INSERT INTO audit_events(actor_uuid,action,details,occurred_at) VALUES(?,'user_role.members.change',?,?)", actor.UUID, string(details), utcTimestamp(time.Now())); err != nil {
			return err
		}
		out, err = readUserRoleMembers(r.Context(), tx, actor.UUID, bearer(r), current.Role)
		return err
	})
	if err != nil {
		domainError(w, err)
		return
	}
	respond(w, 200, out)
}
