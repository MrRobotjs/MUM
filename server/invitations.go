package main

import (
	"context"
	"crypto/cipher"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"net/mail"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// Expiry, maximum uses and membership duration are optional as in Flask:
// null means never expires, unlimited uses and permanent membership.
type invitationRecord struct {
	ID             int64             `json:"id"`
	Expires        *string           `json:"expires_at"`
	MaxUses        *int              `json:"max_uses"`
	Uses           int               `json:"current_uses"`
	Reserved       int               `json:"reserved_uses"`
	Active         bool              `json:"is_active"`
	Grants         []InvitationGrant `json:"grants"`
	Revision       int64             `json:"revision"`
	Created        string            `json:"created_at"`
	Discord        bool              `json:"require_discord_auth"`
	Guild          bool              `json:"require_discord_guild_membership"`
	CustomPath     *string           `json:"custom_path"`
	MembershipDays *int              `json:"membership_duration_days"`
	Archived       *string           `json:"archived_at"`
	// The first 12 characters of the link code, shown on the invite card as in
	// Flask. The full link is only returned by the audited share-link read.
	TokenPrefix string `json:"token_prefix,omitempty"`
	digest      string
	sealed      []byte
}

const invitationRecordSelect = `SELECT i.id,i.expires_at,i.max_uses,i.current_uses,i.is_active,(SELECT count(*) FROM provisioning_jobs j WHERE j.invite_id=i.id AND j.reservation_held=1),i.revision,i.created_at,coalesce(i.require_discord_auth,0),coalesce(i.require_discord_guild_membership,0),coalesce(i.custom_path,i.archived_custom_path),i.membership_duration_days,i.token,s.ciphertext,i.archived_at FROM invites i LEFT JOIN invitation_secrets s ON s.invite_id=i.id`

func includeArchivedInvitations(r *http.Request) bool {
	return r.URL.Query().Get("include_archived") == "1"
}

func scanInvitationRecord(row rowScanner) (invitationRecord, error) {
	var item invitationRecord
	var expires, path, archived sql.NullString
	var maxUses, days sql.NullInt64
	err := row.Scan(&item.ID, &expires, &maxUses, &item.Uses, &item.Active, &item.Reserved, &item.Revision, &item.Created, &item.Discord, &item.Guild, &path, &days, &item.digest, &item.sealed, &archived)
	if archived.Valid {
		item.Archived = &archived.String
	}
	if expires.Valid {
		item.Expires = &expires.String
	}
	if maxUses.Valid {
		n := int(maxUses.Int64)
		item.MaxUses = &n
	}
	if path.Valid {
		item.CustomPath = &path.String
	}
	if days.Valid {
		n := int(days.Int64)
		item.MembershipDays = &n
	}
	return item, err
}

// withTokenPrefix fills the card label from the sealed link code. Without the
// key file the card falls back to the invitation number.
func (item *invitationRecord) withTokenPrefix(aead cipher.AEAD) {
	if aead == nil || len(item.sealed) == 0 {
		return
	}
	if token, err := openInvitationTokenWith(aead, item.digest, item.sealed); err == nil && len(token) >= 12 {
		item.TokenPrefix = token[:12]
	}
}

func invitationLimit(n int) any {
	if n <= 0 {
		return nil
	}
	return n
}

var (
	errInvitationPathTaken = errors.New("custom path already in use")
	invitationPathPattern  = regexp.MustCompile(`^[A-Za-z0-9_-]{3,100}$`)
)

// invitationOptions validates the optional settings shared by create and edit.
// Empty expiry, zero/absent uses and zero/absent days mean "none" as in Flask.
func invitationOptions(expires *string, maxUses, days *int) (expiresAt, limit, membership any, ok bool) {
	if expires != nil && *expires != "" {
		at, err := time.Parse(time.RFC3339Nano, *expires)
		if err != nil || !at.After(time.Now()) {
			return nil, nil, nil, false
		}
		expiresAt = utcTimestamp(at)
	}
	if maxUses != nil && *maxUses != 0 {
		if *maxUses < 1 || *maxUses > 1000000 {
			return nil, nil, nil, false
		}
		limit = *maxUses
	}
	if days != nil && *days != 0 {
		if *days < 1 || *days > 36500 {
			return nil, nil, nil, false
		}
		membership = *days
	}
	return expiresAt, limit, membership, true
}

// validInvitationPath follows Flask's custom path rule (3–100 letters, digits,
// "-" or "_"). 43 characters is the generated link code's shape and is kept
// for codes so a link always resolves the same way.
func validInvitationPath(path string) bool {
	return invitationPathPattern.MatchString(path) && len(path) != 43
}

var errInviteUsernameUnavailable = errors.New("invitation username unavailable")

// Grants are validated inside the same transaction that creates/reserves work.
// No provider request is made while the SQLite writer is held.
func validateInvitationGrant(ctx context.Context, tx *sql.Tx, g InvitationGrant) (ManagedServer, error) {
	s, err := scanServer(tx.QueryRowContext(ctx, serverSelect+" WHERE s.id=?", g.ServerID))
	if err != nil {
		return s, err
	}
	if s.Type == "romm" && !validRomMInvitationGrant(g) {
		return s, ErrConflict
	}
	if s.Type == "kavita" {
		if _, err := kavitaLibraryIDs(g); err != nil {
			return s, err
		}
	}
	if !s.EffectiveActive || !supportsProvisioning(s.Type) || len(g.LibraryIDs) > 10000 || g.AllLibraries && len(g.LibraryIDs) != 0 || !g.AllLibraries && len(g.LibraryIDs) == 0 {
		return s, ErrConflict
	}
	seen := map[string]bool{}
	for _, id := range g.LibraryIDs {
		if id == "" || seen[id] {
			return s, ErrConflict
		}
		seen[id] = true
		var exists bool
		if err := tx.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM media_libraries WHERE server_id=? AND external_id=? AND is_available=1)", s.ID, id).Scan(&exists); err != nil {
			return s, err
		}
		if !exists {
			return s, ErrConflict
		}
	}
	return s, nil
}

func (a *App) createInvitation(w http.ResponseWriter, r *http.Request) {
	p, ok := a.principal(w, r, true)
	if !ok {
		return
	}
	var input struct {
		Expires    *string           `json:"expires_at"`
		MaxUses    *int              `json:"max_uses"`
		Grants     []InvitationGrant `json:"grants"`
		Active     *bool             `json:"is_active,omitempty"`
		Discord    bool              `json:"require_discord_auth"`
		Guild      bool              `json:"require_discord_guild_membership"`
		CustomPath *string           `json:"custom_path"`
		Days       *int              `json:"membership_duration_days"`
	}
	if !decodeStrictBody(w, r, &input) {
		return
	}
	expires, maxUses, days, valid := invitationOptions(input.Expires, input.MaxUses, input.Days)
	if !valid || len(input.Grants) == 0 || len(input.Grants) > 20 {
		fail(w, 400, "INVALID_INVITATION", "Use a future expiry (or none), a positive number of uses (or unlimited), 1–36500 membership days (or none) and 1–20 server grants")
		return
	}
	var customPath any
	if input.CustomPath != nil && *input.CustomPath != "" {
		if !validInvitationPath(*input.CustomPath) {
			fail(w, 400, "INVALID_CUSTOM_PATH", "Custom paths use 3–100 letters, numbers, - or _ (not exactly 43 characters)")
			return
		}
		customPath = *input.CustomPath
	}
	token := randomToken()
	sealed, err := a.store.sealInvitationToken(r.Context(), token)
	if err != nil {
		fail(w, 503, "SHARE_KEY_UNAVAILABLE", "Could not save the invitation share link; check the data-directory key")
		return
	}
	active := true
	if input.Active != nil {
		active = *input.Active
	}
	var id int64
	err = a.store.write(r.Context(), func(tx *sql.Tx) error {
		if err := requirePermission(r.Context(), tx, p.UUID, "administrator"); err != nil {
			return err
		}
		if err := validateInvitationDiscord(r.Context(), tx, input.Discord, input.Guild); err != nil {
			return err
		}
		seen := map[int64]bool{}
		for i, g := range input.Grants {
			if seen[g.ServerID] {
				return ErrConflict
			}
			seen[g.ServerID] = true
			if _, err := validateInvitationGrant(r.Context(), tx, g); err != nil {
				return err
			}
			if g.LibraryIDs == nil {
				input.Grants[i].LibraryIDs = []string{}
			}
		}
		if customPath != nil {
			var taken bool
			if err := tx.QueryRowContext(r.Context(), "SELECT EXISTS(SELECT 1 FROM invites WHERE custom_path=?)", customPath).Scan(&taken); err != nil {
				return err
			}
			if taken {
				return errInvitationPathTaken
			}
		}
		now := utcTimestamp(time.Now())
		result, err := tx.ExecContext(r.Context(), "INSERT INTO invites(token,expires_at,max_uses,created_by_owner_id,created_at,updated_at,is_active,require_discord_auth,require_discord_guild_membership,custom_path,membership_duration_days) VALUES(?,?,?,?,?,?,?,?,?,?,?)", tokenHash(token), expires, maxUses, p.ID, now, now, active, input.Discord, input.Guild, customPath, days)
		if err != nil {
			return err
		}
		id, err = result.LastInsertId()
		if err != nil {
			return err
		}
		if _, err := tx.ExecContext(r.Context(), "INSERT INTO invitation_secrets(invite_id,ciphertext) VALUES(?,?)", id, sealed); err != nil {
			return err
		}
		for _, g := range input.Grants {
			ids, _ := json.Marshal(g.LibraryIDs)
			if _, err := tx.ExecContext(r.Context(), "INSERT INTO invitation_grants(invite_id,server_id,all_libraries,library_ids,allow_downloads) VALUES(?,?,?,?,?)", id, g.ServerID, g.AllLibraries, string(ids), g.AllowDownloads); err != nil {
				return err
			}
		}
		return auditAction(r.Context(), tx, p.UUID, "invitation.create")
	})
	if errors.Is(err, errInvitationPathTaken) {
		fail(w, 409, "CUSTOM_PATH_TAKEN", "That custom path is already used by another invitation")
		return
	}
	if err != nil {
		invitationDiscordSettingError(w, err)
		return
	}
	respond(w, 201, map[string]any{"id": id, "revision": 1, "token": token, "require_discord_auth": input.Discord, "require_discord_guild_membership": input.Guild, "expires_at": expires, "max_uses": maxUses, "grants": input.Grants, "is_active": active, "custom_path": customPath, "membership_duration_days": days})
}

func (a *App) listInvitations(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.principal(w, r, true); !ok {
		return
	}
	before, ok := invitationCursor(w, r)
	if !ok {
		return
	}
	// The key file is read before the database transaction.
	aead, _ := a.store.invitationAEAD(r.Context(), false)
	tx, err := a.store.reader.BeginTx(r.Context(), &sql.TxOptions{ReadOnly: true})
	if err != nil {
		domainError(w, err)
		return
	}
	defer tx.Rollback()
	// Archived (deleted) invitations stay out unless asked for, so the Invites
	// page can show them under an "Archived" filter.
	rows, err := tx.QueryContext(r.Context(), invitationRecordSelect+` WHERE i.id<? AND (i.archived_at IS NULL OR ?) AND EXISTS(SELECT 1 FROM invitation_grants g WHERE g.invite_id=i.id) ORDER BY i.id DESC LIMIT 101`, before, includeArchivedInvitations(r))
	if err != nil {
		domainError(w, err)
		return
	}
	items := []invitationRecord{}
	for rows.Next() {
		var item invitationRecord
		if item, err = scanInvitationRecord(rows); err != nil {
			break
		}
		item.withTokenPrefix(aead)
		items = append(items, item)
	}
	err = errors.Join(err, rows.Err(), rows.Close())
	if err != nil {
		domainError(w, err)
		return
	}
	for i := range items {
		items[i].Grants, err = loadInvitationGrants(r.Context(), tx, items[i].ID)
		if err != nil {
			domainError(w, err)
			return
		}
	}
	if err := tx.Commit(); err != nil {
		domainError(w, err)
		return
	}
	var next any
	if len(items) > 100 {
		items = items[:100]
		next = items[99].ID
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"data": items, "meta": map[string]any{"next_before": next}})
}

func invitationCursor(w http.ResponseWriter, r *http.Request) (int64, bool) {
	before := int64(1<<63 - 1)
	if raw := r.URL.Query().Get("before"); raw != "" {
		value, err := strconv.ParseInt(raw, 10, 64)
		if err != nil || value < 1 {
			fail(w, 400, "INVALID_CURSOR", "before must be a positive numeric cursor")
			return 0, false
		}
		before = value
	}
	return before, true
}

type grantQuerier interface {
	QueryContext(context.Context, string, ...any) (*sql.Rows, error)
}

func loadInvitationGrants(ctx context.Context, q grantQuerier, id int64) ([]InvitationGrant, error) {
	rows, err := q.QueryContext(ctx, "SELECT server_id,all_libraries,library_ids,allow_downloads FROM invitation_grants WHERE invite_id=? ORDER BY server_id", id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	grants := []InvitationGrant{}
	for rows.Next() {
		var g InvitationGrant
		var ids string
		if err := rows.Scan(&g.ServerID, &g.AllLibraries, &ids, &g.AllowDownloads); err != nil {
			return nil, err
		}
		if err := json.Unmarshal([]byte(ids), &g.LibraryIDs); err != nil {
			return nil, err
		}
		grants = append(grants, g)
	}
	return grants, rows.Err()
}

func (a *App) revokeInvitation(w http.ResponseWriter, r *http.Request) {
	p, ok := a.principal(w, r, true)
	if !ok {
		return
	}
	id, ok := pathID(w, r, "invitation")
	if !ok {
		return
	}
	err := a.store.write(r.Context(), func(tx *sql.Tx) error {
		if err := requirePermission(r.Context(), tx, p.UUID, "administrator"); err != nil {
			return err
		}
		result, err := tx.ExecContext(r.Context(), "UPDATE invites SET is_active=0,revision=revision+1,updated_at=? WHERE id=? AND archived_at IS NULL", utcTimestamp(time.Now()), id)
		if err != nil {
			return err
		}
		count, _ := result.RowsAffected()
		if count == 0 {
			return ErrNotFound
		}
		return auditAction(r.Context(), tx, p.UUID, "invitation.revoke")
	})
	if err != nil {
		domainError(w, err)
		return
	}
	respond(w, 200, map[string]bool{"revoked": true})
}

func (a *App) publicInvitation(w http.ResponseWriter, r *http.Request) {
	var id int64
	var expires string
	var available bool
	var maxUses, uses, reserved int
	var revision int64
	var requireDiscord, requireGuild bool
	err := a.store.reader.QueryRowContext(r.Context(), `SELECT i.id,coalesce(i.expires_at,''),i.is_active=1 AND (i.expires_at IS NULL OR julianday(i.expires_at)>julianday('now')) AND i.current_uses+(SELECT count(*) FROM provisioning_jobs j WHERE j.invite_id=i.id AND j.reservation_held=1)<coalesce(i.max_uses,9223372036854775807),coalesce(i.max_uses,0),i.current_uses,(SELECT count(*) FROM provisioning_jobs j WHERE j.invite_id=i.id AND j.reservation_held=1),i.revision,coalesce(i.require_discord_auth,0),coalesce(i.require_discord_guild_membership,0) FROM invites i WHERE token=?`, tokenHash(r.PathValue("token"))).Scan(&id, &expires, &available, &maxUses, &uses, &reserved, &revision, &requireDiscord, &requireGuild)
	if err != nil {
		domainError(w, err)
		return
	}
	if !available {
		fail(w, 410, "INVITATION_UNAVAILABLE", "Invitation is expired, revoked or fully reserved")
		return
	}
	grants, err := loadInvitationGrants(r.Context(), a.store.reader, id)
	if err != nil {
		domainError(w, err)
		return
	}
	servers := []map[string]any{}
	for _, g := range grants {
		s, err := a.loadServer(r.Context(), g.ServerID)
		if err != nil {
			domainError(w, err)
			return
		}
		if !s.EffectiveActive || !supportsProvisioning(s.Type) {
			fail(w, 409, "SERVER_UNAVAILABLE", "An invited server is unavailable")
			return
		}
		rows, err := a.store.reader.QueryContext(r.Context(), "SELECT external_id,name FROM media_libraries WHERE server_id=? AND is_available=1 ORDER BY id", s.ID)
		if err != nil {
			domainError(w, err)
			return
		}
		libraries := []map[string]string{}
		selected := map[string]bool{}
		for _, id := range g.LibraryIDs {
			selected[id] = true
		}
		for rows.Next() {
			var external, name string
			if err = rows.Scan(&external, &name); err != nil {
				break
			}
			if g.AllLibraries || selected[external] {
				libraries = append(libraries, map[string]string{"id": external, "name": name})
				delete(selected, external)
			}
		}
		err = errors.Join(err, rows.Err(), rows.Close())
		if err != nil {
			domainError(w, err)
			return
		}
		if len(selected) != 0 {
			fail(w, 409, "LIBRARY_UNAVAILABLE", "An invited library is unavailable")
			return
		}
		servers = append(servers, map[string]any{"id": s.ID, "name": s.Name, "provider": s.Type, "access_url": s.PublicURL, "libraries": libraries})
	}
	discord := map[string]any{"required": requireDiscord, "requires_guild": requireGuild, "available": false, "invite_url": nil}
	if requireDiscord {
		settings, err := readDiscordSettings(r.Context(), a.store.reader)
		if err != nil {
			domainError(w, err)
			return
		}
		discord["available"] = discordReady(settings) && a.discordRedirect(r.Context(), settings) != "" && (!requireGuild || settings.GuildID != "")
		if requireGuild && settings.InviteURL != "" {
			discord["invite_url"] = settings.InviteURL
		}
	}
	respond(w, 200, map[string]any{"id": id, "revision": revision, "expires_at": nullableText(expires), "max_uses": invitationLimit(maxUses), "current_uses": uses, "reserved_uses": reserved, "servers": servers, "grants": grants, "discord": discord})
}

type redemptionInput struct {
	PlexAuthorizationID  string                  `json:"plex_authorization_id,omitempty"`
	RequestID            string                  `json:"request_id"`
	Username             string                  `json:"username"`
	Password             string                  `json:"password"`
	Email                string                  `json:"email,omitempty"`
	ServerCredentials    []redemptionCredentials `json:"server_credentials,omitempty"`
	InvitationRevision   *int64                  `json:"invitation_revision,omitempty"`
	DiscordAuthorization string                  `json:"discord_authorization_id,omitempty"`
}

type redemptionCredentials struct {
	ServerID int64  `json:"server_id"`
	Username string `json:"username"`
	Password string `json:"password"`
}
type redemptionStep struct {
	Plex              *plexShareReceipt `json:"plex,omitempty"`
	PasswordASCIIOnly bool              `json:"password_ascii_only"`
	CleanupScope      string            `json:"cleanup_scope"`
	PasswordMaxBytes  int               `json:"password_max_bytes"`
	ServerID          int64             `json:"server_id"`
	Status            string            `json:"status"`
	Stage             string            `json:"stage"`
	RemoteID          string            `json:"remote_id,omitempty"`
	Error             string            `json:"error_code,omitempty"`
	RemoteName        string            `json:"remote_username,omitempty"`
	Cleanup           string            `json:"cleanup_state"`
	CleanupError      string            `json:"cleanup_error_code,omitempty"`
	CheckedAt         string            `json:"cleanup_checked_at,omitempty"`
	ManualRequired    bool              `json:"manual_resolution_required"`
	ManualAllowed     bool              `json:"manual_resolution_allowed"`
	ResumeState       string            `json:"resume_state"`
	ResumeError       string            `json:"resume_error_code,omitempty"`
}
type redemptionJob struct {
	Plex            *plexJobProgress `json:"plex_progress,omitempty"`
	ID              string           `json:"id"`
	Status          string           `json:"status"`
	Error           string           `json:"error_code,omitempty"`
	UserUUID        string           `json:"user_uuid"`
	Steps           []redemptionStep `json:"steps"`
	Revision        int64            `json:"revision"`
	InviteID        int64            `json:"invite_id"`
	Reserved        bool             `json:"reservation_held"`
	Reviewing       bool             `json:"review_in_progress"`
	ReviewError     string           `json:"review_error_code,omitempty"`
	ResumeAvailable bool             `json:"resume_available"`
}

func (a *App) loadRedemption(ctx context.Context, id string) (redemptionJob, error) {
	j := redemptionJob{ID: id, Steps: []redemptionStep{}}
	tx, err := a.store.reader.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return j, err
	}
	defer tx.Rollback()
	if err := tx.QueryRowContext(ctx, "SELECT CASE WHEN resolution='cancelled' THEN 'cancelled' ELSE status END,user_uuid,coalesce(error_code,''),revision,invite_id,reservation_held,review_token IS NOT NULL,coalesce(review_error_code,'') FROM provisioning_jobs WHERE id=?", id).Scan(&j.Status, &j.UserUUID, &j.Error, &j.Revision, &j.InviteID, &j.Reserved, &j.Reviewing, &j.ReviewError); err != nil {
		return j, err
	}
	rows, err := tx.QueryContext(ctx, "SELECT server_id,status,stage,coalesce(remote_id,''),coalesce(error_code,''),coalesce(remote_username,''),cleanup_state,coalesce(cleanup_error_code,''),coalesce(cleanup_checked_at,''),resume_state,coalesce(resume_error_code,'') FROM provisioning_steps WHERE job_id=? ORDER BY server_id", id)
	if err != nil {
		return j, err
	}
	defer rows.Close()
	for rows.Next() {
		var s redemptionStep
		if err := rows.Scan(&s.ServerID, &s.Status, &s.Stage, &s.RemoteID, &s.Error, &s.RemoteName, &s.Cleanup, &s.CleanupError, &s.CheckedAt, &s.ResumeState, &s.ResumeError); err != nil {
			return j, err
		}
		j.Steps = append(j.Steps, s)
	}
	if err := errors.Join(rows.Err(), rows.Close()); err != nil {
		return j, err
	}
	receipts, err := readPlexShareReceipts(ctx, tx, []string{id})
	if err != nil {
		return j, err
	}
	if err := attachPlexJobReceipts(&j, receipts); err != nil {
		return j, err
	}
	return j, tx.Commit()
}

func (a *App) redeemInvitation(w http.ResponseWriter, r *http.Request) {
	a.provisionMu.Lock()
	if a.provisionClosing {
		a.provisionMu.Unlock()
		fail(w, 503, "SHUTTING_DOWN", "Provisioning is shutting down")
		return
	}
	a.provisionWG.Add(1)
	a.provisionMu.Unlock()
	defer a.provisionWG.Done()
	var input redemptionInput
	if !decodeStrictBody(w, r, &input) {
		return
	}
	input.Username = strings.TrimSpace(input.Username)
	if input.InvitationRevision != nil && *input.InvitationRevision < 1 {
		fail(w, 400, "INVALID_REVISION", "Provide a positive invitation revision")
		return
	}
	if len(input.RequestID) < 32 || len(input.RequestID) > 128 || len(input.Username) == 0 || len(input.Username) > 255 || len(input.Password) < 12 || len(input.Password) > 1024 {
		fail(w, 400, "INVALID_REDEMPTION", "Provide a random request_id, username and a password of 12–1024 bytes")
		return
	}
	input.Email = strings.TrimSpace(input.Email)
	if input.Email != "" {
		address, err := mail.ParseAddress(input.Email)
		if err != nil || address.Address != input.Email || len(input.Email) > 320 {
			fail(w, 400, "INVALID_EMAIL", "Provide a valid email address")
			return
		}
	}
	credentials := map[int64]redemptionCredentials{}
	if len(input.ServerCredentials) > 20 {
		fail(w, 400, "INVALID_CREDENTIALS", "Too many server credentials")
		return
	}
	for _, c := range input.ServerCredentials {
		c.Username = strings.TrimSpace(c.Username)
		if _, duplicate := credentials[c.ServerID]; duplicate || c.ServerID < 1 || c.Username == "" || len(c.Username) > 255 || len(c.Password) < 12 || len(c.Password) > 1024 {
			fail(w, 400, "INVALID_CREDENTIALS", "Provide unique servers, usernames and passwords of 12–1024 bytes")
			return
		}
		credentials[c.ServerID] = c
	}
	if !a.passwordAdmission(w, r) {
		return
	}
	defer func() { <-a.passwordSlots }()
	// Bound remote provisioning independently from login hashing admission.
	select {
	case a.provisionSlots <- struct{}{}:
		defer func() { <-a.provisionSlots }()
	default:
		fail(w, 503, "PROVISIONING_BUSY", "Provisioning capacity is busy; retry with the same request_id")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()
	stopShutdownCancellation := context.AfterFunc(a.provisionCtx, cancel)
	defer stopShutdownCancellation()
	var existingID, existingName, existingHash string
	err := a.store.reader.QueryRowContext(ctx, `SELECT j.id,coalesce(j.requested_username,u.local_username,''),u.password_hash FROM provisioning_jobs j JOIN invites i ON i.id=j.invite_id JOIN user_accounts u ON u.uuid=j.user_uuid WHERE i.token=? AND j.request_hash=?`, tokenHash(r.PathValue("token")), tokenHash(input.RequestID)).Scan(&existingID, &existingName, &existingHash)
	if err == nil {
		if !strings.EqualFold(existingName, input.Username) || !verifyPassword(existingHash, input.Password) {
			fail(w, 409, "REQUEST_CONFLICT", "Request ID already belongs to another redemption")
			return
		}
		job, err := a.loadRedemption(ctx, existingID)
		if err != nil {
			domainError(w, err)
			return
		}
		respond(w, 200, publicRedemption(job))
		return
	}
	if !errors.Is(err, sql.ErrNoRows) {
		domainError(w, err)
		return
	}
	// Plex invitations are redeemed with the invitee's confirmed Plex sign-in,
	// bound to this browser by its HttpOnly cookie.
	plexBrowser := ""
	if input.PlexAuthorizationID != "" {
		if cookie, err := r.Cookie(plexInvitationCookieName(input.PlexAuthorizationID)); err == nil {
			plexBrowser = cookie.Value
		}
	}
	hash, err := hashPassword(input.Password)
	if err != nil {
		fail(w, 400, "INVALID_PASSWORD", "Invalid password")
		return
	}
	jobID, userUUID := newUUID(), newUUID()
	var identity discordIdentity
	discordCookie := ""
	if cookie, err := r.Cookie(discordInviteCookie); err == nil {
		discordCookie = cookie.Value
	}
	var inviteID int64
	var grants []InvitationGrant
	var plexAccount, plexUsername string
	servers := map[int64]ManagedServer{}
	err = a.store.write(ctx, func(tx *sql.Tx) error {
		if busy, err := bulkSourceBusy(ctx, tx, 0, ""); err != nil {
			return err
		} else if busy {
			return ErrConflict
		}
		var valid bool
		var revision int64
		if err := tx.QueryRowContext(ctx, `SELECT i.id,i.is_active=1 AND (i.expires_at IS NULL OR julianday(i.expires_at)>julianday('now')) AND i.current_uses+(SELECT count(*) FROM provisioning_jobs j WHERE j.invite_id=i.id AND j.reservation_held=1)<coalesce(i.max_uses,9223372036854775807),i.revision FROM invites i WHERE token=?`, tokenHash(r.PathValue("token"))).Scan(&inviteID, &valid, &revision); err != nil {
			return err
		}
		if !valid {
			return ErrConflict
		}
		if input.InvitationRevision != nil && *input.InvitationRevision != revision {
			return ErrConflict
		}
		invite, err := readDiscordInvite(ctx, tx, tokenHash(r.PathValue("token")))
		if err != nil {
			return err
		}
		switch {
		case invite.RequireAuth:
			if identity, err = checkDiscordProof(ctx, tx, invite, input.DiscordAuthorization, discordCookie); err != nil {
				return err
			}
		case input.DiscordAuthorization != "":
			return errDiscordRequired
		}
		var duplicate bool
		if err := tx.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM provisioning_jobs WHERE invite_id=? AND request_hash=?)", inviteID, tokenHash(input.RequestID)).Scan(&duplicate); err != nil {
			return err
		}
		if duplicate {
			return ErrConflict
		}
		if err := tx.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM user_accounts WHERE local_username=?)", input.Username).Scan(&duplicate); err != nil {
			return err
		}
		if duplicate {
			return errInviteUsernameUnavailable
		}
		grants, err = loadInvitationGrants(ctx, tx, inviteID)
		if err != nil {
			return err
		}
		if len(grants) == 0 {
			return ErrConflict
		}
		for _, g := range grants {
			s, err := validateInvitationGrant(ctx, tx, g)
			if err != nil {
				return err
			}
			if s.Type == "kavita" {
				c := credentials[s.ID]
				if c.Username == "" {
					c = redemptionCredentials{ServerID: s.ID, Username: input.Username, Password: input.Password}
				}
				if strings.Contains(c.Username, "@") || len(c.Password) > 256 {
					return errKavitaCredentials
				}
			}
			if s.Type == "audiobookshelf" {
				c := credentials[s.ID]
				if c.Username == "" {
					c = redemptionCredentials{ServerID: s.ID, Username: input.Username, Password: input.Password}
				}
				if len(c.Password) > 72 {
					return errABSCredentials
				}
			}
			if s.Type == "romm" {
				c := credentials[s.ID]
				if c.Username == "" {
					c = redemptionCredentials{ServerID: s.ID, Username: input.Username, Password: input.Password}
				}
				if !validRomMCredentials(c.Username, c.Password) {
					return errRomMCredentials
				}
			}
			if s.Type == "plex" {
				if _, typed := credentials[s.ID]; typed {
					return ErrConflict
				}
				if input.PlexAuthorizationID == "" {
					return errPlexAuthRequired
				}
			}
			if s.Type == "komga" {
				c := credentials[s.ID]
				if c.Username == "" {
					c = redemptionCredentials{ServerID: s.ID, Username: input.Username, Password: input.Password}
				}
				if !validKomgaEmail(c.Username) || len(c.Password) > 72 {
					return errKomgaCredentials
				}
			}
			servers[s.ID] = s
		}
		for id := range credentials {
			if _, invited := servers[id]; !invited {
				return ErrConflict
			}
		}
		now := utcTimestamp(time.Now())
		if _, err := tx.ExecContext(ctx, "INSERT INTO identities(uuid,kind) VALUES(?,'local')", userUUID); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO user_accounts(uuid,kind,local_username,password_hash,email,is_active,used_invite_id,created_at,updated_at,discord_user_id,discord_username,discord_avatar_hash) VALUES(?,'local',?,?,nullif(?,''),0,?,?,?,nullif(?,''),nullif(?,''),nullif(?,''))`, userUUID, input.Username, hash, input.Email, inviteID, now, now, identity.ID, identity.Username, identity.Avatar); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, "INSERT INTO provisioning_jobs(id,invite_id,user_uuid,status,created_at,updated_at,request_hash,reservation_held,requested_username) VALUES(?,?,?,'running',?,?,?,1,?)", jobID, inviteID, userUUID, now, now, tokenHash(input.RequestID), input.Username); err != nil {
			return err
		}
		for _, g := range grants {
			snapshot, _ := json.Marshal(g)
			remoteName := input.Username
			if custom, ok := credentials[g.ServerID]; ok {
				remoteName = custom.Username
			}
			if _, err := tx.ExecContext(ctx, "INSERT INTO provisioning_steps(job_id,server_id,status,grant_snapshot,server_revision,remote_username,provider_fingerprint) VALUES(?,?,'pending',?,?,?,?)", jobID, g.ServerID, string(snapshot), servers[g.ServerID].Revision, remoteName, providerFingerprint(servers[g.ServerID])); err != nil {
				return err
			}
		}
		if invite.RequireAuth {
			if err := consumeDiscordProof(ctx, tx, input.DiscordAuthorization, jobID); err != nil {
				return err
			}
		}
		for _, s := range servers {
			if s.Type != "plex" {
				continue
			}
			if plexAccount == "" {
				if plexAccount, plexUsername, err = consumePlexInvitationShareProof(ctx, tx, tokenHash(r.PathValue("token")), input.PlexAuthorizationID, plexBrowser, inviteID, jobID); err != nil {
					return err
				}
			}
			owned, err := plexAccountOwnedByOther(ctx, tx, s.ID, plexAccount)
			if err != nil {
				return err
			}
			if owned {
				return errPlexAccountOwned
			}
			// The verified Plex identity is recorded before any request to Plex.
			if _, err := tx.ExecContext(ctx, "UPDATE provisioning_steps SET remote_id=?,remote_username=? WHERE job_id=? AND server_id=?", plexAccount, plexUsername, jobID, s.ID); err != nil {
				return err
			}
		}
		return auditAction(ctx, tx, "", "invitation.reserve")
	})
	if err != nil {
		if errors.Is(err, errRomMCredentials) {
			fail(w, 400, "INVALID_ROMM_CREDENTIALS", errRomMCredentials.Error())
			return
		}
		if errors.Is(err, errKomgaCredentials) {
			fail(w, 400, "INVALID_KOMGA_CREDENTIALS", errKomgaCredentials.Error())
			return
		}
		if errors.Is(err, errABSCredentials) {
			fail(w, 400, "INVALID_AUDIOBOOKSHELF_CREDENTIALS", errABSCredentials.Error())
			return
		}
		if errors.Is(err, errKavitaCredentials) {
			fail(w, 400, "INVALID_KAVITA_CREDENTIALS", errKavitaCredentials.Error())
			return
		}
		if errors.Is(err, errInviteUsernameUnavailable) {
			fail(w, 409, "USERNAME_UNAVAILABLE", "That local username is already in use. No provisioning job was created.")
			return
		}
		if errors.Is(err, errDiscordRequired) {
			fail(w, 400, "DISCORD_AUTH_REQUIRED", "Sign in with Discord for this invitation first. No provisioning job was created.")
			return
		}
		if errors.Is(err, errPlexAuthRequired) {
			fail(w, 400, "PLEX_AUTH_REQUIRED", "Sign in with Plex for this invitation first. No provisioning job was created.")
			return
		}
		if errors.Is(err, errPlexAccountOwned) {
			fail(w, 409, "PLEX_ACCOUNT_IN_USE", "That Plex account already belongs to another user. No provisioning job was created.")
			return
		}
		if errors.Is(err, errDiscordInUse) {
			fail(w, 400, "DISCORD_ACCOUNT_IN_USE", "That Discord account is already linked to another profile. No provisioning job was created.")
			return
		}
		domainError(w, err)
		return
	}
	for _, g := range grants {
		s := servers[g.ServerID]
		c, custom := credentials[s.ID]
		if !custom {
			c = redemptionCredentials{ServerID: s.ID, Username: input.Username, Password: input.Password}
		}
		provider, providerErr := newMediaProvider(ProviderConfig{s.Type, s.URL, s.apiKey}, a.ProviderHTTP)
		if providerErr != nil {
			err = providerErr
			break
		}
		if s.Type == "plex" {
			var accepted bool
			accepted, err = provider.(*jsonProvider).sharePlexInvitation(ctx, plexAccount, plexUsername, g, func(stage, remoteID string) error {
				return a.provisionCheckpoint(ctx, jobID, inviteID, s, stage, remoteID)
			})
			if err != nil {
				break
			}
			if err = a.commitPlexInvitationStep(ctx, jobID, userUUID, inviteID, s, g, plexUsername, accepted); err != nil {
				break
			}
			continue
		}
		err = provider.(*jsonProvider).provisionUser(ctx, c.Username, c.Password, g, func(stage, remoteID string) error {
			return a.provisionCheckpoint(ctx, jobID, inviteID, s, stage, remoteID)
		})
		if err != nil {
			break
		}
		if err = a.commitProvisionedStep(ctx, jobID, userUUID, inviteID, s, g, c.Username); err != nil {
			break
		}
	}
	if err == nil {
		err = a.completeRedemption(ctx, jobID, userUUID, inviteID, servers)
	}
	if err != nil {
		code, status := invitationFailureLog(err)
		a.logger.Warn("Invitation provisioning failed; administrator review required", "job", jobID, "invite_id", inviteID, "code", code, "upstream_status", status)
		if saveErr := a.failRedemption(jobID, "REVIEW_REQUIRED"); saveErr != nil {
			fail(w, 503, "JOB_STATE_UNCERTAIN", "Provisioning state could not be saved; administrator review is required")
			return
		}
	}
	job, err := a.loadRedemption(r.Context(), jobID)
	if err != nil {
		domainError(w, err)
		return
	}
	respond(w, 201, publicRedemption(job))
}

func (a *App) StopProvisioning() {
	a.provisionMu.Lock()
	a.provisionClosing = true
	a.provisionCancel()
	a.provisionMu.Unlock()
}

// Call after stopping admission, before closing the Store. Failure checkpoints
// finish against an open writer even when HTTP shutdown cancels the request.
func (a *App) CloseProvisioning() { a.StopProvisioning(); a.provisionWG.Wait() }

// Public receipts expose progress, never remote identities or local profile IDs.
func publicRedemption(j redemptionJob) map[string]any {
	steps := []map[string]any{}
	for _, s := range j.Steps {
		step := map[string]any{"server_id": s.ServerID, "status": s.Status, "stage": s.Stage, "error_code": s.Error}
		if s.Plex != nil {
			step["plex"] = s.Plex
		}
		steps = append(steps, step)
	}
	review := j.Status == "failed"
	if j.Plex != nil {
		review = review || j.Plex.RequiresReview
	}
	result := map[string]any{"id": j.ID, "status": j.Status, "error_code": j.Error, "steps": steps, "requires_review": review}
	if j.Plex != nil {
		result["plex_progress"] = j.Plex
	}
	return result
}

func provisionStillAllowed(ctx context.Context, tx *sql.Tx, inviteID int64, s ManagedServer) error {
	var valid bool
	err := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM invites i JOIN media_servers s ON s.id=? JOIN provider_settings p ON p.provider_id=s.service_type WHERE i.id=? AND i.is_active=1 AND (i.expires_at IS NULL OR julianday(i.expires_at)>julianday('now')) AND s.is_active=1 AND p.enabled=1 AND s.revision=?)`, s.ID, inviteID, s.Revision).Scan(&valid)
	if err != nil {
		return err
	}
	if !valid {
		return ErrConflict
	}
	return nil
}

func (a *App) provisionCheckpoint(requestCtx context.Context, jobID string, inviteID int64, s ManagedServer, stage, remoteID string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	var validation error
	err := a.store.write(ctx, func(tx *sql.Tx) error {
		result, err := tx.ExecContext(ctx, `UPDATE provisioning_steps SET stage=?,remote_id=coalesce(nullif(?,''),remote_id),status='running' WHERE job_id=? AND server_id=? AND status IN ('pending','running') AND EXISTS(SELECT 1 FROM provisioning_jobs WHERE id=? AND status='running')`, stage, remoteID, jobID, s.ID, jobID)
		if err != nil {
			return err
		}
		count, _ := result.RowsAffected()
		if count != 1 {
			return ErrConflict
		}
		// Persist the returned identity even when revocation raced the request.
		validation = provisionStillAllowed(ctx, tx, inviteID, s)
		return nil
	})
	if err != nil {
		return err
	}
	if requestCtx.Err() != nil {
		return requestCtx.Err()
	}
	return validation
}

func (a *App) commitProvisionedStep(ctx context.Context, jobID, userUUID string, inviteID int64, s ManagedServer, g InvitationGrant, remoteName string) error {
	return a.store.write(ctx, func(tx *sql.Tx) error {
		if err := provisionStillAllowed(ctx, tx, inviteID, s); err != nil {
			return err
		}
		var remoteID string
		if err := tx.QueryRowContext(ctx, "SELECT remote_id FROM provisioning_steps WHERE job_id=? AND server_id=? AND stage='remote_completed' AND status='running'", jobID, s.ID).Scan(&remoteID); err != nil {
			return err
		}
		uuid, now := newUUID(), utcTimestamp(time.Now())
		ids, _ := json.Marshal(g.LibraryIDs)
		settings, _ := json.Marshal(map[string]bool{"all_libraries": g.AllLibraries, "library_policy_known": true})
		if _, err := tx.ExecContext(ctx, "INSERT INTO identities(uuid,kind) VALUES(?,'service')", uuid); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO service_accounts(uuid,server_id,external_user_id,external_username,allowed_library_ids,allow_downloads,service_settings,is_active,used_invite_id,created_at,updated_at) SELECT ?,?,?,?,?,?,?,1,?,?,? FROM user_accounts WHERE uuid=?`, uuid, s.ID, remoteID, remoteName, string(ids), g.AllowDownloads, string(settings), inviteID, now, now, userUUID); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, "INSERT INTO service_links(user_uuid,service_uuid,link_kind,created_at) VALUES(?,?,'owner',?)", userUUID, uuid, now); err != nil {
			return err
		}
		_, err := tx.ExecContext(ctx, "UPDATE provisioning_steps SET status='completed',stage='completed' WHERE job_id=? AND server_id=?", jobID, s.ID)
		return err
	})
}

func (a *App) completeRedemption(ctx context.Context, jobID, userUUID string, inviteID int64, servers map[int64]ManagedServer) error {
	return a.store.write(ctx, func(tx *sql.Tx) error {
		for _, s := range servers {
			if err := provisionStillAllowed(ctx, tx, inviteID, s); err != nil {
				return err
			}
		}
		var incomplete bool
		if err := tx.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM provisioning_steps WHERE job_id=? AND status!='completed') OR EXISTS(SELECT 1 FROM plex_share_checkpoints WHERE job_id=?)", jobID, jobID).Scan(&incomplete); err != nil {
			return err
		}
		if incomplete {
			return ErrConflict
		}
		now := utcTimestamp(time.Now())
		result, err := tx.ExecContext(ctx, "UPDATE provisioning_jobs SET status='completed',reservation_held=0,updated_at=? WHERE id=? AND status='running' AND reservation_held=1", now, jobID)
		if err != nil {
			return err
		}
		count, _ := result.RowsAffected()
		if count != 1 {
			return ErrConflict
		}
		if _, err := tx.ExecContext(ctx, "UPDATE invites SET current_uses=current_uses+1,updated_at=? WHERE id=?", now, inviteID); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, "UPDATE user_accounts SET is_active=1,updated_at=? WHERE uuid=?", now, userUUID); err != nil {
			return err
		}
		// Membership duration (Flask parity): access ends this many days after
		// the invitation completes, for the new MUM account and the service
		// accounts this invitation created or linked.
		var days sql.NullInt64
		if err := tx.QueryRowContext(ctx, "SELECT membership_duration_days FROM invites WHERE id=?", inviteID).Scan(&days); err != nil {
			return err
		}
		if days.Valid && days.Int64 > 0 {
			until := utcTimestamp(time.Now().AddDate(0, 0, int(days.Int64)))
			if _, err := tx.ExecContext(ctx, "UPDATE user_accounts SET access_expires_at=?,updated_at=? WHERE uuid=?", until, now, userUUID); err != nil {
				return err
			}
			if _, err := tx.ExecContext(ctx, "UPDATE service_accounts SET access_expires_at=?,updated_at=? WHERE used_invite_id=? AND uuid IN (SELECT service_uuid FROM service_links WHERE user_uuid=? AND link_kind='owner')", until, now, inviteID, userUUID); err != nil {
				return err
			}
		}
		return auditAction(ctx, tx, "", "invitation.complete")
	})
}

func (a *App) failRedemption(jobID, code string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	return a.store.write(ctx, func(tx *sql.Tx) error {
		if _, err := tx.ExecContext(ctx, "UPDATE provisioning_jobs SET status='failed',error_code=?,updated_at=? WHERE id=? AND status='running'", code, utcTimestamp(time.Now()), jobID); err != nil {
			return err
		}
		_, err := tx.ExecContext(ctx, "UPDATE provisioning_steps SET status='failed',error_code=? WHERE job_id=? AND status IN ('pending','running')", code, jobID)
		return err
	})
}

// No automatic replay of remote account creation after process interruption.
func (a *App) recoverProvisioning(ctx context.Context) error {
	return a.store.write(ctx, func(tx *sql.Tx) error {
		if _, err := tx.ExecContext(ctx, "UPDATE plex_invitation_credentials SET refresh_token=NULL,refresh_expires_at=NULL,revision=revision+1 WHERE refresh_token IS NOT NULL"); err != nil {
			return err
		}
		// A committed send/cancel intent stays uncertain after restart. Clearing a
		// lease permits explicit inspection; it never authorizes mutation replay.
		if _, err := tx.ExecContext(ctx, "UPDATE plex_share_checkpoints SET operation_token=NULL,operation_name=NULL,operation_expires_at=NULL,revision=revision+1,updated_at=? WHERE operation_token IS NOT NULL", utcTimestamp(time.Now())); err != nil {
			return err
		}

		// An interrupted Discord code exchange is never resumed; the browser starts again.
		if _, err := tx.ExecContext(ctx, "UPDATE invitation_discord_proofs SET status='failed',error_code='INTERRUPTED',updated_at=? WHERE status='exchanging'", utcTimestamp(time.Now())); err != nil {
			return err
		}
		// An interrupted remote disable stays unresolved; a later explicit
		// operation inspects first and never replays the write.
		if _, err := tx.ExecContext(ctx, `UPDATE service_remote_access SET state='unknown',error_code='INTERRUPTED_RECONCILIATION_REQUIRED',checked_at=?,operation_token=NULL,operation_kind=NULL,actor_uuid=NULL,access_hash=NULL,role_revision=NULL,config_revision=NULL,link_revision=NULL,provider_fingerprint=NULL,external_user_id=NULL,operation_expires_at=NULL,revision=revision+1 WHERE operation_token IS NOT NULL`, utcTimestamp(time.Now())); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, "UPDATE provisioning_steps SET resume_state='unknown',resume_error_code='INTERRUPTED_REVIEW_REQUIRED' WHERE resume_state='running' AND job_id IN (SELECT id FROM provisioning_jobs WHERE review_token IS NOT NULL AND review_operation='resume')"); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, "UPDATE provisioning_steps SET cleanup_state='unknown',cleanup_error_code='INTERRUPTED_REVIEW_REQUIRED' WHERE cleanup_state='running' AND job_id IN (SELECT id FROM provisioning_jobs WHERE review_token IS NOT NULL)"); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, "UPDATE provisioning_jobs SET review_token=NULL,review_actor_uuid=NULL,review_access_hash=NULL,review_role_revision=NULL,review_operation=NULL,review_error_code=CASE WHEN status='completed' OR resolution='cancelled' THEN NULL ELSE 'INTERRUPTED_REVIEW_REQUIRED' END,revision=revision+1 WHERE review_token IS NOT NULL"); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, "UPDATE provisioning_steps SET status='failed',error_code='INTERRUPTED_REVIEW_REQUIRED' WHERE job_id IN (SELECT id FROM provisioning_jobs WHERE status='running' AND request_hash IS NOT NULL) AND status IN ('pending','running')"); err != nil {
			return err
		}
		_, err := tx.ExecContext(ctx, "UPDATE provisioning_jobs SET status='failed',error_code='INTERRUPTED_REVIEW_REQUIRED',updated_at=? WHERE status='running' AND request_hash IS NOT NULL", utcTimestamp(time.Now()))
		return err
	})
}

func (a *App) getProvisioningJob(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.principal(w, r, true); !ok {
		return
	}
	job, err := a.loadRedemption(r.Context(), r.PathValue("job"))
	if err != nil {
		domainError(w, err)
		return
	}
	if err := a.populateReviewFlags(r.Context(), &job); err != nil {
		domainError(w, err)
		return
	}
	respond(w, 200, job)
}

func (a *App) listProvisioningJobs(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.principal(w, r, true); !ok {
		return
	}
	before, ok := invitationCursor(w, r)
	if !ok {
		return
	}
	filter := ""
	args := []any{before}
	if raw := r.URL.Query().Get("invite_id"); raw != "" {
		id, err := strconv.ParseInt(raw, 10, 64)
		if err != nil || id < 1 {
			fail(w, 400, "INVALID_INVITATION", "invite_id must be positive")
			return
		}
		filter = " AND invite_id=?"
		args = append(args, id)
	}
	tx, err := a.store.reader.BeginTx(r.Context(), &sql.TxOptions{ReadOnly: true})
	if err != nil {
		domainError(w, err)
		return
	}
	defer tx.Rollback()
	rows, err := tx.QueryContext(r.Context(), "SELECT rowid,id,CASE WHEN resolution='cancelled' THEN 'cancelled' ELSE status END,user_uuid,coalesce(error_code,''),updated_at,created_at,invite_id FROM provisioning_jobs WHERE request_hash IS NOT NULL AND rowid<?"+filter+" ORDER BY rowid DESC LIMIT 101", args...)
	if err != nil {
		domainError(w, err)
		return
	}
	items := []map[string]any{}
	cursors := []int64{}
	for rows.Next() {
		var cursor int64
		var id, status, uuid, code, updated, created string
		var inviteID int64
		if err = rows.Scan(&cursor, &id, &status, &uuid, &code, &updated, &created, &inviteID); err != nil {
			break
		}
		items = append(items, map[string]any{"id": id, "status": status, "user_uuid": uuid, "error_code": code, "updated_at": updated, "created_at": created, "invite_id": inviteID})
		cursors = append(cursors, cursor)
	}
	err = errors.Join(err, rows.Err(), rows.Close())
	if err != nil {
		domainError(w, err)
		return
	}
	ids := []string{}
	for _, item := range items {
		ids = append(ids, item["id"].(string))
	}
	receipts, err := readPlexShareReceipts(r.Context(), tx, ids)
	if err != nil {
		domainError(w, err)
		return
	}
	for _, item := range items {
		if progress := summarizePlexReceipts(item["id"].(string), item["status"].(string), receipts); progress != nil {
			item["plex_progress"] = progress
		}
	}
	if err := tx.Commit(); err != nil {
		domainError(w, err)
		return
	}
	var next any
	if len(items) > 100 {
		items = items[:100]
		next = cursors[99]
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"data": items, "meta": map[string]any{"next_before": next}})
}
