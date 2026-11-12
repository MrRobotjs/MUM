package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"time"
)

func (a *App) getInvitation(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.principal(w, r, true); !ok {
		return
	}
	id, ok := pathID(w, r, "invitation")
	if !ok {
		return
	}
	aead, _ := a.store.invitationAEAD(r.Context(), false)
	tx, err := a.store.reader.BeginTx(r.Context(), &sql.TxOptions{ReadOnly: true})
	if err != nil {
		domainError(w, err)
		return
	}
	defer tx.Rollback()
	item, err := scanInvitationRecord(tx.QueryRowContext(r.Context(), invitationRecordSelect+` WHERE i.id=? AND (i.archived_at IS NULL OR ?)`, id, includeArchivedInvitations(r)))
	if err == nil {
		item.withTokenPrefix(aead)
		item.Grants, err = loadInvitationGrants(r.Context(), tx, id)
	}
	if err == nil {
		err = tx.Commit()
	}
	if err != nil {
		domainError(w, err)
		return
	}
	respond(w, 200, item)
}

func (a *App) invitationShareLink(w http.ResponseWriter, r *http.Request) {
	p, ok := a.principal(w, r, true)
	if !ok {
		return
	}
	id, ok := pathID(w, r, "invitation")
	if !ok {
		return
	}
	var token string
	var customPath sql.NullString
	// Read the key before acquiring the SQLite writer; filesystem I/O is outside
	// the permission-check/decryption transaction.
	aead, err := a.store.invitationAEAD(r.Context(), false)
	if err != nil {
		fail(w, 409, "SHARE_KEY_UNAVAILABLE", "Restore the invitation key in the application data directory. Original issued links remain valid.")
		return
	}
	if err == nil {
		err = a.store.write(r.Context(), func(tx *sql.Tx) error {
			if err := requirePermission(r.Context(), tx, p.UUID, "administrator"); err != nil {
				return err
			}
			var digest string
			var encoded []byte
			if err := tx.QueryRowContext(r.Context(), `SELECT i.token,s.ciphertext,i.custom_path FROM invites i JOIN invitation_secrets s ON s.invite_id=i.id WHERE i.id=? AND i.archived_at IS NULL`, id).Scan(&digest, &encoded, &customPath); err != nil {
				return err
			}
			if len(encoded) < aead.NonceSize()+aead.Overhead() {
				return ErrConflict
			}
			plain, err := aead.Open(nil, encoded[:aead.NonceSize()], encoded[aead.NonceSize():], []byte("invitation.v1:"+digest))
			if err != nil {
				return ErrConflict
			}
			token = string(plain)
			if tokenHash(token) != digest {
				return ErrConflict
			}
			return auditAction(r.Context(), tx, p.UUID, "invitation.share_link.read")
		})
	}
	if err != nil {
		if errors.Is(err, ErrForbidden) {
			domainError(w, err)
		} else {
			fail(w, 409, "SHARE_LINK_UNAVAILABLE", "The stored share link is unavailable. Restore the matching key and database backup or issue a new invitation. Original issued links remain valid.")
		}
		return
	}
	// As in Flask, an invitation with a custom path is shared by that path.
	path := "/invite/" + token
	if customPath.Valid {
		path = "/invite/" + customPath.String
	}
	respond(w, 200, map[string]any{"id": id, "token": token, "path": path})
}

// resolveInvitationPath turns a custom invite path into the invitation's link
// code, so the invite wizard can use the normal code-based routes. Knowing the
// custom path already grants the same access as the code.
func (a *App) resolveInvitationPath(w http.ResponseWriter, r *http.Request) {
	path := r.PathValue("path")
	if !validInvitationPath(path) {
		fail(w, 404, "NOT_FOUND", "Invitation not found")
		return
	}
	var digest string
	var encoded []byte
	err := a.store.reader.QueryRowContext(r.Context(), `SELECT i.token,s.ciphertext FROM invites i JOIN invitation_secrets s ON s.invite_id=i.id WHERE i.custom_path=? AND i.archived_at IS NULL`, path).Scan(&digest, &encoded)
	if err != nil {
		fail(w, 404, "NOT_FOUND", "Invitation not found")
		return
	}
	token, err := a.store.openInvitationToken(r.Context(), digest, encoded)
	if err != nil {
		fail(w, 409, "SHARE_KEY_UNAVAILABLE", "This invitation link is unavailable")
		return
	}
	respond(w, 200, map[string]any{"token": token})
}

type invitationUpdate struct {
	Revision int64             `json:"revision"`
	Expires  *string           `json:"expires_at"`
	MaxUses  *int              `json:"max_uses"`
	Active   bool              `json:"is_active"`
	Grants   []InvitationGrant `json:"grants"`
	Discord  bool              `json:"require_discord_auth"`
	Guild    bool              `json:"require_discord_guild_membership"`
	Days     *int              `json:"membership_duration_days"`
}

func (a *App) updateInvitation(w http.ResponseWriter, r *http.Request) {
	p, ok := a.principal(w, r, true)
	if !ok {
		return
	}
	id, ok := pathID(w, r, "invitation")
	if !ok {
		return
	}
	var input invitationUpdate
	if !decodeStrictBody(w, r, &input) {
		return
	}
	expires, maxUses, days, valid := invitationOptions(input.Expires, input.MaxUses, input.Days)
	if !valid || input.Revision < 1 || len(input.Grants) < 1 || len(input.Grants) > 20 {
		fail(w, 400, "INVALID_INVITATION", "Provide the current revision, a future expiry (or none), a positive number of uses (or unlimited), 1–36500 membership days (or none) and 1–20 server grants")
		return
	}
	err := a.store.write(r.Context(), func(tx *sql.Tx) error {
		if err := requirePermission(r.Context(), tx, p.UUID, "administrator"); err != nil {
			return err
		}
		var revision int64
		var uses, reserved int
		if err := tx.QueryRowContext(r.Context(), `SELECT revision,current_uses,(SELECT count(*) FROM provisioning_jobs WHERE invite_id=i.id AND reservation_held=1) FROM invites i WHERE id=? AND archived_at IS NULL`, id).Scan(&revision, &uses, &reserved); err != nil {
			return err
		}
		if revision != input.Revision || reserved != 0 || maxUses != nil && maxUses.(int) < uses {
			return ErrConflict
		}
		if err := validateInvitationDiscord(r.Context(), tx, input.Discord, input.Guild); err != nil {
			return err
		}
		seen := map[int64]bool{}
		for _, g := range input.Grants {
			if seen[g.ServerID] {
				return ErrConflict
			}
			seen[g.ServerID] = true
			if _, err := validateInvitationGrant(r.Context(), tx, g); err != nil {
				return err
			}
		}
		if _, err := tx.ExecContext(r.Context(), "DELETE FROM invitation_grants WHERE invite_id=?", id); err != nil {
			return err
		}
		for _, g := range input.Grants {
			if g.LibraryIDs == nil {
				g.LibraryIDs = []string{}
			}
			ids, _ := json.Marshal(g.LibraryIDs)
			if _, err := tx.ExecContext(r.Context(), "INSERT INTO invitation_grants(invite_id,server_id,all_libraries,library_ids,allow_downloads) VALUES(?,?,?,?,?)", id, g.ServerID, g.AllLibraries, string(ids), g.AllowDownloads); err != nil {
				return err
			}
		}
		if _, err := tx.ExecContext(r.Context(), "UPDATE invites SET expires_at=?,max_uses=?,membership_duration_days=?,is_active=?,require_discord_auth=?,require_discord_guild_membership=?,revision=revision+1,updated_at=? WHERE id=?", expires, maxUses, days, input.Active, input.Discord, input.Guild, utcTimestamp(time.Now()), id); err != nil {
			return err
		}
		return auditAction(r.Context(), tx, p.UUID, "invitation.update")
	})
	if err != nil {
		invitationDiscordSettingError(w, err)
		return
	}
	respond(w, 200, map[string]any{"id": id, "revision": input.Revision + 1})
}

func (a *App) invitationBulkAction(w http.ResponseWriter, r *http.Request) {
	p, ok := a.principal(w, r, true)
	if !ok {
		return
	}
	var input struct {
		IDs    []int64 `json:"ids"`
		Action string  `json:"action"`
	}
	if !decodeStrictBody(w, r, &input) {
		return
	}
	if len(input.IDs) == 0 || len(input.IDs) > 1000 || (input.Action != "enable" && input.Action != "disable" && input.Action != "archive" && input.Action != "purge") {
		fail(w, 400, "INVALID_ACTION", "Choose enable, disable, archive or purge for 1–1000 invitations")
		return
	}
	if input.Action == "purge" {
		a.purgeInvitations(w, r, p, input.IDs)
		return
	}
	err := a.store.write(r.Context(), func(tx *sql.Tx) error {
		if err := requirePermission(r.Context(), tx, p.UUID, "administrator"); err != nil {
			return err
		}
		seen := map[int64]bool{}
		for _, id := range input.IDs {
			if id < 1 || seen[id] {
				return ErrConflict
			}
			seen[id] = true
			var expires sql.NullString
			var reserved int
			if err := tx.QueryRowContext(r.Context(), "SELECT expires_at,(SELECT count(*) FROM provisioning_jobs WHERE invite_id=i.id AND reservation_held=1) FROM invites i WHERE id=? AND archived_at IS NULL", id).Scan(&expires, &reserved); err != nil {
				return err
			}
			if input.Action == "enable" {
				if reserved > 0 {
					return ErrConflict
				}
				// An invitation without an expiry never expires.
				if expires.Valid {
					expiry, err := time.Parse(time.RFC3339Nano, expires.String)
					if err != nil || !expiry.After(time.Now()) {
						return ErrConflict
					}
				}
				grants, err := loadInvitationGrants(r.Context(), tx, id)
				if err != nil {
					return err
				}
				if len(grants) == 0 {
					return ErrConflict
				}
				for _, g := range grants {
					if _, err := validateInvitationGrant(r.Context(), tx, g); err != nil {
						return err
					}
				}
			}
			if err := applyInvitationAction(r.Context(), tx, id, input.Action); err != nil {
				return err
			}
		}
		return auditAction(r.Context(), tx, p.UUID, "invitation."+input.Action)
	})
	if err != nil {
		domainError(w, err)
		return
	}
	respond(w, 200, map[string]any{"affected": len(input.IDs), "action": input.Action})
}

func applyInvitationAction(ctx context.Context, tx *sql.Tx, id int64, action string) error {
	now := utcTimestamp(time.Now())
	query := "UPDATE invites SET is_active=0,revision=revision+1,updated_at=? WHERE id=?"
	if action == "enable" {
		query = "UPDATE invites SET is_active=1,revision=revision+1,updated_at=? WHERE id=?"
	}
	if action == "archive" {
		// Archiving releases the custom path for reuse; the old path stays visible.
		_, err := tx.ExecContext(ctx, "UPDATE invites SET is_active=0,archived_at=?,archived_custom_path=coalesce(custom_path,archived_custom_path),custom_path=NULL,revision=revision+1,updated_at=? WHERE id=?", now, now, id)
		return err
	}
	_, err := tx.ExecContext(ctx, query, now, id)
	return err
}

var (
	errInvitationNotArchived = errors.New("invitation is not archived")
	errInvitationInUse       = errors.New("invitation has sign-up work in progress")
)

// purgeInvitationSQL permanently removes an archived invitation and its
// history: sign-up jobs and their Plex/Discord proofs, usage records,
// notifications, grants and the sealed link code. Users and service accounts
// created through the invitation are kept; only their link to it is cleared.
// ?1 is the invitation id. TestPurgeInvitationCoversEveryReference keeps this
// list in step with the schema's foreign keys.
var purgeInvitationSQL = []string{
	"UPDATE user_accounts SET used_invite_id=NULL WHERE used_invite_id=?1",
	"UPDATE service_accounts SET used_invite_id=NULL WHERE used_invite_id=?1",
	"DELETE FROM plex_library_verifications WHERE job_id IN (SELECT id FROM provisioning_jobs WHERE invite_id=?1)",
	"DELETE FROM plex_job_completions WHERE job_id IN (SELECT id FROM provisioning_jobs WHERE invite_id=?1)",
	"DELETE FROM plex_share_checkpoints WHERE job_id IN (SELECT id FROM provisioning_jobs WHERE invite_id=?1)",
	"DELETE FROM plex_invitation_credentials WHERE job_id IN (SELECT id FROM provisioning_jobs WHERE invite_id=?1) OR proof_id IN (SELECT id FROM plex_invitation_authorizations WHERE invite_id=?1)",
	"DELETE FROM provisioning_steps WHERE job_id IN (SELECT id FROM provisioning_jobs WHERE invite_id=?1)",
	"DELETE FROM invitation_discord_proofs WHERE invite_id=?1 OR job_id IN (SELECT id FROM provisioning_jobs WHERE invite_id=?1)",
	"DELETE FROM provisioning_jobs WHERE invite_id=?1",
	"DELETE FROM plex_invitation_authorizations WHERE invite_id=?1",
	"DELETE FROM invite_servers WHERE invite_id=?1",
	"DELETE FROM invite_server_features WHERE invite_id=?1",
	"DELETE FROM invite_usages WHERE invite_id=?1",
	"DELETE FROM notifications WHERE invite_id=?1",
	"DELETE FROM invitation_grants WHERE invite_id=?1",
	"DELETE FROM invitation_secrets WHERE invite_id=?1",
	"DELETE FROM invites WHERE id=?1",
}

// purgeInvitations permanently deletes archived invitations, all or none. An
// invitation with a sign-up still running, a held reservation or a job waiting
// for review is refused so no in-flight or uncertain work loses its record.
func (a *App) purgeInvitations(w http.ResponseWriter, r *http.Request, p Principal, ids []int64) {
	err := a.store.write(r.Context(), func(tx *sql.Tx) error {
		if err := requirePermission(r.Context(), tx, p.UUID, "administrator"); err != nil {
			return err
		}
		seen := map[int64]bool{}
		for _, id := range ids {
			if id < 1 || seen[id] {
				return ErrConflict
			}
			seen[id] = true
			var archived, busy bool
			if err := tx.QueryRowContext(r.Context(), `SELECT archived_at IS NOT NULL,EXISTS(SELECT 1 FROM provisioning_jobs j WHERE j.invite_id=i.id AND (j.reservation_held=1 OR (j.resolution IS NULL AND (j.status IN ('pending','running') OR j.review_token IS NOT NULL)))) FROM invites i WHERE i.id=?`, id).Scan(&archived, &busy); err != nil {
				return err
			}
			if !archived {
				return errInvitationNotArchived
			}
			if busy {
				return errInvitationInUse
			}
			for _, query := range purgeInvitationSQL {
				if _, err := tx.ExecContext(r.Context(), query, id); err != nil {
					return err
				}
			}
		}
		return auditAdmin(r.Context(), tx, p.UUID, "invitation.purge", map[string]any{"invitation_ids": ids})
	})
	switch {
	case errors.Is(err, errInvitationNotArchived):
		fail(w, 409, "INVITATION_NOT_ARCHIVED", "Only archived invites can be permanently deleted. Delete (archive) the invite first.")
	case errors.Is(err, errInvitationInUse):
		fail(w, 409, "INVITATION_IN_USE", "An invite still has a sign-up in progress or waiting for review. Finish or cancel that job first.")
	case err != nil:
		domainError(w, err)
	default:
		respond(w, 200, map[string]any{"affected": len(ids), "action": "purge"})
	}
}
