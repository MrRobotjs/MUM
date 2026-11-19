package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"time"
)

// Deleting plays from a person's History tab: MUM's recorded plays and
// imported plays, in
// one transaction. Every play must belong to the person and none may still be
// playing, or nothing is deleted. Deleted plays are not remembered, so an
// import can bring them back.

const maxTimelineDelete = 500

var errPlayActive = errors.New("history play active")

// timelinePlayID splits a timeline item ID ("mum-12", "plex-34") into its
// source and row ID.
func timelinePlayID(id string) (string, int64, bool) {
	source, number, found := strings.Cut(id, "-")
	if !found || source != "mum" && !slices.Contains(importableHistory, source) {
		return "", 0, false
	}
	row, err := strconv.ParseInt(number, 10, 64)
	if err != nil || row < 1 || strconv.FormatInt(row, 10) != number {
		return "", 0, false
	}
	return source, row, true
}

func (a *App) deleteTimelinePlays(w http.ResponseWriter, r *http.Request) {
	actor, ok := a.principal(w, r, true)
	if !ok {
		return
	}
	target := r.PathValue("identity")
	var body struct {
		IDs []string `json:"ids"`
	}
	if !decodeStrictBody(w, r, &body) {
		return
	}
	type play struct {
		source string
		row    int64
	}
	plays := make([]play, 0, len(body.IDs))
	valid := validAdminMemberCursor(target) && len(body.IDs) >= 1 && len(body.IDs) <= maxTimelineDelete
	for i, id := range body.IDs {
		source, row, ok := timelinePlayID(id)
		if !valid || !ok || slices.Contains(body.IDs[:i], id) {
			valid = false
			break
		}
		plays = append(plays, play{source, row})
	}
	if !valid {
		fail(w, 400, "INVALID_HISTORY_DELETE", "Send 1 to 500 different play IDs from this person's history")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	q := activityReadQuery{History: true, All: true, Target: target}
	deleted := 0
	err := a.store.write(ctx, func(tx *sql.Tx) error {
		if err := requirePermission(ctx, tx, actor.UUID, "administrator"); err != nil {
			return err
		}
		if err := checkActivityTarget(ctx, tx, actor.UUID, q); err != nil {
			return err
		}
		mumFilter, mumArgs := mumPlayFilter(actor.UUID, q)
		importedFilter, importedArgs := importedPlayFilter(actor.UUID, q)
		for _, p := range plays {
			var mine, active bool
			var err error
			if p.source == "mum" {
				err = tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM media_activity_history h WHERE h.id=?`+mumFilter+`),EXISTS(SELECT 1 FROM media_activity_current WHERE history_id=?)`,
					append(append([]any{p.row}, mumArgs...), p.row)...).Scan(&mine, &active)
			} else {
				err = tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM history_imports i JOIN media_servers ms ON ms.id=i.server_id JOIN service_accounts s ON s.server_id=i.server_id AND s.external_user_id=i.account_id
				 WHERE i.rowid=? AND ms.service_type=?`+importedFilter+`)`, append([]any{p.row, p.source}, importedArgs...)...).Scan(&mine)
			}
			if err != nil {
				return err
			}
			if !mine {
				return ErrNotFound
			}
			if active {
				return errPlayActive
			}
		}
		for _, p := range plays {
			query := `DELETE FROM history_imports WHERE rowid=?`
			if p.source == "mum" {
				query = `DELETE FROM media_activity_history WHERE id=?`
			}
			if _, err := tx.ExecContext(ctx, query, p.row); err != nil {
				return err
			}
			deleted++
		}
		details, _ := json.Marshal(struct {
			Target  string `json:"target_uuid"`
			Deleted int    `json:"deleted"`
		}{target, deleted})
		_, err := tx.ExecContext(ctx, `INSERT INTO audit_events(actor_uuid,action,details,occurred_at) VALUES(?,'activity.history.delete',?,?)`, actor.UUID, string(details), utcTimestamp(time.Now()))
		return err
	})
	if errors.Is(err, errPlayActive) {
		fail(w, 409, "HISTORY_PLAY_ACTIVE", "A play that is still in progress can't be deleted.")
		return
	}
	if err != nil {
		domainError(w, err)
		return
	}
	respond(w, 200, map[string]any{"deleted": deleted})
}
