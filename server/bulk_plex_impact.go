package main

import (
	"context"
	"database/sql"
	"fmt"
)

func bulkPlexCatalogue(ctx context.Context, tx *sql.Tx, recipient string) (string, error) {
	sources, err := tx.QueryContext(ctx, "SELECT id,config_revision FROM media_servers WHERE service_type='plex' ORDER BY id")
	if err != nil {
		return "", err
	}
	state := []any{}
	for sources.Next() {
		var id, revision int64
		if err := sources.Scan(&id, &revision); err != nil {
			sources.Close()
			return "", err
		}
		state = append(state, []any{id, revision})
	}
	err = sources.Err()
	sources.Close()
	if err != nil {
		return "", err
	}
	rows, err := tx.QueryContext(ctx, `SELECT a.uuid,a.server_id,coalesce(l.user_uuid,'') FROM service_accounts a JOIN media_servers s ON s.id=a.server_id LEFT JOIN service_links l ON l.service_uuid=a.uuid AND l.link_kind='owner' WHERE s.service_type='plex' AND a.external_user_id=? ORDER BY a.uuid`, recipient)
	if err != nil {
		return "", err
	}
	for rows.Next() {
		var id, owner string
		var server int64
		if err := rows.Scan(&id, &server, &owner); err != nil {
			rows.Close()
			return "", err
		}
		state = append(state, []any{id, server, owner})
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return "", err
	}
	return bulkDigest(state), nil
}

// Friendship removal is wider than one PMS. Resolve all known same-recipient
// rows using their own administrator credentials; never equate tokens by name.
func (a *App) prepareBulkPlexImpacts(ctx context.Context, b *bulkStored, access string) error {
	if b.Action != "delete_users" {
		return nil
	}
	known := map[string][]bulkTarget{}
	reasons := map[string]string{}
	for i := range b.Targets {
		target := &b.Targets[i]
		if b.Results[i].Outcome != "pending" || target.PlexOwner == "" {
			continue
		}

		catalogueTx, e := a.store.reader.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
		if e != nil {
			return e
		}
		target.ImpactCatalogue, e = bulkPlexCatalogue(ctx, catalogueTx, target.RemoteID)
		catalogueTx.Rollback()
		if e != nil {
			return e
		}
		if reason := reasons[target.Group]; reason != "" {
			b.Results[i].Outcome = "skipped"
			b.Results[i].Reason = reason
			continue
		}
		if impacts, ok := known[target.Group]; ok {
			target.Impacts = append([]bulkTarget{}, impacts...)
			continue
		}
		rows, err := a.store.reader.QueryContext(ctx, `SELECT a.uuid FROM service_accounts a JOIN media_servers s ON s.id=a.server_id WHERE s.service_type='plex' AND a.external_user_id=? ORDER BY a.uuid LIMIT 501`, target.RemoteID)
		if err != nil {
			return err
		}
		var ids []string
		for rows.Next() {
			var id string
			if err := rows.Scan(&id); err != nil {
				rows.Close()
				return err
			}
			ids = append(ids, id)
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return err
		}
		if len(ids) > 500 {
			b.Results[i].Outcome = "skipped"
			b.Results[i].Reason = "plex_impact_too_large"
			continue
		}
		for _, id := range ids {
			tx, err := a.store.reader.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
			if err != nil {
				return err
			}
			impact, err := bulkServiceTarget(ctx, tx, id)
			protected := false
			if err == nil {
				err = tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM service_links l JOIN user_accounts u ON u.uuid=l.user_uuid WHERE l.service_uuid=? AND (u.kind='owner' OR u.uuid=? OR EXISTS(SELECT 1 FROM admin_privileges WHERE user_uuid=u.uuid)))`, id, b.Actor).Scan(&protected)
			}
			tx.Rollback()
			if err != nil {
				return err
			}
			// Same server has the same verified cloud administrator. Other servers
			// require their own verified group; failure makes the broad effect unknown.
			group := target.Group
			if impact.ServerID != target.ServerID {
				source, err := a.loadServer(ctx, impact.ServerID)
				if err != nil {
					return err
				}
				provider, err := newServerConnection(ProviderConfig{source.Type, source.URL, source.apiKey}, a.ProviderHTTP)
				if err == nil {
					p := provider
					p.bulkAuthority = func(ctx context.Context) error { return a.bulkPreparedAuthority(ctx, b.Actor, access, b.Role, impact) }
					var snapshot bulkProviderSnapshot
					snapshot, err = p.prepareBulkUser(ctx, bulkProviderRequest{Action: "delete_users", ID: impact.RemoteID, Name: impact.Name})
					group = snapshot.Group
				}
				if err != nil {
					b.Results[i].Outcome = "skipped"
					b.Results[i].Reason = "plex_impact_unavailable"
					break
				}
			}
			if group != target.Group {
				continue
			}
			if protected {
				b.Results[i].Outcome = "skipped"
				b.Results[i].Reason = "protected_plex_impact"
				break
			}
			target.Impacts = append(target.Impacts, impact)
			b.Effects = append(b.Effects, fmt.Sprintf("Plex friendship removal affects configured service account %s on server %d; unselected records retain their history and links.", impact.UUID, impact.ServerID))
		}
		if b.Results[i].Outcome == "pending" {
			known[target.Group] = target.Impacts
		} else {
			reasons[target.Group] = b.Results[i].Reason
		}
	}
	// A protected or ambiguous row cannot be bypassed by selecting another copy
	// of the same friendship on a different configured server.
	blocked := map[string]string{}
	for i, t := range b.Targets {
		if t.Group != "" && b.Results[i].Outcome == "skipped" {
			blocked[t.Group] = b.Results[i].Reason
		}
	}
	for i, t := range b.Targets {
		if reason := blocked[t.Group]; reason != "" && b.Results[i].Outcome == "pending" {
			b.Results[i].Outcome = "skipped"
			b.Results[i].Reason = reason
		}
	}
	return nil
}

func checkBulkImpacts(ctx context.Context, tx *sql.Tx, b bulkStored, target bulkTarget) error {
	if target.ImpactCatalogue != "" {
		current, err := bulkPlexCatalogue(ctx, tx, target.RemoteID)
		if err != nil {
			return err
		}
		if current != target.ImpactCatalogue {
			return ErrConflict
		}
	}

	for _, impact := range target.Impacts {
		if err := checkBulkTarget(ctx, tx, b.Actor, "", b.Operation, impact); err != nil {
			return err
		}
		var protected bool
		if err := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM service_links l JOIN user_accounts u ON u.uuid=l.user_uuid WHERE l.service_uuid=? AND (u.kind='owner' OR u.uuid=? OR EXISTS(SELECT 1 FROM admin_privileges WHERE user_uuid=u.uuid)))`, impact.UUID, b.Actor).Scan(&protected); err != nil {
			return err
		}
		if protected {
			return ErrForbidden
		}
	}
	return nil
}
