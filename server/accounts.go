package main

import (
	"app/server/providers/provider"
	"context"
	"crypto/rand"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"
)

var (
	ErrForbidden = errors.New("insufficient permission")
	// Shared with media service modules, so errors.Is matches either side.
	ErrConflict = provider.ErrConflict
	ErrNotFound = errors.New("resource not found")
)

func newUUID() string {
	var bytes [16]byte
	if _, err := rand.Read(bytes[:]); err != nil {
		panic(err)
	}
	bytes[6] = bytes[6]&0x0f | 0x40
	bytes[8] = bytes[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", bytes[:4], bytes[4:6], bytes[6:8], bytes[8:10], bytes[10:])
}

// CreateAccount stores an already encoded password hash. Password encoding and
// validation belong to the authentication boundary; hashes are never returned.
func (s *Store) CreateAccount(ctx context.Context, actor, username, passwordHash string, owner bool) (string, error) {
	username = strings.TrimSpace(username)
	if username == "" || passwordHash == "" {
		return "", errors.New("username and encoded password are required")
	}
	uuid := newUUID()
	kind := "local"
	if owner {
		kind = "owner"
	}
	err := s.write(ctx, func(tx *sql.Tx) error {
		if owner {
			var count int
			if err := tx.QueryRowContext(ctx, "SELECT count(*) FROM identities WHERE kind='owner'").Scan(&count); err != nil {
				return err
			}
			if count != 0 {
				return ErrConflict
			}
		} else if err := requirePermission(ctx, tx, actor, "administrator"); err != nil {
			return err
		}
		var duplicate bool
		if err := tx.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM user_accounts WHERE local_username=?)", username).Scan(&duplicate); err != nil {
			return err
		}
		if duplicate {
			return ErrConflict
		}
		if _, err := tx.ExecContext(ctx, "INSERT INTO identities(uuid,kind) VALUES(?,?)", uuid, kind); err != nil {
			return err
		}
		now := utcTimestamp(time.Now())
		_, err := tx.ExecContext(ctx, `INSERT INTO user_accounts(uuid,kind,local_username,password_hash,created_at,updated_at) VALUES(?,?,?,?,?,?)`, uuid, kind, username, passwordHash, now, now)
		if err != nil {
			return err
		}
		return auditAction(ctx, tx, actor, "account.create")
	})
	if err != nil {
		return "", err
	}
	return uuid, nil
}

// requirePermission always resolves current grants inside the same write
// transaction as a mutation. Role names and cosmetic roles grant no authority.
func requirePermission(ctx context.Context, tx *sql.Tx, user, permission string) error {
	var allowed bool
	err := tx.QueryRowContext(ctx, `SELECT EXISTS (
		SELECT 1 FROM user_accounts u WHERE u.uuid=? AND u.is_active=1
		AND (u.access_expires_at IS NULL OR julianday(u.access_expires_at)>julianday('now'))
		AND (u.kind='owner' OR EXISTS (
		 SELECT 1 FROM admin_privileges a JOIN admin_role_permissions rp ON a.role_id=rp.role_id
		 JOIN admin_permissions p ON p.id=rp.permission_id
		 WHERE a.user_uuid=u.uuid AND p.name IN (?, 'administrator'))))`, user, permission).Scan(&allowed)
	if err != nil {
		return err
	}
	if !allowed {
		return ErrForbidden
	}
	return nil
}

func auditAction(ctx context.Context, tx *sql.Tx, actor, action string) error {
	_, err := tx.ExecContext(ctx, "INSERT INTO audit_events(actor_uuid,action,details,occurred_at) VALUES(nullif(?,''),?,'{}',?)", actor, action, utcTimestamp(time.Now()))
	return err
}

// LinkServiceAccounts performs an authorized, atomic merge to an existing
// principal. Conflicts roll back the complete merge.
func (s *Store) LinkServiceAccounts(ctx context.Context, actor, target string, services []string) error {
	if len(services) == 0 {
		return errors.New("at least one service account is required")
	}
	return s.write(ctx, func(tx *sql.Tx) error {
		if err := accountLinkTargetAuthority(ctx, tx, actor, target); err != nil {
			return err
		}
		var exists bool
		if err := tx.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM user_accounts WHERE uuid=?)", target).Scan(&exists); err != nil {
			return err
		}
		if !exists {
			return ErrNotFound
		}
		for _, service := range services {
			if err := tx.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM service_accounts WHERE uuid=?)", service).Scan(&exists); err != nil {
				return err
			}
			if !exists {
				return ErrNotFound
			}
			if err := tx.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM service_links WHERE service_uuid=? AND link_kind='owner')", service).Scan(&exists); err != nil {
				return err
			}
			if exists {
				return ErrConflict
			}
			if _, err := tx.ExecContext(ctx, `INSERT INTO service_links(user_uuid,service_uuid,link_kind,created_by,created_at) VALUES(?,?,'owner',?,?)`, target, service, actor, utcTimestamp(time.Now())); err != nil {
				return err
			}
		}
		return auditAction(ctx, tx, actor, "service.link")
	})
}

func (s *Store) UnlinkServiceAccount(ctx context.Context, actor, target, service string) error {
	return s.write(ctx, func(tx *sql.Tx) error {
		if err := accountLinkTargetAuthority(ctx, tx, actor, target); err != nil {
			return err
		}
		result, err := tx.ExecContext(ctx, "DELETE FROM service_links WHERE user_uuid=? AND service_uuid=? AND link_kind='owner'", target, service)
		if err != nil {
			return err
		}
		n, err := result.RowsAffected()
		if err != nil {
			return err
		}
		if n != 1 {
			return ErrNotFound
		}
		return auditAction(ctx, tx, actor, "service.unlink")
	})
}

// CreateAndLinkAccount implements the new-profile merge mode in one transaction.
// A missing/already-owned service rolls back both the new principal and links.
func (s *Store) CreateAndLinkAccount(ctx context.Context, actor, username, passwordHash string, services []string) (string, error) {
	username = strings.TrimSpace(username)
	if username == "" || passwordHash == "" || len(services) == 0 {
		return "", errors.New("username, encoded password and services are required")
	}
	uuid := newUUID()
	err := s.write(ctx, func(tx *sql.Tx) error {
		if err := requirePermission(ctx, tx, actor, "administrator"); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, "INSERT INTO identities(uuid,kind) VALUES(?,'local')", uuid); err != nil {
			return err
		}
		now := utcTimestamp(time.Now())
		if _, err := tx.ExecContext(ctx, `INSERT INTO user_accounts(uuid,kind,local_username,password_hash,created_at,updated_at) VALUES(?,'local',?,?,?,?)`, uuid, username, passwordHash, now, now); err != nil {
			return err
		}
		for _, service := range services {
			var exists bool
			if err := tx.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM service_accounts WHERE uuid=?)", service).Scan(&exists); err != nil {
				return err
			}
			if !exists {
				return ErrNotFound
			}
			if err := tx.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM service_links WHERE service_uuid=? AND link_kind='owner')", service).Scan(&exists); err != nil {
				return err
			}
			if exists {
				return ErrConflict
			}
			if _, err := tx.ExecContext(ctx, `INSERT INTO service_links(user_uuid,service_uuid,link_kind,created_by,created_at) VALUES(?,?,'owner',?,?)`, uuid, service, actor, now); err != nil {
				return err
			}
		}
		return auditAction(ctx, tx, actor, "account.create_and_link")
	})
	if err != nil {
		return "", err
	}
	return uuid, nil
}

// AssignAdminRole enforces permission membership and strict role hierarchy.
// A grant never derives from a linked service identity or a cosmetic role.
func (s *Store) AssignAdminRole(ctx context.Context, actor, target, role string) error {
	return s.changeAdminRole(ctx, actor, target, role, true)
}

func (s *Store) RemoveAdminRole(ctx context.Context, actor, target, role string) error {
	return s.changeAdminRole(ctx, actor, target, role, false)
}

func (s *Store) changeAdminRole(ctx context.Context, actor, target, role string, grant bool) error {
	return s.write(ctx, func(tx *sql.Tx) error {
		authority, err := readAdminRoleHierarchyActor(ctx, tx, actor)
		if err != nil {
			return err
		}
		if err := checkAdminRoleHierarchyRole(ctx, tx, authority, role, -1); err != nil {
			return err
		}
		if err := checkAdminRoleHierarchyTarget(ctx, tx, authority, target); err != nil {
			return err
		}
		statement := "INSERT INTO admin_privileges(user_uuid,role_id) VALUES(?,?) ON CONFLICT DO NOTHING"
		action := "admin.role.assign"
		if !grant {
			statement = "DELETE FROM admin_privileges WHERE user_uuid=? AND role_id=?"
			action = "admin.role.remove"
		}
		if _, err := tx.ExecContext(ctx, statement, target, role); err != nil {
			return err
		}
		return auditAction(ctx, tx, actor, action)
	})
}

// ConsumeRefreshJTI serializes one-time refresh consumption. Token signature,
// type and expiry must be verified by auth before calling this method.
func (s *Store) ConsumeRefreshJTI(ctx context.Context, user, jti string, expires time.Time) error {
	if jti == "" || !expires.After(time.Now()) {
		return ErrForbidden
	}
	return s.write(ctx, func(tx *sql.Tx) error {
		var active bool
		if err := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM user_accounts WHERE uuid=? AND is_active=1
		 AND (access_expires_at IS NULL OR julianday(access_expires_at)>julianday('now')))`, user).Scan(&active); err != nil {
			return err
		}
		if !active {
			return ErrForbidden
		}
		var used bool
		if err := tx.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM token_blocklist WHERE jti=?)", jti).Scan(&used); err != nil {
			return err
		}
		if used {
			return ErrConflict
		}
		_, err := tx.ExecContext(ctx, `INSERT INTO token_blocklist(jti,token_type,user_uuid,revoked_at,expires_at) VALUES(?,'refresh',?,?,?)`, jti, user, utcTimestamp(time.Now()), utcTimestamp(expires))
		return err
	})
}
