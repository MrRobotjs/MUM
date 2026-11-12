package main

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"slices"
	"strconv"
	"time"
)

type editTarget struct {
	UUID            string
	Kind            string
	ServerID        int64
	SourceRevision  int64
	Fingerprint     string
	RemoteRevision  string
	Group           string
	PlexOwner       string
	PlexRecipient   string
	RemoteID        string
	Name            string
	Local           editLocalSelection
	Stage           string
	Impacts         []editTarget
	ImpactCatalogue string
}

type editStored struct {
	liveAccess string
	editReceipt
	Actor      string
	AccessHash string
	Role       int64
	Token      string
	Operation  editOperationInput
	Targets    []editTarget
}

func editDigest(value any) string {
	encoded, _ := json.Marshal(value)
	hash := sha256.Sum256(encoded)
	return hex.EncodeToString(hash[:])
}

func validEditInput(op editOperationInput) bool {
	switch op.Action {
	case "delete_users", "unlink_local", "clear_expiration":
		return op.Days == 0 && op.ExpiresAt == nil && len(op.LibraryIDs) == 0 && !op.HasAllLibraries && op.TargetLocalUserUUID == ""
	case "link_local":
		return validAdminMemberCursor(op.TargetLocalUserUUID) && op.Days == 0 && op.ExpiresAt == nil && len(op.LibraryIDs) == 0 && !op.HasAllLibraries
	case "extend_access":
		return op.Days >= 1 && op.Days <= 36500 && op.ExpiresAt == nil && len(op.LibraryIDs) == 0 && !op.HasAllLibraries && op.TargetLocalUserUUID == ""
	case "set_expiration":
		if op.ExpiresAt == nil || op.Days != 0 || len(op.LibraryIDs) != 0 || op.HasAllLibraries || op.TargetLocalUserUUID != "" {
			return false
		}
		value, err := time.Parse(time.RFC3339, *op.ExpiresAt)
		return err == nil && value.UTC().Format(time.RFC3339) == *op.ExpiresAt && value.After(time.Now()) && value.Year() <= 9999
	case "update_libraries":
		if op.Days != 0 || op.ExpiresAt != nil || op.TargetLocalUserUUID != "" || len(op.LibraryIDs) > 1000 || op.HasAllLibraries && len(op.LibraryIDs) > 0 {
			return false
		}
		seen := map[string]bool{}
		for _, id := range op.LibraryIDs {
			if !validProvisionedID(id) || seen[id] {
				return false
			}
			seen[id] = true
		}
		return true
	}
	return false
}

func editAuthorityTx(ctx context.Context, tx *sql.Tx, actor, access string) error {
	if err := accountPreferenceAuthority(ctx, tx, actor, access); err != nil {
		return err
	}
	return requirePermission(ctx, tx, actor, "administrator")
}

func editServiceTarget(ctx context.Context, tx *sql.Tx, id string) (editTarget, error) {
	target := editTarget{UUID: id, Kind: "service"}
	var owner sql.NullString
	var active bool
	var updated, settings, libraries string
	err := tx.QueryRowContext(ctx, `SELECT a.server_id,coalesce(a.external_user_id,''),coalesce(a.external_username,''),a.is_active,a.updated_at,coalesce(a.allowed_library_ids,'[]'),coalesce(a.service_settings,'{}'),(SELECT user_uuid FROM service_links WHERE service_uuid=a.uuid AND link_kind='owner') FROM service_accounts a WHERE a.uuid=?`, id).Scan(&target.ServerID, &target.RemoteID, &target.Name, &active, &updated, &libraries, &settings, &owner)
	if err != nil {
		return target, err
	}
	source, err := scanServer(tx.QueryRowContext(ctx, serverSelect+" WHERE s.id=?", target.ServerID))
	if err != nil {
		return target, err
	}
	target.SourceRevision = source.Revision
	target.Fingerprint = editDigest([]any{target.ServerID, target.RemoteID, target.Name, active, updated, libraries, settings, owner, providerFingerprint(source), source.ConfigRevision})
	return target, nil
}

func editSourceBusy(ctx context.Context, tx *sql.Tx, server int64, except string) (bool, error) {
	var busy bool
	err := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM edit_source_locks WHERE (?=0 OR server_id=?) AND operation_id<>?)`, server, server, except).Scan(&busy)
	return busy, err
}

func loadEdit(ctx context.Context, tx *sql.Tx, id string) (editStored, error) {
	var out editStored
	var revision int64
	var payload, targets, results, warnings, effects string
	err := tx.QueryRowContext(ctx, `SELECT id,actor_uuid,access_hash,action,state,revision,role_revision,coalesce(operation_token,''),payload,targets,results,warnings,effects FROM edit_operations WHERE id=?`, id).Scan(&out.ID, &out.Actor, &out.AccessHash, &out.Action, &out.State, &revision, &out.Role, &out.Token, &payload, &targets, &results, &warnings, &effects)
	if errors.Is(err, sql.ErrNoRows) {
		return out, ErrNotFound
	}
	if err != nil {
		return out, err
	}
	out.Revision = strconv.FormatInt(revision, 10)
	for _, part := range []struct {
		raw string
		to  any
	}{{payload, &out.Operation}, {targets, &out.Targets}, {results, &out.Results}, {warnings, &out.Warnings}, {effects, &out.Effects}} {
		if err := json.Unmarshal([]byte(part.raw), part.to); err != nil {
			return out, err
		}
	}
	out.count()
	return out, nil
}

func (b *editStored) count() {
	b.Summary = map[string]int{"updated": 0, "deleted": 0, "unchanged": 0, "skipped": 0, "failed": 0, "unknown": 0, "pending": 0}
	for _, item := range b.Results {
		b.Summary[item.Outcome]++
	}
}

func saveEdit(ctx context.Context, tx *sql.Tx, b *editStored) error {
	results, _ := json.Marshal(b.Results)
	targets, _ := json.Marshal(b.Targets)
	result, err := tx.ExecContext(ctx, `UPDATE edit_operations SET results=?,targets=?,state=?,revision=revision+1,updated_at=? WHERE id=? AND revision=? AND coalesce(operation_token,'')=?`, string(results), string(targets), b.State, utcTimestamp(time.Now()), b.ID, b.Revision, b.Token)
	if err != nil {
		return err
	}
	if n, _ := result.RowsAffected(); n != 1 {
		return ErrConflict
	}
	rev, _ := strconv.ParseInt(b.Revision, 10, 64)
	b.Revision = strconv.FormatInt(rev+1, 10)
	b.count()
	return nil
}

func (a *App) readEditReceipt(w http.ResponseWriter, r *http.Request) {
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
	err = editAuthorityTx(r.Context(), tx, actor.UUID, bearer(r))
	var stored editStored
	if err == nil {
		stored, err = loadEdit(r.Context(), tx, r.PathValue("operation"))
	}
	if err == nil && stored.Actor != actor.UUID {
		err = ErrForbidden
	}
	if err != nil {
		domainError(w, err)
		return
	}
	respond(w, 200, stored.editReceipt)
}

func (a *App) prepareEdit(w http.ResponseWriter, r *http.Request) {
	ctx, done, admitted := a.startReviewOperation(w, r)
	if !admitted {
		return
	}
	defer done()
	r = r.WithContext(ctx)

	actor, ok := a.principal(w, r, true)
	if !ok {
		return
	}
	var input struct {
		RequestID string             `json:"request_id"`
		UUIDs     []string           `json:"user_uuids"`
		Operation editOperationInput `json:"operation"`
	}
	if !decodeStrictBody(w, r, &input) {
		return
	}
	if !validAdminMemberCursor(input.RequestID) || len(input.UUIDs) == 0 || len(input.UUIDs) > 500 || !validEditInput(input.Operation) {
		fail(w, 400, "INVALID_EDIT_OPERATION", "Choose a valid action, request identifier and 1–500 distinct users")
		return
	}
	seen := map[string]bool{}
	for _, id := range input.UUIDs {
		if !validAdminMemberCursor(id) || seen[id] {
			fail(w, 400, "INVALID_SELECTION", "Select each valid user once")
			return
		}
		seen[id] = true
	}
	slices.Sort(input.UUIDs)
	slices.Sort(input.Operation.LibraryIDs)
	hash := editDigest(input)
	tx, err := a.store.reader.BeginTx(r.Context(), &sql.TxOptions{ReadOnly: true})
	if err != nil {
		domainError(w, err)
		return
	}
	defer tx.Rollback()
	if err = editAuthorityTx(r.Context(), tx, actor.UUID, bearer(r)); err != nil {
		domainError(w, err)
		return
	}
	var existing, previous string
	err = tx.QueryRowContext(r.Context(), "SELECT id,request_hash FROM edit_operations WHERE actor_uuid=? AND request_id=?", actor.UUID, input.RequestID).Scan(&existing, &previous)
	if err == nil {
		if previous != hash {
			domainError(w, ErrConflict)
			return
		}
		stored, e := loadEdit(r.Context(), tx, existing)
		if e != nil {
			domainError(w, e)
			return
		}
		respond(w, 200, stored.editReceipt)
		return
	}
	if !errors.Is(err, sql.ErrNoRows) {
		domainError(w, err)
		return
	}
	stored := editStored{Actor: actor.UUID, AccessHash: tokenHash(bearer(r)), Operation: input.Operation}
	stored.ID = newUUID()
	stored.Action = input.Operation.Action
	stored.State = "prepared"
	stored.Revision = "1"
	stored.Results = []editUserResult{}
	stored.Targets = []editTarget{}
	stored.Warnings = []string{}
	stored.Effects = []string{}
	if err = tx.QueryRowContext(r.Context(), "SELECT revision FROM admin_role_state WHERE singleton=1").Scan(&stored.Role); err != nil {
		domainError(w, err)
		return
	}
	for _, id := range input.UUIDs {
		result := editUserResult{UUID: id, Outcome: "pending"}
		target := editTarget{UUID: id}
		err = tx.QueryRowContext(r.Context(), "SELECT kind FROM identities WHERE uuid=?", id).Scan(&target.Kind)
		if errors.Is(err, sql.ErrNoRows) {
			result.Outcome = "skipped"
			result.Reason = "not_found"
		} else if err != nil {
			domainError(w, err)
			return
		}
		if result.Outcome == "pending" {
			if target.Kind == "service" && (stored.Action == "delete_users" || stored.Action == "update_libraries") {
				if actor.Kind != "owner" {
					result.Outcome = "skipped"
					result.Reason = "owner_only"
				} else {
					target, err = editServiceTarget(r.Context(), tx, id)
					if err != nil {
						domainError(w, err)
						return
					}
					busy, e := servicePendingWork(r.Context(), tx, target.ServerID)
					if e != nil {
						domainError(w, e)
						return
					}
					if busy {
						result.Outcome = "skipped"
						result.Reason = "pending_work"
					}
					// Protect any linked MUM owner/administrator, even for owner callers.
					var protected bool
					err = tx.QueryRowContext(r.Context(), `SELECT EXISTS(SELECT 1 FROM service_links l JOIN user_accounts u ON u.uuid=l.user_uuid WHERE l.service_uuid=? AND (u.kind='owner' OR u.uuid=? OR EXISTS(SELECT 1 FROM admin_privileges WHERE user_uuid=u.uuid)))`, id, actor.UUID).Scan(&protected)
					if err != nil {
						domainError(w, err)
						return
					}
					if protected {
						result.Outcome = "skipped"
						result.Reason = "protected_account"
					}
				}
			} else if target.Kind != "service" && stored.Action == "update_libraries" {
				result.Outcome = "skipped"
				result.Reason = "service_only"
			} else {
				target.Local, err = prepareEditLocal(r.Context(), tx, actor.UUID, bearer(r), id, stored.Operation)
				if err != nil {
					result.Outcome = "skipped"
					result.Reason = "unavailable"
				} else if target.Local.Outcome == "skipped" || target.Local.Outcome == "unchanged" {
					result.Outcome = target.Local.Outcome
					result.Reason = target.Local.Reason
				}
			}
		}
		stored.Targets = append(stored.Targets, target)
		stored.Results = append(stored.Results, result)
	}
	if err = tx.Commit(); err != nil {
		domainError(w, err)
		return
	}
	// Provider inspection never runs while a SQLite transaction is held.
	for i := range stored.Targets {
		target := &stored.Targets[i]
		if stored.Results[i].Outcome != "pending" || target.ServerID == 0 {
			continue
		}
		source, e := a.loadServer(r.Context(), target.ServerID)
		if e != nil || !source.EffectiveActive || !source.HasAPIKey {
			stored.Results[i].Outcome = "skipped"
			stored.Results[i].Reason = "server_unavailable"
			continue
		}
		client, e := newServerConnection(ProviderConfig{source.Type, source.URL, source.apiKey}, a.ProviderHTTP)
		if e != nil {
			stored.Results[i].Outcome = "skipped"
			stored.Results[i].Reason = "unsupported"
			continue
		}
		provider := client
		provider.editAuthority = func(ctx context.Context) error {
			return a.editPreparedAuthority(ctx, stored.Actor, bearer(r), stored.Role, *target)
		}
		request, e := a.editProviderRequest(r.Context(), stored.Operation, *target)
		var snapshot editProviderSnapshot
		if e == nil {
			snapshot, e = provider.prepareEditUser(r.Context(), request)
		}
		if e != nil {
			// Module and transport errors never carry credentials or upstream text;
			// Plex share checks also name the check that failed.
			code, status := invitationFailureLog(e)
			a.logger.Warn("Edit operation could not read the account on its server", "server_id", target.ServerID, "provider", source.Type, "action", stored.Action, "error", e.Error(), "code", code, "upstream_status", status)
			stored.Results[i].Outcome = "skipped"
			stored.Results[i].Reason = "provider_inspection_failed"
			if errors.Is(e, errEditPlexDynamicAll) {
				stored.Results[i].Reason = "plex_dynamic_all_unsupported"
			}
			continue
		}
		target.RemoteRevision = snapshot.Revision
		target.Group = snapshot.Group
		target.PlexOwner = snapshot.PlexOwner
		target.PlexRecipient = snapshot.PlexRecipient
		if source.Type == "plex" && stored.Action == "delete_users" {
			stored.Warnings = append(stored.Warnings, "Plex deletion removes the friendship and can revoke shares on other configured or unconfigured servers. The Plex login is not deleted.")
		}
	}
	if err := a.prepareEditPlexImpacts(r.Context(), &stored, bearer(r)); err != nil {
		domainError(w, err)
		return
	}
	if stored.Action == "update_libraries" {
		stored.Effects = append(stored.Effects, "Replace each eligible service account's library access with the explicitly selected set; an empty subset never means all libraries.")
	}
	if stored.Action == "delete_users" {
		stored.Effects = append(stored.Effects, "Retire local MUM accounts and unlink their services. Delete selected service accounts remotely before removing their MUM records and play history. A failed deletion can leave remote access disabled; unknown outcomes require read-only reconciliation before further changes.")
	}
	if stored.Action == "set_expiration" || stored.Action == "extend_access" || stored.Action == "clear_expiration" {
		stored.Effects = append(stored.Effects, "Expiry is MUM policy. Changing a local account's expiry signs out its MUM sessions; it does not delete provider accounts.")
	}
	err = a.store.write(r.Context(), func(tx *sql.Tx) error {
		if err := editAuthorityTx(r.Context(), tx, stored.Actor, bearer(r)); err != nil {
			return err
		}
		var current int64
		if err := tx.QueryRowContext(r.Context(), "SELECT revision FROM admin_role_state WHERE singleton=1").Scan(&current); err != nil {
			return err
		}
		if current != stored.Role {
			return ErrConflict
		}
		// Do not permit a stale preparation to freeze an already changed identity.
		for i, target := range stored.Targets {
			if stored.Results[i].Outcome == "pending" {
				if err := checkEditTarget(r.Context(), tx, stored.Actor, bearer(r), stored.Operation, target); err != nil {
					return err
				}
			}
		}
		return insertEdit(r.Context(), tx, &stored, input.RequestID, hash)
	})
	if err != nil {
		domainError(w, err)
		return
	}
	stored.count()
	respond(w, 201, stored.editReceipt)
}

func insertEdit(ctx context.Context, tx *sql.Tx, b *editStored, request, hash string) error {
	payload, _ := json.Marshal(b.Operation)
	targets, _ := json.Marshal(b.Targets)
	results, _ := json.Marshal(b.Results)
	warnings, _ := json.Marshal(b.Warnings)
	effects, _ := json.Marshal(b.Effects)
	_, err := tx.ExecContext(ctx, `INSERT INTO edit_operations(id,actor_uuid,access_hash,request_id,request_hash,action,payload,targets,results,warnings,effects,state,role_revision,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,'prepared',?,?,?)`, b.ID, b.Actor, b.AccessHash, request, hash, b.Action, string(payload), string(targets), string(results), string(warnings), string(effects), b.Role, utcTimestamp(time.Now()), utcTimestamp(time.Now()))
	return err
}

func checkEditTarget(ctx context.Context, tx *sql.Tx, actor, access string, op editOperationInput, target editTarget) error {
	if target.ServerID != 0 {
		current, err := editServiceTarget(ctx, tx, target.UUID)
		if err != nil {
			return err
		}
		if current.Fingerprint != target.Fingerprint || current.SourceRevision != target.SourceRevision {
			return ErrConflict
		}
		if target.ImpactCatalogue != "" {
			catalogue, err := editPlexCatalogue(ctx, tx, target.RemoteID)
			if err != nil {
				return err
			}
			if catalogue != target.ImpactCatalogue {
				return ErrConflict
			}
		}
		for _, impact := range target.Impacts {
			if err := checkEditTarget(ctx, tx, actor, access, op, impact); err != nil {
				return err
			}
		}
		return nil
	}
	current, err := prepareEditLocal(ctx, tx, actor, access, target.UUID, op)
	if err != nil {
		return err
	}
	if current.Fingerprint != target.Local.Fingerprint {
		return ErrConflict
	}
	return nil
}

func (a *App) editPreparedAuthority(ctx context.Context, actor, access string, role int64, target editTarget) error {
	tx, err := a.store.reader.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := editAuthorityTx(ctx, tx, actor, access); err != nil {
		return err
	}
	var current int64
	if err := tx.QueryRowContext(ctx, "SELECT revision FROM admin_role_state WHERE singleton=1").Scan(&current); err != nil {
		return err
	}
	if current != role {
		return ErrForbidden
	}
	return checkEditTarget(ctx, tx, actor, access, editOperationInput{}, target)
}

func (a *App) editProviderRequest(ctx context.Context, op editOperationInput, target editTarget) (editProviderRequest, error) {
	out := editProviderRequest{Action: op.Action, ID: target.RemoteID, Name: target.Name, AllLibraries: op.HasAllLibraries, LibraryIDs: []string{}}
	if op.Action != "update_libraries" {
		return out, nil
	}
	tx, err := a.store.reader.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return out, err
	}
	defer tx.Rollback()
	out.LibraryIDs, err = resolveEditLibraryIDs(ctx, tx, target.ServerID, op.LibraryIDs)
	if err != nil {
		return out, err
	}

	return out, nil
}

func resolveEditLibraryIDs(ctx context.Context, tx *sql.Tx, server int64, ids []string) ([]string, error) {
	out := []string{}
	for _, id := range ids {
		rows, err := tx.QueryContext(ctx, `SELECT external_id FROM media_libraries WHERE server_id=? AND is_available=1 AND (external_id=? OR internal_id=?) LIMIT 2`, server, id, id)
		if err != nil {
			return nil, err
		}
		count := 0
		external := ""
		for rows.Next() {
			count++
			if err := rows.Scan(&external); err != nil {
				rows.Close()
				return nil, err
			}
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return nil, err
		}
		if count != 1 || slices.Contains(out, external) {
			return nil, ErrConflict
		}
		out = append(out, external)
	}
	return out, nil
}
