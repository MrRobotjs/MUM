package main

import (
	"context"
	"database/sql"
	"net/http"
	"time"
)

func (a *App) executeEdit(w http.ResponseWriter, r *http.Request) {
	actor, ok := a.principal(w, r, true)
	if !ok {
		return
	}
	var input struct {
		Revision string `json:"revision"`
		Ack      bool   `json:"acknowledge_effects"`
	}
	if !decodeStrictBody(w, r, &input) {
		return
	}
	if !input.Ack {
		fail(w, 400, "CONFIRMATION_REQUIRED", "Review and acknowledge the prepared effects")
		return
	}
	access := bearer(r)
	var stored editStored
	already := false
	err := a.store.write(r.Context(), func(tx *sql.Tx) error {
		if err := editAuthorityTx(r.Context(), tx, actor.UUID, access); err != nil {
			return err
		}
		var err error
		stored, err = loadEdit(r.Context(), tx, r.PathValue("operation"))
		if err != nil {
			return err
		}
		if stored.Actor != actor.UUID || stored.AccessHash != tokenHash(access) {
			return ErrForbidden
		}
		if stored.State != "prepared" {
			already = true
			return nil
		}
		if stored.Revision != input.Revision {
			return ErrConflict
		}
		var role int64
		if err := tx.QueryRowContext(r.Context(), "SELECT revision FROM admin_role_state WHERE singleton=1").Scan(&role); err != nil {
			return err
		}
		if role != stored.Role {
			return ErrConflict
		}
		for i, target := range stored.Targets {
			if stored.Results[i].Outcome != "pending" {
				continue
			}
			if err := checkEditTarget(r.Context(), tx, actor.UUID, access, stored.Operation, target); err != nil {
				return err
			}
			if target.ServerID != 0 {
				busy, err := servicePendingWork(r.Context(), tx, target.ServerID)
				if err != nil {
					return err
				}
				if busy {
					return ErrConflict
				}
			}
		}
		return nil
	})
	if err != nil {
		domainError(w, err)
		return
	}
	if already {
		respond(w, 200, stored.editReceipt)
		return
	}
	// Admission and shutdown tracking share the existing bounded provider pool.
	a.provisionMu.Lock()
	if a.provisionClosing {
		a.provisionMu.Unlock()
		fail(w, 503, "SHUTTING_DOWN", "Edit admission has stopped")
		return
	}
	select {
	case a.provisionSlots <- struct{}{}:
	default:
		a.provisionMu.Unlock()
		fail(w, 503, "EDIT_BUSY", "Provider work capacity is busy")
		return
	}
	a.provisionWG.Add(1)
	a.provisionMu.Unlock()
	admitted := false
	defer func() {
		if !admitted {
			<-a.provisionSlots
			a.provisionWG.Done()
		}
	}()
	token := newUUID()
	err = a.store.write(r.Context(), func(tx *sql.Tx) error {
		current, err := loadEdit(r.Context(), tx, stored.ID)
		if err != nil {
			return err
		}
		if current.State != "prepared" || current.Revision != stored.Revision {
			return ErrConflict
		}
		if err := editAuthorityTx(r.Context(), tx, actor.UUID, access); err != nil {
			return err
		}
		for i, target := range current.Targets {
			if current.Results[i].Outcome != "pending" {
				continue
			}
			if err := checkEditTarget(r.Context(), tx, actor.UUID, access, current.Operation, target); err != nil {
				return err
			}
		}
		servers := map[int64]bool{}
		for i, target := range current.Targets {
			if current.Results[i].Outcome == "pending" && target.ServerID != 0 {
				servers[target.ServerID] = true
				for _, impact := range target.Impacts {
					servers[impact.ServerID] = true
				}
			}
		}
		for server := range servers {
			busy, err := servicePendingWork(r.Context(), tx, server)
			if err != nil {
				return err
			}
			if busy {
				return ErrConflict
			}
			if _, err := tx.ExecContext(r.Context(), "INSERT INTO edit_source_locks(server_id,operation_id,operation_token) VALUES(?,?,?)", server, current.ID, token); err != nil {
				return ErrConflict
			}
		}
		result, err := tx.ExecContext(r.Context(), `UPDATE edit_operations SET state='running',operation_token=?,revision=revision+1,updated_at=? WHERE id=? AND state='prepared' AND revision=?`, token, utcTimestamp(time.Now()), current.ID, current.Revision)
		if err != nil {
			return err
		}
		if n, _ := result.RowsAffected(); n != 1 {
			return ErrConflict
		}
		stored, err = loadEdit(r.Context(), tx, current.ID)
		return err
	})
	if err != nil {
		domainError(w, err)
		return
	}
	admitted = true
	go func() { defer func() { <-a.provisionSlots; a.provisionWG.Done() }(); a.runEdit(stored, access, false) }()
	respond(w, 202, stored.editReceipt)
}

func (a *App) editRunningAuthority(ctx context.Context, stored editStored, access string, target editTarget) error {
	tx, err := a.store.reader.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := editAuthorityTx(ctx, tx, stored.Actor, access); err != nil {
		return err
	}
	var valid bool
	err = tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM edit_operations b JOIN admin_role_state s ON s.singleton=1 WHERE b.id=? AND b.state='running' AND b.operation_token=? AND b.role_revision=s.revision AND b.access_hash=?)`, stored.ID, stored.Token, tokenHash(access)).Scan(&valid)
	if err != nil {
		return err
	}
	if !valid {
		return ErrForbidden
	}
	if target.ServerID != 0 {
		var held bool
		if err := tx.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM edit_source_locks WHERE server_id=? AND operation_id=? AND operation_token=?)", target.ServerID, stored.ID, stored.Token).Scan(&held); err != nil {
			return err
		}
		if !held {
			return ErrConflict
		}
		if err := checkEditImpacts(ctx, tx, stored, target); err != nil {
			return err
		}
		return checkEditTarget(ctx, tx, stored.Actor, access, stored.Operation, target)
	}
	return nil
}

func (a *App) editCheckpoint(ctx context.Context, b *editStored, index int, stage string) error {
	return a.store.write(ctx, func(tx *sql.Tx) error {
		current, err := loadEdit(ctx, tx, b.ID)
		if err != nil {
			return err
		}
		if current.Token != b.Token || current.State != "running" {
			return ErrConflict
		}
		current.Targets[index].Stage = stage
		if current.Action == "delete_users" && current.Targets[index].Group != "" {
			for j := range current.Targets {
				if current.Targets[j].Group == current.Targets[index].Group && current.Results[j].Outcome == "pending" {
					current.Targets[j].Stage = stage
				}
			}
		}
		if err := saveEdit(ctx, tx, &current); err != nil {
			return err
		}
		current.liveAccess = b.liveAccess
		*b = current
		return nil
	})
}

func (a *App) runEdit(stored editStored, access string, reconcile bool) {
	stored.liveAccess = access
	ctx, cancel := context.WithTimeout(a.provisionCtx, 15*time.Minute)
	defer cancel()
	// Every exit records unresolved intent; no automatic resend on crash/cancel.
	defer a.finishEdit(stored.ID, stored.Token)
	groups := map[string]editProviderResult{}
	for i := range stored.Targets {
		target := stored.Targets[i]
		outcome := stored.Results[i].Outcome
		if target.ServerID == 0 || (!reconcile && outcome != "pending") || (reconcile && outcome != "unknown" && outcome != "failed") {
			continue
		}
		if ctx.Err() != nil {
			return
		}
		if err := a.editRunningAuthority(ctx, stored, access, target); err != nil {
			a.recordEditResult(&stored, i, editPreDispatchOutcome(target), "stale_authority", false)
			continue
		}
		source, err := a.loadServer(ctx, target.ServerID)
		if err != nil {
			a.recordEditResult(&stored, i, editPreDispatchOutcome(target), "server_unavailable", false)
			continue
		}
		provider, err := newServerConnection(ProviderConfig{source.Type, source.URL, source.apiKey}, a.ProviderHTTP)
		if err != nil {
			a.recordEditResult(&stored, i, editPreDispatchOutcome(target), "provider_unavailable", false)
			continue
		}
		client := provider
		client.editAuthority = func(check context.Context) error { return a.editRunningAuthority(check, stored, access, target) }
		request, err := a.editProviderRequest(ctx, stored.Operation, target)
		var result editProviderResult
		if err == nil {
			if previous, ok := groups[target.Group]; ok && target.Group != "" && stored.Action == "delete_users" {
				result = previous
			} else if reconcile {
				result, err = client.reconcileEditUser(ctx, request)
			} else {
				var snapshot editProviderSnapshot
				snapshot, err = client.prepareEditUser(ctx, request)
				if err == nil && snapshot.Revision != target.RemoteRevision {
					err = ErrConflict
				}
				if err == nil {
					result, err = client.executeEditUser(ctx, request, snapshot, func(stage string) error { return a.editCheckpoint(ctx, &stored, i, stage) })
				}
				if target.Group != "" && stored.Action == "delete_users" {
					groups[target.Group] = result
				}
			}
		}
		if err != nil {
			if stored.Targets[i].Stage != "" {
				result = editProviderResult{Outcome: "unknown", Code: "remote_outcome_uncertain"}
			} else {
				result = editProviderResult{Outcome: "failed", Code: "provider_rejected"}
			}
		}
		if result.Outcome != "deleted" && result.Outcome != "updated" && result.Outcome != "unchanged" {
			if result.Outcome != "unknown" {
				result.Outcome = "failed"
			}
			if result.Code == "" {
				result.Code = "provider_not_verified"
			}
		}
		if !a.recordEditResult(&stored, i, result.Outcome, result.Code, result.Outcome == "deleted" || result.Outcome == "updated" || result.Outcome == "unchanged") {
			return
		}
	}
	if reconcile {
		return
	}
	if stored.Summary["unknown"] > 0 {
		for i, t := range stored.Targets {
			if t.ServerID == 0 && stored.Results[i].Outcome == "pending" {
				if !a.recordEditResult(&stored, i, "failed", "remote_awaiting_review", false) {
					return
				}
			}
		}
		return
	}
	ctx = context.WithValue(ctx, editOperationContextKey{}, stored.ID)
	// All local mutations use one transaction. Validate the entire local group
	// before making its own link/revision changes, so a stale group is atomic.
	var closed []string
	err := a.store.write(ctx, func(tx *sql.Tx) error {
		if err := editAuthorityTx(ctx, tx, stored.Actor, access); err != nil {
			return err
		}
		var role int64
		if err := tx.QueryRowContext(ctx, "SELECT revision FROM admin_role_state WHERE singleton=1").Scan(&role); err != nil {
			return err
		}
		if role != stored.Role {
			return ErrForbidden
		}
		current, err := loadEdit(ctx, tx, stored.ID)
		if err != nil {
			return err
		}
		if current.Token != stored.Token || current.State != "running" {
			return ErrConflict
		}
		for i, target := range current.Targets {
			if target.ServerID == 0 && current.Results[i].Outcome == "pending" {
				if err := checkEditTarget(ctx, tx, current.Actor, access, current.Operation, target); err != nil {
					return err
				}
			}
		}
		for i, target := range current.Targets {
			if target.ServerID != 0 || current.Results[i].Outcome != "pending" {
				continue
			}
			result, err := applyEditLocal(ctx, tx, current.Actor, access, target.UUID, current.Operation, target.Local)
			if err != nil {
				return err
			}
			current.Results[i] = result
			if result.Outcome == "updated" || result.Outcome == "deleted" {
				closed = append(closed, target.UUID)
				if target.Local.Owner != "" {
					closed = append(closed, target.Local.Owner)
				}
			}
		}
		if err := saveEdit(ctx, tx, &current); err != nil {
			return err
		}
		stored = current
		return nil
	})
	if err != nil {
		for i, target := range stored.Targets {
			if target.ServerID == 0 && stored.Results[i].Outcome == "pending" {
				if !a.recordEditResult(&stored, i, "failed", "local_group_changed", false) {
					return
				}
			}
		}
	} else {
		for _, id := range closed {
			a.hub.closeAccountConnections(id)
		}
	}
}

func (a *App) recordEditResult(b *editStored, index int, outcome, reason string, verified bool) bool {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	err := a.store.write(ctx, func(tx *sql.Tx) error {
		current, err := loadEdit(ctx, tx, b.ID)
		if err != nil {
			return err
		}
		if current.Token != b.Token || current.State != "running" {
			return ErrConflict
		}
		target := current.Targets[index]
		if verified {
			// A provider outcome is not enough: freeze checks must still hold before
			// local cleanup. A failed finalization retains the intent as unknown.
			if err := checkEditTarget(ctx, tx, current.Actor, "", current.Operation, target); err != nil {
				return err
			}
			if err := editAuthorityTx(ctx, tx, current.Actor, b.liveAccess); err != nil {
				return err
			}
			var kind string
			if err := tx.QueryRowContext(ctx, "SELECT kind FROM user_accounts WHERE uuid=?", current.Actor).Scan(&kind); err != nil {
				return err
			}
			if kind != "owner" {
				return ErrForbidden
			}
			var role int64
			if err := tx.QueryRowContext(ctx, "SELECT revision FROM admin_role_state WHERE singleton=1").Scan(&role); err != nil {
				return err
			}
			if role != current.Role {
				return ErrForbidden
			}

			if target.ServerID != 0 {
				if err := finalizeEditProvider(ctx, tx, &current, index, outcome, reason); err != nil {
					return err
				}
			}

		}
		current.Results[index] = editUserResult{UUID: target.UUID, Outcome: outcome, Reason: reason}
		if err := auditAction(ctx, tx, current.Actor, "edit."+current.Action+"."+outcome); err != nil {
			return err
		}
		if err := saveEdit(ctx, tx, &current); err != nil {
			return err
		}
		current.liveAccess = b.liveAccess
		*b = current
		return nil
	})
	if err != nil {
		a.logger.Warn("Edit result needs reconciliation", "operation", b.ID, "code", "RESULT_NOT_SAVED")
		return false
	}
	return true
}

func (a *App) finishEdit(id, token string) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	err := a.store.write(ctx, func(tx *sql.Tx) error {
		b, err := loadEdit(ctx, tx, id)
		if err != nil {
			return err
		}
		if b.State != "running" || b.Token != token {
			return nil
		}
		b.State = "completed"
		for i := range b.Results {
			if b.Results[i].Outcome == "pending" {
				b.Results[i].Outcome = "failed"
				b.Results[i].Reason = "interrupted_before_dispatch"
				if b.Targets[i].Stage != "" {
					b.Results[i].Outcome = "unknown"
					b.Results[i].Reason = "remote_outcome_uncertain"
				}
			}
			if b.Results[i].Outcome == "unknown" || b.Results[i].Outcome == "failed" {
				b.State = "needs_review"
			}
		}
		if err := saveEdit(ctx, tx, &b); err != nil {
			return err
		}
		if b.Summary["unknown"] == 0 {
			if _, err := tx.ExecContext(ctx, "DELETE FROM edit_source_locks WHERE operation_id=? AND operation_token=?", id, token); err != nil {
				return err
			}
		}
		_, err = tx.ExecContext(ctx, "UPDATE edit_operations SET operation_token=NULL WHERE id=? AND operation_token=?", id, token)
		return err
	})
	if err != nil {
		a.logger.Error("Edit journal requires recovery", "operation", id, "code", "JOURNAL_STALLED")
	}
}

func (a *App) reconcileEdit(w http.ResponseWriter, r *http.Request) {
	actor, ok := a.principal(w, r, true)
	if !ok {
		return
	}
	if actor.Kind != "owner" {
		domainError(w, ErrForbidden)
		return
	}
	var input struct {
		Revision string `json:"revision"`
	}
	if !decodeStrictBody(w, r, &input) {
		return
	}
	access := bearer(r)
	var stored editStored
	err := a.store.write(r.Context(), func(tx *sql.Tx) error {
		if err := editAuthorityTx(r.Context(), tx, actor.UUID, access); err != nil {
			return err
		}
		var err error
		stored, err = loadEdit(r.Context(), tx, r.PathValue("operation"))
		if err != nil {
			return err
		}
		if stored.Actor != actor.UUID {
			return ErrForbidden
		}
		if stored.State != "needs_review" || stored.Revision != input.Revision {
			return ErrConflict
		}
		// A fresh explicit read-only reconciliation can use a current session;
		// existing provider intent and source/identity evidence stay unchanged.
		if err := tx.QueryRowContext(r.Context(), "SELECT revision FROM admin_role_state WHERE singleton=1").Scan(&stored.Role); err != nil {
			return err
		}
		stored.AccessHash = tokenHash(access)
		return nil
	})
	if err != nil {
		domainError(w, err)
		return
	}
	// Reuse bounded shutdown-aware admission, with no remote mutation capability.
	ctx, done, ok := a.startReviewOperation(w, r)
	if !ok {
		return
	}
	defer done()
	stored.Token = newUUID()
	err = a.store.write(ctx, func(tx *sql.Tx) error {
		current, err := loadEdit(ctx, tx, stored.ID)
		if err != nil {
			return err
		}
		if current.Revision != input.Revision || current.State != "needs_review" {
			return ErrConflict
		}
		if _, err := tx.ExecContext(ctx, "DELETE FROM edit_source_locks WHERE operation_id=?", stored.ID); err != nil {
			return err
		}
		servers := map[int64]bool{}
		for i, target := range stored.Targets {
			if target.ServerID == 0 || (stored.Results[i].Outcome != "unknown" && stored.Results[i].Outcome != "failed") {
				continue
			}
			if err := checkEditTarget(ctx, tx, actor.UUID, access, stored.Operation, target); err != nil {
				return err
			}
			if err := checkEditImpacts(ctx, tx, stored, target); err != nil {
				return err
			}
			servers[target.ServerID] = true
			for _, impact := range target.Impacts {
				servers[impact.ServerID] = true
			}
		}
		for server := range servers {
			busy, err := servicePendingWork(ctx, tx, server)
			if err != nil {
				return err
			}
			if busy {
				return ErrConflict
			}
		}
		for server := range servers {
			if _, err := tx.ExecContext(ctx, "INSERT INTO edit_source_locks(server_id,operation_id,operation_token) VALUES(?,?,?)", server, stored.ID, stored.Token); err != nil {
				return err
			}
		}

		_, err = tx.ExecContext(ctx, `UPDATE edit_operations SET state='running',operation_token=?,role_revision=?,access_hash=?,revision=revision+1 WHERE id=? AND revision=?`, stored.Token, stored.Role, stored.AccessHash, stored.ID, input.Revision)
		if err == nil {
			stored, err = loadEdit(ctx, tx, stored.ID)
		}
		return err
	})
	if err != nil {
		domainError(w, err)
		return
	}
	a.runEdit(stored, access, true)
	tx, err := a.store.reader.BeginTx(r.Context(), &sql.TxOptions{ReadOnly: true})
	if err != nil {
		domainError(w, err)
		return
	}
	defer tx.Rollback()
	if err := editAuthorityTx(r.Context(), tx, actor.UUID, bearer(r)); err != nil {
		domainError(w, err)
		return
	}
	stored, err = loadEdit(r.Context(), tx, stored.ID)
	if err != nil {
		domainError(w, err)
		return
	}
	respond(w, 200, stored.editReceipt)
}

func (a *App) recoverEdit(ctx context.Context) error {
	rows, err := a.store.reader.QueryContext(ctx, "SELECT id,operation_token FROM edit_operations WHERE state='running'")
	if err != nil {
		return err
	}
	var pending [][2]string
	for rows.Next() {
		var id, token string
		if err := rows.Scan(&id, &token); err != nil {
			rows.Close()
			return err
		}
		pending = append(pending, [2]string{id, token})
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	for _, p := range pending {
		a.finishEdit(p[0], p[1])
	}
	return nil
}

// A failed read cannot turn a dispatched, unresolved mutation into a rejection.
func editPreDispatchOutcome(target editTarget) string {
	if target.Stage != "" {
		return "unknown"
	}
	return "failed"
}

type editOperationContextKey struct{}

func editContextOperation(ctx context.Context) string {
	value, _ := ctx.Value(editOperationContextKey{}).(string)
	return value
}
