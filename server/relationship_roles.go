package main

import (
	"context"
	"database/sql"
)

// relationshipRoles are the automatic Home User and Shares Back roles,
// registered by migration 068. A kind missing from the registry (because a
// role someone created already used the name) is simply not managed.
type relationshipRoles struct {
	Home, SharesBack string
}

func loadRelationshipRoles(ctx context.Context, tx *sql.Tx) (relationshipRoles, error) {
	var roles relationshipRoles
	rows, err := tx.QueryContext(ctx, `SELECT k.kind,k.role_id FROM relationship_roles k JOIN user_roles r ON r.id=k.role_id AND r.is_auto_managed=1`)
	if err != nil {
		return roles, err
	}
	defer rows.Close()
	for rows.Next() {
		var kind, id string
		if err := rows.Scan(&kind, &id); err != nil {
			return roles, err
		}
		switch kind {
		case "home_user":
			roles.Home = id
		case "shares_back":
			roles.SharesBack = id
		}
	}
	return roles, rows.Err()
}

type relationshipLabelChange struct {
	Service string `json:"service_uuid"`
	Label   string `json:"label"`
	Added   bool   `json:"assignment_added"`
}

// reconcileRelationshipRoles gives one synced account exactly the relationship
// roles the service reported. Unreported relationships leave roles untouched.
func reconcileRelationshipRoles(ctx context.Context, tx *sql.Tx, roles relationshipRoles, service string, relationship *ProviderUserRelationship) ([]relationshipLabelChange, error) {
	if relationship == nil {
		return nil, nil
	}
	var changes []relationshipLabelChange
	for _, label := range []struct {
		name, role string
		want       bool
	}{{"home_user", roles.Home, relationship.Home}, {"shares_back", roles.SharesBack, relationship.SharesBack}} {
		if label.role == "" {
			continue
		}
		statement := "DELETE FROM identity_user_roles WHERE user_uuid=? AND role_id=?"
		if label.want {
			statement = "INSERT INTO identity_user_roles(user_uuid,role_id) VALUES(?,?) ON CONFLICT DO NOTHING"
		}
		result, err := tx.ExecContext(ctx, statement, service, label.role)
		if err != nil {
			return nil, err
		}
		if changed, err := result.RowsAffected(); err != nil {
			return nil, err
		} else if changed > 0 {
			changes = append(changes, relationshipLabelChange{Service: service, Label: label.name, Added: label.want})
		}
	}
	return changes, nil
}
