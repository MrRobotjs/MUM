package main

import (
	"context"
	"database/sql"
	"errors"
	"math"
)

var errAutomaticRoleOwnership = errors.New("automatic Downloads role ownership conflict")

func automaticRoleOwnershipConflict() error {
	return errors.Join(ErrConflict, errAutomaticRoleOwnership)
}

// Registry ownership is explicit. Neither a matching display name nor an
// existing automatic flag authorizes adopting another role or its assignments.
func ensureDownloadRole(ctx context.Context, tx *sql.Tx, expected int64) (string, error) {
	var revision int64
	if err := tx.QueryRowContext(ctx, "SELECT revision FROM download_role_state WHERE singleton=1").Scan(&revision); err != nil {
		return "", err
	}
	if revision != expected {
		return "", ErrConflict
	}
	var id, name string
	var automatic bool
	err := tx.QueryRowContext(ctx, "SELECT r.id,r.name,r.is_auto_managed FROM download_role d JOIN user_roles r ON r.id=d.role_id WHERE d.singleton=1").Scan(&id, &name, &automatic)
	if err == nil {
		if !automatic || name != "Downloads" {
			return "", automaticRoleOwnershipConflict()
		}
		return id, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return "", err
	}
	var collision bool
	var count int
	if err = tx.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM user_roles WHERE lower(name)=lower('Downloads')),(SELECT count(*) FROM user_roles)").Scan(&collision, &count); err != nil {
		return "", err
	}
	if collision || count >= 1000 {
		return "", automaticRoleOwnershipConflict()
	}
	id = newUUID()
	if _, err = tx.ExecContext(ctx, `INSERT INTO user_roles(id,name,description,is_auto_managed) VALUES(?,'Downloads','Last explicitly observed provider download permission; not proof of current access.',1)`, id); err != nil {
		return "", err
	}
	if _, err = tx.ExecContext(ctx, "INSERT INTO download_role(singleton,role_id) VALUES(1,?)", id); err != nil {
		return "", err
	}
	return id, nil
}

type downloadLabelChange struct {
	Service  string `json:"service_uuid"`
	External string `json:"external_user_id"`
	Allowed  bool   `json:"allowed"`
	Added    bool   `json:"assignment_added"`
	Removed  bool   `json:"assignment_removed"`
}

// Only supported providers with typed known facts can reconcile. Unknown policy
// and absent users never become an inferred denial.
func reconcileDownloadLabel(ctx context.Context, tx *sql.Tx, server ManagedServer, role, service string, account ProviderUser, now string) (*downloadLabelChange, error) {
	if account.Access == nil || !account.Access.DownloadsKnown {
		return nil, nil
	}
	if !supportsDownloadLabels(server.Type) || account.ID == "" || server.Revision < 0 || server.Revision == math.MaxInt64 {
		return nil, ErrConflict
	}
	if rule, ok := moduleRules(server.Type).(recordedIDRule); ok && !rule.ValidRecordedID(account.ID) {
		return nil, ErrConflict
	}
	var valid, member bool
	if err := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM service_accounts a JOIN media_servers s ON s.id=a.server_id JOIN download_role d ON d.singleton=1 AND d.role_id=?
 JOIN user_roles r ON r.id=d.role_id AND r.is_auto_managed=1 AND r.name='Downloads'
 WHERE a.uuid=? AND a.server_id=? AND a.external_user_id=? AND s.service_type=?),
 EXISTS(SELECT 1 FROM identity_user_roles WHERE user_uuid=? AND role_id=?)`, role, service, server.ID, account.ID, server.Type, service, role).Scan(&valid, &member); err != nil {
		return nil, err
	}
	if !valid {
		return nil, automaticRoleOwnershipConflict()
	}
	var oldServer, oldRevision int64
	var oldExternal, oldRole, oldProvider string
	var oldAllowed bool
	err := tx.QueryRowContext(ctx, "SELECT server_id,external_user_id,role_id,allowed,source_revision,provider_type FROM download_observations WHERE service_uuid=?", service).Scan(&oldServer, &oldExternal, &oldRole, &oldAllowed, &oldRevision, &oldProvider)
	if errors.Is(err, sql.ErrNoRows) {
		if member {
			return nil, automaticRoleOwnershipConflict()
		}
	} else if err != nil {
		return nil, err
	} else if oldProvider != server.Type || oldServer != server.ID || oldExternal != account.ID || oldRole != role || oldAllowed != member || oldRevision > server.Revision {
		return nil, automaticRoleOwnershipConflict()
	}
	out := &downloadLabelChange{Service: service, External: account.ID, Allowed: account.Access.AllowDownloads}
	if out.Allowed && !member {
		if _, err = tx.ExecContext(ctx, "INSERT INTO identity_user_roles(user_uuid,role_id) VALUES(?,?)", service, role); err != nil {
			return nil, err
		}
		out.Added = true
	}
	if !out.Allowed && member {
		if _, err = tx.ExecContext(ctx, "DELETE FROM identity_user_roles WHERE user_uuid=? AND role_id=?", service, role); err != nil {
			return nil, err
		}
		out.Removed = true
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO download_observations(service_uuid,server_id,external_user_id,role_id,allowed,source_revision,observed_at,provider_type) VALUES(?,?,?,?,?,?,?,?)
 ON CONFLICT(service_uuid) DO UPDATE SET allowed=excluded.allowed,source_revision=excluded.source_revision,observed_at=excluded.observed_at`, service, server.ID, account.ID, role, out.Allowed, server.Revision+1, now, server.Type)
	return out, err
}

func supportsDownloadLabels(provider string) bool {
	m, ok := findMediaModule(provider)
	return ok && m.Definition.DownloadLabels
}
