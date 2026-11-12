package main

import (
	"context"
	"database/sql"
	"errors"
	"net/http"
	"strconv"
	"time"
	"unicode/utf8"
)

type profileNoteCapabilities struct {
	EditNotes      bool `json:"edit_notes"`
	Activation     bool `json:"activation"`
	Expiry         bool `json:"expiry"`
	ProviderPolicy bool `json:"provider_policy"`
	Whitelist      bool `json:"whitelist"`
}
type profileNoteRecord struct {
	Actor        string                  `json:"actor_uuid"`
	Target       string                  `json:"user_uuid"`
	Kind         string                  `json:"user_type"`
	Notes        string                  `json:"notes"`
	NoteRevision string                  `json:"note_revision"`
	RoleRevision string                  `json:"role_revision"`
	LinkRevision string                  `json:"link_revision"`
	Capabilities profileNoteCapabilities `json:"capabilities"`
}

func validProfileNotes(notes string) bool {
	if len(notes) > 16384 || !utf8.ValidString(notes) {
		return false
	}
	for _, r := range notes {
		if r < 32 && r != '\n' && r != '\r' && r != '\t' || r == 127 {
			return false
		}
	}
	return true
}

func readProfileNotes(ctx context.Context, tx *sql.Tx, actor, access, target string) (profileNoteRecord, error) {
	out := profileNoteRecord{Actor: actor, Target: target}
	if !validAdminMemberCursor(target) {
		return out, ErrNotFound
	}
	if err := accountPreferenceAuthority(ctx, tx, actor, access); err != nil {
		return out, err
	}
	authority, err := readAdminRoleHierarchyActor(ctx, tx, actor)
	if err != nil {
		return out, err
	}
	var note, role, link int64
	err = tx.QueryRowContext(ctx, `SELECT i.kind,coalesce(u.notes,a.notes,''),n.revision FROM identities i
 JOIN profile_note_state n ON n.uuid=i.uuid LEFT JOIN user_accounts u ON u.uuid=i.uuid LEFT JOIN service_accounts a ON a.uuid=i.uuid
 WHERE i.uuid=? AND (u.uuid IS NOT NULL OR a.uuid IS NOT NULL)`, target).Scan(&out.Kind, &out.Notes, &note)
	if errors.Is(err, sql.ErrNoRows) {
		err = ErrNotFound
	}
	if err != nil {
		return out, err
	}
	if out.Kind == "service" {
		if !authority.Owner {
			var owner string
			if err = tx.QueryRowContext(ctx, "SELECT user_uuid FROM service_links WHERE service_uuid=? AND link_kind='owner'", target).Scan(&owner); errors.Is(err, sql.ErrNoRows) {
				err = ErrForbidden
			}
			if err == nil {
				err = accountLinkTargetAuthority(ctx, tx, actor, owner)
			}
		}
	} else {
		err = accountLinkTargetAuthority(ctx, tx, actor, target)
	}
	if err != nil {
		return out, err
	}
	if !validProfileNotes(out.Notes) {
		return out, ErrConflict
	}
	if err = tx.QueryRowContext(ctx, "SELECT revision FROM admin_role_state WHERE singleton=1").Scan(&role); err == nil {
		err = tx.QueryRowContext(ctx, "SELECT revision FROM account_link_state WHERE singleton=1").Scan(&link)
	}
	if err != nil {
		return out, err
	}
	out.NoteRevision = strconv.FormatInt(note, 10)
	out.RoleRevision = strconv.FormatInt(role, 10)
	out.LinkRevision = strconv.FormatInt(link, 10)
	out.Capabilities.EditNotes = true
	return out, nil
}

func (a *App) profileNotes(w http.ResponseWriter, r *http.Request) {
	actor, ok := a.principal(w, r, true)
	if !ok {
		return
	}
	if r.URL.RawQuery != "" {
		fail(w, 400, "INVALID_SELECTION", "Select one profile")
		return
	}
	if r.Method == http.MethodGet {
		tx, err := a.store.reader.BeginTx(r.Context(), &sql.TxOptions{ReadOnly: true})
		if err != nil {
			domainError(w, err)
			return
		}
		defer tx.Rollback()
		out, err := readProfileNotes(r.Context(), tx, actor.UUID, bearer(r), r.PathValue("user"))
		if err == nil {
			err = tx.Commit()
		}
		if err != nil {
			domainError(w, err)
			return
		}
		respond(w, 200, out)
		return
	}
	var input struct {
		Actor        string  `json:"expected_actor_uuid"`
		Target       string  `json:"expected_user_uuid"`
		NoteRevision string  `json:"note_revision"`
		RoleRevision string  `json:"role_revision"`
		LinkRevision string  `json:"link_revision"`
		Notes        *string `json:"notes"`
	}
	if !decodeStrictBody(w, r, &input) {
		return
	}
	if input.Notes == nil || !validProfileNotes(*input.Notes) {
		fail(w, 400, "INVALID_NOTES", "Notes must be valid text up to 16384 UTF-8 bytes")
		return
	}
	var out profileNoteRecord
	err := a.store.write(r.Context(), func(tx *sql.Tx) error {
		current, err := readProfileNotes(r.Context(), tx, actor.UUID, bearer(r), r.PathValue("user"))
		if err != nil {
			return err
		}
		if input.Actor != actor.UUID {
			return ErrForbidden
		}
		if input.Target != current.Target || input.NoteRevision != current.NoteRevision || input.RoleRevision != current.RoleRevision || input.LinkRevision != current.LinkRevision || *input.Notes == current.Notes {
			return ErrConflict
		}
		statement := "UPDATE user_accounts SET notes=?,updated_at=? WHERE uuid=?"
		if current.Kind == "service" {
			statement = "UPDATE service_accounts SET notes=?,updated_at=? WHERE uuid=?"
		}
		if _, err = tx.ExecContext(r.Context(), statement, *input.Notes, utcTimestamp(time.Now()), current.Target); err != nil {
			return err
		}
		if _, err = tx.ExecContext(r.Context(), `INSERT INTO audit_events(actor_uuid,action,details,occurred_at)
   VALUES(?,'profile.notes.save',json_object('target_uuid',?,'target_kind',?),?)`, actor.UUID, current.Target, current.Kind, utcTimestamp(time.Now())); err != nil {
			return err
		}
		out, err = readProfileNotes(r.Context(), tx, actor.UUID, bearer(r), current.Target)
		return err
	})
	if err != nil {
		domainError(w, err)
		return
	}
	respond(w, 200, out)
}
