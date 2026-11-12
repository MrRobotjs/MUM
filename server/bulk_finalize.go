package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"net/http"
	"strconv"
	"time"
)

func finalizeBulkProvider(ctx context.Context, tx *sql.Tx, b *bulkStored, index int, outcome, reason string) error {
	target := b.Targets[index]
	if err := checkBulkImpacts(ctx, tx, *b, target); err != nil {
		return err
	}
	indices := []int{index}
	if b.Action == "delete_users" && target.Group != "" {
		indices = nil
		for i, t := range b.Targets {
			if t.Group == target.Group && (b.Results[i].Outcome == "pending" || b.Results[i].Outcome == "unknown" || b.Results[i].Outcome == "failed") {
				indices = append(indices, i)
			}
		}
	}
	for _, i := range indices {
		if err := checkBulkTarget(ctx, tx, b.Actor, "", b.Operation, b.Targets[i]); err != nil {
			return err
		}
	}
	touched := map[int64]bool{}
	selected := map[string]bool{}
	for _, i := range indices {
		t := b.Targets[i]
		selected[t.UUID] = true
		touched[t.ServerID] = true
		switch b.Action {
		case "delete_users":
			if outcome != "deleted" {
				return ErrConflict
			}
			if _, err := tx.ExecContext(ctx, `INSERT INTO bulk_removed_identities(server_id,external_user_id,operation_id,removed_at) VALUES(?,?,?,?) ON CONFLICT(server_id,external_user_id) DO UPDATE SET operation_id=excluded.operation_id,removed_at=excluded.removed_at`, t.ServerID, t.RemoteID, b.ID, utcTimestamp(time.Now())); err != nil {
				return err
			}
			request, _ := http.NewRequestWithContext(ctx, http.MethodPost, "/", nil)
			if _, err := bulkDeleteService(request, tx, b.Actor, t.UUID); err != nil {
				return err
			}
		case "update_libraries":
			resolved, err := resolveBulkLibraryIDs(ctx, tx, t.ServerID, b.Operation.LibraryIDs)
			if err != nil {
				return err
			}
			ids, _ := json.Marshal(resolved)
			if _, err := tx.ExecContext(ctx, `UPDATE service_accounts SET allowed_library_ids=?,service_settings=json_set(coalesce(service_settings,'{}'),'$.all_libraries',json(?),'$.library_policy_known',json('true')),updated_at=? WHERE uuid=?`, string(ids), strconv.FormatBool(b.Operation.HasAllLibraries), utcTimestamp(time.Now()), t.UUID); err != nil {
				return err
			}
		}
		b.Results[i] = bulkUserResult{UUID: t.UUID, Outcome: outcome, Reason: reason}
	}
	for _, impact := range target.Impacts {
		touched[impact.ServerID] = true
		if !selected[impact.UUID] {
			if _, err := tx.ExecContext(ctx, "UPDATE service_accounts SET is_active=0,removed_at=coalesce(removed_at,?),updated_at=? WHERE uuid=?", utcTimestamp(time.Now()), utcTimestamp(time.Now()), impact.UUID); err != nil {
				return err
			}
		}
	}
	for server := range touched {
		if server == 0 {
			continue
		}
		if _, err := tx.ExecContext(ctx, "UPDATE media_servers SET revision=revision+1 WHERE id=?", server); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, "UPDATE media_activity_state SET mapping_revision=mapping_revision+1 WHERE server_id=?", server); err != nil {
			return err
		}
		for j := range b.Targets {
			if b.Targets[j].ServerID == server {
				b.Targets[j].SourceRevision++
			}
			for k := range b.Targets[j].Impacts {
				if b.Targets[j].Impacts[k].ServerID == server {
					b.Targets[j].Impacts[k].SourceRevision++
				}
			}
		}
	}
	return nil
}
