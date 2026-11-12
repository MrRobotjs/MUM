package main

import (
	"database/sql"
	"errors"
	"testing"
)

func TestAdminRoleHierarchyCosmeticActorRoleCannotAmplifyAuthority(t *testing.T) {
	_, s, token, _, actor := roleReadFixture(t)
	owner, _ := s.Authenticate(t.Context(), token)
	target, err := s.CreateAccount(t.Context(), owner.UUID, "hierarchy-target", "fixture-hash", false)
	if err != nil {
		t.Fatal(err)
	}
	for _, q := range []string{
		`INSERT INTO admin_roles(id,name,position) VALUES('cosmetic','Cosmetic boost',500),('middle','Middle',100)`,
		`INSERT INTO admin_privileges SELECT uuid,'cosmetic' FROM user_accounts WHERE uuid='` + actor + `'`,
	} {
		if _, err := s.writer.Exec(q); err != nil {
			t.Fatal(err)
		}
	}
	if err := s.AssignAdminRole(t.Context(), actor, target, "middle"); !errors.Is(err, ErrForbidden) {
		t.Fatal("cosmetic role raised delegation ceiling", err)
	}
	if err := s.AssignAdminRole(t.Context(), actor, target, "low"); err != nil {
		t.Fatal("actual administrator grant must permit a strictly lower role", err)
	}
	if err := s.write(t.Context(), func(tx *sql.Tx) error {
		a, err := readAdminRoleHierarchyActor(t.Context(), tx, actor)
		if err == nil && (a.Ceiling != 50 || a.Owner || a.UUID != actor) {
			t.Fatal(a)
		}
		return err
	}); err != nil {
		t.Fatal(err)
	}
	if err := s.AssignAdminRole(t.Context(), owner.UUID, target, "middle"); err != nil {
		t.Fatal("owner must retain authority above delegated ceiling", err)
	}
	before := roleRevision(t, s)
	if err := s.RemoveAdminRole(t.Context(), actor, target, "low"); !errors.Is(err, ErrForbidden) {
		t.Fatal("higher target could be demoted through a lower role", err)
	}
	if roleRevision(t, s) != before {
		t.Fatal("rejected demotion changed catalog")
	}
}

func TestAdminRoleHierarchyRoleAndTargetBoundaries(t *testing.T) {
	for _, mode := range []string{"lower", "role-tie", "proposed-tie", "above-to-below", "target-tie", "target-cosmetic", "inactive-peer", "self", "owner", "system", "owner-role", "missing-role", "missing-target", "inactive-lower"} {
		t.Run(mode, func(t *testing.T) {
			_, s, token, _, actor := roleReadFixture(t)
			owner, _ := s.Authenticate(t.Context(), token)
			target, err := s.CreateAccount(t.Context(), owner.UUID, "boundary-target", "fixture-hash", false)
			if err != nil {
				t.Fatal(err)
			}
			role, proposed := "low", 49
			switch mode {
			case "role-tie", "above-to-below":
				role = "high"
			case "proposed-tie":
				proposed = 50
			case "target-tie", "target-cosmetic", "inactive-peer":
				position := 50
				if mode == "target-cosmetic" {
					position = 500
				}
				if _, err := s.writer.Exec("INSERT INTO admin_roles(id,name,position) VALUES('peer','Cosmetic target protection',?)", position); err != nil {
					t.Fatal(err)
				}
				s.writer.Exec("INSERT INTO admin_privileges VALUES(?,'peer')", target)
				if mode == "inactive-peer" {
					s.writer.Exec("UPDATE user_accounts SET is_active=0 WHERE uuid=?", target)
				}
			case "self":
				target = actor
			case "owner":
				target = owner.UUID
			case "system":
				s.writer.Exec("UPDATE admin_roles SET is_auto_managed=1 WHERE id='low'")
			case "owner-role":
				s.writer.Exec("INSERT INTO admin_privileges VALUES(?,'low')", owner.UUID)
			case "missing-role":
				role = "absent"
			case "missing-target":
				target = "00000000-0000-0000-0000-000000000000"
			case "inactive-lower":
				s.writer.Exec("UPDATE user_accounts SET is_active=0 WHERE uuid=?", target)
			}
			err = s.write(t.Context(), func(tx *sql.Tx) error {
				a, err := readAdminRoleHierarchyActor(t.Context(), tx, actor)
				if err != nil {
					return err
				}
				if err := checkAdminRoleHierarchyRole(t.Context(), tx, a, role, proposed); err != nil {
					return err
				}
				return checkAdminRoleHierarchyTarget(t.Context(), tx, a, target)
			})
			if mode == "lower" || mode == "inactive-lower" {
				if err != nil {
					t.Fatal(err)
				}
			} else if mode == "missing-role" || mode == "missing-target" {
				if !errors.Is(err, ErrNotFound) {
					t.Fatal(err)
				}
			} else if !errors.Is(err, ErrForbidden) {
				t.Fatal("hierarchy boundary admitted", err)
			}
		})
	}
}

func TestAdminRoleHierarchySessionRechecksLiveState(t *testing.T) {
	for _, mode := range []string{"valid", "access", "refresh", "logout", "inactive", "expired", "grant", "permission", "actor", "revision", "canonical"} {
		t.Run(mode, func(t *testing.T) {
			_, s, ownerToken, token, actor := roleReadFixture(t)
			owner, _ := s.Authenticate(t.Context(), ownerToken)
			revision := roleRevision(t, s)
			if mode == "actor" {
				token = ownerToken
			}
			err := s.write(t.Context(), func(tx *sql.Tx) error {
				var err error
				switch mode {
				case "access":
					_, err = tx.Exec("UPDATE session_access_tokens SET expires_at='2000-01-01T00:00:00Z' WHERE token_hash=?", tokenHash(token))
				case "refresh":
					_, err = tx.Exec("UPDATE app_sessions SET refresh_expires_at='2000-01-01T00:00:00Z' WHERE user_uuid=?", actor)
				case "logout":
					_, err = tx.Exec("DELETE FROM app_sessions WHERE user_uuid=?", actor)
				case "inactive":
					_, err = tx.Exec("UPDATE user_accounts SET is_active=0 WHERE uuid=?", actor)
				case "expired":
					_, err = tx.Exec("UPDATE user_accounts SET access_expires_at='2000-01-01T00:00:00Z' WHERE uuid=?", actor)
				case "grant":
					_, err = tx.Exec("DELETE FROM admin_privileges WHERE user_uuid=?", actor)
				case "permission":
					_, err = tx.Exec("DELETE FROM admin_role_permissions WHERE role_id='high'")
				case "canonical":
					_, err = tx.Exec("UPDATE admin_permissions SET name='future' WHERE id='admin'")
				case "revision":
					_, err = tx.Exec("UPDATE admin_roles SET position=position+1 WHERE id='low'")
				}
				if err != nil {
					t.Fatal(err)
				}
				_, err = readAdminRoleHierarchySession(t.Context(), tx, actor, token, revision)
				return err
			})
			if mode == "valid" && err != nil || mode != "valid" && err == nil {
				t.Fatal(mode, err)
			}
			if mode == "revision" && !errors.Is(err, ErrConflict) {
				t.Fatal(err)
			}
			if err := s.write(t.Context(), func(tx *sql.Tx) error {
				a, err := readAdminRoleHierarchySession(t.Context(), tx, owner.UUID, ownerToken, roleRevision(t, s))
				if err == nil && !a.Owner {
					t.Fatal("owner lost implicit authority")
				}
				return err
			}); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestAdminRoleHierarchySharedRoleProtectsEveryAffectedAccount(t *testing.T) {
	for _, mode := range []string{"lower", "peer", "self", "owner"} {
		t.Run(mode, func(t *testing.T) {
			_, s, token, _, actor := roleReadFixture(t)
			owner, _ := s.Authenticate(t.Context(), token)
			target, err := s.CreateAccount(t.Context(), owner.UUID, "shared-target", "fixture-hash", false)
			if err != nil {
				t.Fatal(err)
			}
			if mode == "peer" {
				s.writer.Exec("INSERT INTO admin_privileges VALUES(?,'high')", target)
			} else if mode == "self" {
				target = actor
			} else if mode == "owner" {
				target = owner.UUID
			}
			if _, err := s.writer.Exec("INSERT INTO admin_privileges VALUES(?,'low')", target); err != nil {
				t.Fatal(err)
			}
			err = s.write(t.Context(), func(tx *sql.Tx) error {
				a, err := readAdminRoleHierarchyActor(t.Context(), tx, actor)
				if err != nil {
					return err
				}
				return checkAdminRoleHierarchyMembers(t.Context(), tx, a, "low")
			})
			if mode == "lower" && err != nil || mode != "lower" && !errors.Is(err, ErrForbidden) {
				t.Fatal(mode, err)
			}
		})
	}
}

func TestAdminRoleHierarchyMemberInspectionBound(t *testing.T) {
	_, s, token, _, actor := roleReadFixture(t)
	owner, _ := s.Authenticate(t.Context(), token)
	if err := s.write(t.Context(), func(tx *sql.Tx) error {
		// All data belongs to this disposable database. Insert one over the
		// inspection bound so a truncated member list cannot grant authority.
		_, err := tx.Exec(`WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<10001)
		 INSERT INTO identities(uuid,kind) SELECT printf('00000000-0000-0000-0000-%012d',i),'local' FROM n`)
		if err != nil {
			return err
		}
		_, err = tx.Exec(`INSERT INTO user_accounts(uuid,kind,local_username,password_hash,created_at,updated_at)
		 SELECT uuid,'local',uuid,'fixture-hash','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z' FROM identities WHERE uuid LIKE '00000000-%'`)
		if err != nil {
			return err
		}
		_, err = tx.Exec(`INSERT INTO admin_privileges SELECT uuid,'low' FROM user_accounts WHERE uuid LIKE '00000000-%'`)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{actor, owner.UUID} {
		err := s.write(t.Context(), func(tx *sql.Tx) error {
			a, err := readAdminRoleHierarchyActor(t.Context(), tx, id)
			if err != nil {
				return err
			}
			return checkAdminRoleHierarchyMembers(t.Context(), tx, a, "low")
		})
		if !errors.Is(err, ErrConflict) {
			t.Fatal("oversized inspection became partial success", err)
		}
	}
}
