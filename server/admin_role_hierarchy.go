package main

import (
	"context"
	"database/sql"
	"errors"
)

// A hierarchy value is transaction-local authority, never a client claim or a
// cached capability. Larger positions rank higher; ties do not grant authority.
type adminRoleHierarchyActor struct {
	UUID    string
	Owner   bool
	Ceiling int
}

func readAdminRoleHierarchyActor(ctx context.Context, tx *sql.Tx, actor string) (adminRoleHierarchyActor, error) {
	a := adminRoleHierarchyActor{UUID: actor, Ceiling: -1}
	p, err := loadPrincipal(ctx, tx, actor)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return a, ErrForbidden
		}
		return a, err
	}
	if p.Kind == "owner" {
		a.Owner = true
		return a, nil
	}
	if p.Kind != "local" || !p.Admin {
		return a, ErrForbidden
	}
	// A high cosmetic role must never amplify a lower actual permission grant.
	err = tx.QueryRowContext(ctx, `SELECT coalesce(max(r.position),-1)
	 FROM admin_privileges a JOIN admin_roles r ON r.id=a.role_id
	 JOIN admin_role_permissions rp ON rp.role_id=r.id
	 JOIN admin_permissions p ON p.id=rp.permission_id
	 WHERE a.user_uuid=? AND p.id='admin' AND p.name='administrator'`, actor).Scan(&a.Ceiling)
	if err == nil && a.Ceiling < 0 {
		err = ErrForbidden
	}
	return a, err
}

// This is a foundation for future delegated APIs. Public role mutations remain
// owner-only until scoped read projections and all operation guards are wired.
func readAdminRoleHierarchySession(ctx context.Context, tx *sql.Tx, actor, access string, expectedRevision int64) (adminRoleHierarchyActor, error) {
	if err := accountPreferenceAuthority(ctx, tx, actor, access); err != nil {
		return adminRoleHierarchyActor{}, err
	}
	a, err := readAdminRoleHierarchyActor(ctx, tx, actor)
	if err != nil {
		return a, err
	}
	var revision int64
	if err := tx.QueryRowContext(ctx, "SELECT revision FROM admin_role_state WHERE singleton=1").Scan(&revision); err != nil {
		return a, err
	}
	if expectedRevision < 1 || revision != expectedRevision {
		return a, ErrConflict
	}
	return a, nil
}

func checkAdminRoleHierarchyRole(ctx context.Context, tx *sql.Tx, a adminRoleHierarchyActor, role string, proposedPosition int) error {
	var position int
	var protected bool
	if err := tx.QueryRowContext(ctx, `SELECT r.position,(r.is_auto_managed=1 OR EXISTS(
	 SELECT 1 FROM admin_privileges g JOIN user_accounts u ON u.uuid=g.user_uuid
	 WHERE g.role_id=r.id AND u.kind='owner')) FROM admin_roles r WHERE r.id=?`, role).Scan(&position, &protected); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return ErrNotFound
		}
		return err
	}
	if protected || !a.Owner && (position >= a.Ceiling || proposedPosition >= a.Ceiling) {
		return ErrForbidden
	}
	return nil
}

func checkAdminRoleHierarchyTarget(ctx context.Context, tx *sql.Tx, a adminRoleHierarchyActor, target string) error {
	var kind string
	var position int
	if err := tx.QueryRowContext(ctx, `SELECT kind,coalesce((SELECT max(r.position)
	 FROM admin_privileges g JOIN admin_roles r ON r.id=g.role_id WHERE g.user_uuid=u.uuid),-1)
	 FROM user_accounts u WHERE u.uuid=?`, target).Scan(&kind, &position); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return ErrNotFound
		}
		return err
	}
	// All of a target's roles protect them, including cosmetic roles and roles
	// on an inactive account. Neither state permits a delegated peer demotion.
	if kind != "local" || target == a.UUID || !a.Owner && position >= a.Ceiling {
		return ErrForbidden
	}
	return nil
}

// Metadata/permission/position changes affect every assigned human account.
// Membership changes instead check only the explicit targets they alter.
func checkAdminRoleHierarchyMembers(ctx context.Context, tx *sql.Tx, a adminRoleHierarchyActor, role string) error {
	rows, err := tx.QueryContext(ctx, "SELECT user_uuid FROM admin_privileges WHERE role_id=? ORDER BY user_uuid LIMIT 10001", role)
	if err != nil {
		return err
	}
	users := []string{}
	for rows.Next() {
		var user string
		if err = rows.Scan(&user); err != nil {
			break
		}
		users = append(users, user)
	}
	if err == nil {
		err = rows.Err()
	}
	rows.Close()
	if err != nil {
		return err
	}
	if len(users) > 10000 {
		return ErrConflict
	}
	for _, user := range users {
		if err := checkAdminRoleHierarchyTarget(ctx, tx, a, user); err != nil {
			return err
		}
	}
	return nil
}
