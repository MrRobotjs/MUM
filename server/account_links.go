package main

import (
	"context"
	"database/sql"
	"errors"
	"net/http"
	"strconv"
	"time"
)

// Capabilities are snapshot hints. Every write recomputes them with the current
// session, hierarchy and link state inside the single writer transaction.
type accountLinkRecord struct {
	Actor           string `json:"actor_uuid"`
	Target          string `json:"user_uuid"`
	Service         string `json:"service_uuid"`
	RoleRevision    string `json:"role_revision"`
	LinkRevision    string `json:"link_revision"`
	ProfileRevision string `json:"profile_revision"`
	CanLink         bool   `json:"can_link"`
	CanUnlink       bool   `json:"can_unlink"`
}

func accountLinkTargetAuthority(ctx context.Context, tx *sql.Tx, actor, target string) error {
	authority, err := readAdminRoleHierarchyActor(ctx, tx, actor)
	if err != nil {
		return err
	}
	// The owner can maintain their own links. Delegated administrators cannot
	// change the owner's, their own or an equal/higher-ranked principal's links.
	if authority.Owner {
		var exists bool
		if err := tx.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM user_accounts WHERE uuid=?)", target).Scan(&exists); err != nil {
			return err
		}
		if !exists {
			return ErrNotFound
		}
		return nil
	}
	return checkAdminRoleHierarchyTarget(ctx, tx, authority, target)
}

func readAccountLink(ctx context.Context, tx *sql.Tx, actor, access, target, service string) (accountLinkRecord, error) {
	out := accountLinkRecord{Actor: actor, Target: target, Service: service}
	if !validAdminMemberCursor(target) || !validAdminMemberCursor(service) {
		return out, ErrNotFound
	}
	if err := accountPreferenceAuthority(ctx, tx, actor, access); err != nil {
		return out, err
	}
	if err := accountLinkTargetAuthority(ctx, tx, actor, target); err != nil {
		return out, err
	}
	var role, link, profile int64
	var active, serviceActive bool
	var expires, serviceExpires sql.NullString
	if err := tx.QueryRowContext(ctx, "SELECT profile_revision,is_active,access_expires_at FROM user_accounts WHERE uuid=?", target).Scan(&profile, &active, &expires); err != nil {
		return out, err
	}
	if err := tx.QueryRowContext(ctx, "SELECT is_active,access_expires_at FROM service_accounts WHERE uuid=?", service).Scan(&serviceActive, &serviceExpires); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			err = ErrNotFound
		}
		return out, err
	}
	var owner sql.NullString
	if err := tx.QueryRowContext(ctx, "SELECT user_uuid FROM service_links WHERE service_uuid=? AND link_kind='owner'", service).Scan(&owner); err != nil && !errors.Is(err, sql.ErrNoRows) {
		return out, err
	}
	var associated bool
	if err := tx.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM service_links WHERE user_uuid=? AND service_uuid=?)", target, service).Scan(&associated); err != nil {
		return out, err
	}
	if err := tx.QueryRowContext(ctx, "SELECT revision FROM admin_role_state WHERE singleton=1").Scan(&role); err != nil {
		return out, err
	}
	if err := tx.QueryRowContext(ctx, "SELECT revision FROM account_link_state WHERE singleton=1").Scan(&link); err != nil {
		return out, err
	}
	eligible := active && serviceActive
	if serviceExpires.Valid {
		deadline, err := time.Parse(time.RFC3339Nano, serviceExpires.String)
		eligible = eligible && err == nil && deadline.After(time.Now())
	}
	if expires.Valid {
		deadline, err := time.Parse(time.RFC3339Nano, expires.String)
		eligible = eligible && err == nil && deadline.After(time.Now())
	}
	out.RoleRevision = strconv.FormatInt(role, 10)
	out.LinkRevision = strconv.FormatInt(link, 10)
	out.ProfileRevision = strconv.FormatInt(profile, 10)
	// A delegate association is not silently promoted to primary ownership.
	out.CanLink = eligible && !owner.Valid && !associated
	out.CanUnlink = owner.Valid && owner.String == target
	return out, nil
}

func (a *App) accountLinkCapabilities(w http.ResponseWriter, r *http.Request) {
	actor, ok := a.principal(w, r, true)
	if !ok {
		return
	}
	tx, err := a.store.reader.BeginTx(r.Context(), &sql.TxOptions{ReadOnly: true})
	if err != nil {
		domainError(w, err)
		return
	}
	defer tx.Rollback()
	out, err := readAccountLink(r.Context(), tx, actor.UUID, bearer(r), r.PathValue("user"), r.PathValue("service"))
	if err == nil {
		err = tx.Commit()
	}
	if err != nil {
		domainError(w, err)
		return
	}
	respond(w, 200, out)
}

func (a *App) changeAccountLink(w http.ResponseWriter, r *http.Request) {
	actor, ok := a.principal(w, r, true)
	if !ok {
		return
	}
	var input struct {
		Actor   string `json:"expected_actor_uuid"`
		Target  string `json:"expected_user_uuid"`
		Service string `json:"expected_service_uuid"`
		Role    string `json:"role_revision"`
		Link    string `json:"link_revision"`
		Profile string `json:"profile_revision"`
	}
	if !decodeStrictBody(w, r, &input) {
		return
	}
	var out accountLinkRecord
	err := a.store.write(r.Context(), func(tx *sql.Tx) error {
		var server int64
		if err := tx.QueryRowContext(r.Context(), "SELECT server_id FROM service_accounts WHERE uuid=?", r.PathValue("service")).Scan(&server); err != nil {
			return err
		}
		if busy, err := editSourceBusy(r.Context(), tx, server, ""); err != nil {
			return err
		} else if busy {
			return ErrConflict
		}
		current, err := readAccountLink(r.Context(), tx, actor.UUID, bearer(r), r.PathValue("user"), r.PathValue("service"))
		if err != nil {
			return err
		}
		if input.Actor != actor.UUID {
			return ErrForbidden
		}
		if input.Target != current.Target || input.Service != current.Service {
			return ErrConflict
		}
		if input.Role != current.RoleRevision || input.Link != current.LinkRevision || input.Profile != current.ProfileRevision {
			return ErrConflict
		}
		action := "service.link"
		if r.Method == http.MethodPut {
			if !current.CanLink {
				return ErrConflict
			}
			_, err = tx.ExecContext(r.Context(), "INSERT INTO service_links(user_uuid,service_uuid,link_kind,created_by,created_at) VALUES(?,?,'owner',?,?)", current.Target, current.Service, actor.UUID, utcTimestamp(time.Now()))
		} else {
			if !current.CanUnlink {
				return ErrConflict
			}
			action = "service.unlink"
			_, err = tx.ExecContext(r.Context(), "DELETE FROM service_links WHERE user_uuid=? AND service_uuid=? AND link_kind='owner'", current.Target, current.Service)
		}
		if err != nil {
			return err
		}
		if err = auditAction(r.Context(), tx, actor.UUID, action); err != nil {
			return err
		}
		out, err = readAccountLink(r.Context(), tx, actor.UUID, bearer(r), current.Target, current.Service)
		return err
	})
	if err != nil {
		domainError(w, err)
		return
	}
	respond(w, 200, out)
}
