package main

import (
	"app/server/providers/plex"
	"context"
	"crypto/ed25519"
	"database/sql"
	"errors"
	"net/http"
	"time"
)

var errPlexRateLimit = errors.New("Plex authorization admission limit")

type plexAuthorization struct {
	ID, Owner, Browser, Status, Expires, PollAfter, AccountID, Username, Operation string
	Revision                                                                       int64
	Secret                                                                         []byte
}

const plexAuthorizationSelect = `SELECT id,owner_uuid,browser_hash,status,expires_at,poll_after,coalesce(account_id,''),coalesce(username,''),coalesce(operation_token,''),revision,secret FROM plex_authorizations WHERE id=? AND owner_uuid=?`

func scanPlexAuthorization(row *sql.Row) (plexAuthorization, error) {
	var value plexAuthorization
	err := row.Scan(&value.ID, &value.Owner, &value.Browser, &value.Status, &value.Expires, &value.PollAfter, &value.AccountID, &value.Username, &value.Operation, &value.Revision, &value.Secret)
	if err == sql.ErrNoRows {
		err = ErrForbidden
	}
	return value, err
}
func plexAuthorizationPurpose(row plexAuthorization) string {
	return "authorization:" + row.ID + ":" + row.Owner + ":" + row.Browser
}
func plexConnectionPurpose(id, owner, account string) string {
	return "connection:" + id + ":" + owner + ":" + account
}
func plexCookieName(id string) string { return "mum_plex_" + id }
func (a *App) plexCookie(w http.ResponseWriter, id, value string, maxAge int) {
	http.SetCookie(w, &http.Cookie{Name: plexCookieName(id), Value: value, Path: "/api/plex/authorizations/" + id, HttpOnly: true, Secure: a.SecureCookies, SameSite: http.SameSiteStrictMode, MaxAge: maxAge})
}
func plexSessionOwner(ctx context.Context, tx *sql.Tx, access, owner string) error {
	now := utcTimestamp(time.Now())
	var current string
	if len(access) != 43 {
		return ErrForbidden
	}
	err := tx.QueryRowContext(ctx, `SELECT s.user_uuid FROM app_sessions s JOIN session_access_tokens t ON t.session_id=s.id WHERE t.token_hash=? AND t.expires_at>? AND s.refresh_expires_at>?`, tokenHash(access), now, now).Scan(&current)
	if err != nil || current != owner {
		return ErrForbidden
	}
	_, err = loadPrincipal(ctx, tx, owner)
	return err
}

func plexProviderEnabled(ctx context.Context, tx *sql.Tx) error {
	var enabled bool
	if err := tx.QueryRowContext(ctx, "SELECT enabled FROM provider_settings WHERE provider_id='plex'").Scan(&enabled); err != nil {
		return err
	}
	if !enabled {
		return ErrConflict
	}
	return nil
}
func plexAuthorizationBound(row plexAuthorization, browser string) bool {
	return len(browser) == 43 && tokenHash(browser) == row.Browser && row.Expires > utcTimestamp(time.Now())
}
func plexAuthorizationView(row plexAuthorization) map[string]any {
	result := map[string]any{"id": row.ID, "status": row.Status, "expires_at": row.Expires, "revision": row.Revision}
	if row.Status == "verified" {
		result["account"] = map[string]string{"id": row.AccountID, "username": row.Username}
	}
	return result
}
func plexAuthorizationError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, errPlexRateLimit):
		w.Header().Set("Retry-After", "2")
		fail(w, 429, "PLEX_AUTHORIZATION_LIMIT", "Wait before starting or polling Plex authorization")
	case errors.Is(err, ErrForbidden), errors.Is(err, ErrConflict):
		domainError(w, err)
	default:
		fail(w, 502, "PLEX_AUTHORIZATION_UNAVAILABLE", "Plex authorization could not be completed; inspect the current connection before retrying")
	}
}
func (a *App) startPlexAuthorization(w http.ResponseWriter, r *http.Request) {
	owner, ok := a.principal(w, r, false)
	if !ok {
		return
	}
	var input struct{}
	if !decodeStrictBody(w, r, &input) {
		return
	}
	ctx, done, ok := a.startReviewOperation(w, r)
	if !ok {
		return
	}
	defer done()
	device, err := plex.NewDevice(a.ProviderHTTP)
	if err != nil {
		plexAuthorizationError(w, err)
		return
	}
	// Establish/validate the key before inserting a durable row referencing it.
	if _, err = a.store.plexAEAD(ctx, true); err != nil {
		plexAuthorizationError(w, err)
		return
	}
	now := time.Now()
	browser := randomToken()
	row := plexAuthorization{ID: newUUID(), Owner: owner.UUID, Browser: tokenHash(browser), Status: "creating", Expires: utcTimestamp(now.Add(15 * time.Minute)), PollAfter: utcTimestamp(now), Revision: 1}
	err = a.store.write(ctx, func(tx *sql.Tx) error {
		if err := plexSessionOwner(ctx, tx, bearer(r), owner.UUID); err != nil {
			return err
		}
		if err := plexProviderEnabled(ctx, tx); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, "DELETE FROM plex_authorizations WHERE expires_at<? AND (operation_token IS NULL OR operation_expires_at<?)", utcTimestamp(now.Add(-24*time.Hour)), utcTimestamp(now)); err != nil {
			return err
		}
		var ownActive, active, total, recent, globalRecent int
		if err := tx.QueryRowContext(ctx, `SELECT count(CASE WHEN owner_uuid=? AND status IN ('creating','pending','verified') AND expires_at>? THEN 1 END),count(CASE WHEN status IN ('creating','pending','verified') AND expires_at>? THEN 1 END),count(*),count(CASE WHEN owner_uuid=? AND created_at>? THEN 1 END),count(CASE WHEN created_at>? THEN 1 END) FROM plex_authorizations`, owner.UUID, utcTimestamp(now), utcTimestamp(now), owner.UUID, utcTimestamp(now.Add(-time.Minute)), utcTimestamp(now.Add(-time.Minute))).Scan(&ownActive, &active, &total, &recent, &globalRecent); err != nil {
			return err
		}
		if ownActive >= 3 || active >= 100 || total >= 5000 || recent >= 6 || globalRecent >= 60 {
			return errPlexRateLimit
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO plex_authorizations(id,owner_uuid,browser_hash,status,expires_at,poll_after,created_at,updated_at) VALUES(?,?,?,'creating',?,?,?,?)`, row.ID, row.Owner, row.Browser, row.Expires, row.PollAfter, utcTimestamp(now), utcTimestamp(now)); err != nil {
			return err
		}
		return auditAction(ctx, tx, owner.UUID, "plex.authorization.start")
	})
	if err != nil {
		plexAuthorizationError(w, err)
		return
	}
	committed := false
	defer func() {
		if !committed {
			cleanup, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			_ = a.store.write(cleanup, func(tx *sql.Tx) error {
				_, err := tx.ExecContext(cleanup, "UPDATE plex_authorizations SET status='failed',secret=NULL,updated_at=? WHERE id=? AND status='creating'", utcTimestamp(time.Now()), row.ID)
				return err
			})
		}
	}()
	pin, err := device.BeginPIN(ctx)
	if err != nil {
		plexAuthorizationError(w, err)
		return
	}
	secret := plexStoredCredential{ClientID: device.ClientID, KeyID: device.KeyID, PrivateKey: []byte(device.PrivateKey), PINID: pin.ID, PINCode: pin.Code, Expires: pin.Expires}
	row.Expires = utcTimestamp(pin.Expires)
	encoded, err := a.store.sealPlexCredential(ctx, plexAuthorizationPurpose(row), secret)
	if err != nil {
		plexAuthorizationError(w, err)
		return
	}
	err = a.store.write(ctx, func(tx *sql.Tx) error {
		if err := plexSessionOwner(ctx, tx, bearer(r), owner.UUID); err != nil {
			return err
		}
		if err := plexProviderEnabled(ctx, tx); err != nil {
			return err
		}
		result, err := tx.ExecContext(ctx, "UPDATE plex_authorizations SET status='pending',secret=?,expires_at=?,revision=revision+1,updated_at=? WHERE id=? AND owner_uuid=? AND status='creating' AND expires_at>?", encoded, row.Expires, utcTimestamp(time.Now()), row.ID, row.Owner, utcTimestamp(time.Now()))
		if err != nil {
			return err
		}
		count, _ := result.RowsAffected()
		if count != 1 {
			return ErrConflict
		}
		return nil
	})
	if err != nil {
		plexAuthorizationError(w, err)
		return
	}
	committed = true
	row.Status = "pending"
	row.Revision++
	a.plexCookie(w, row.ID, browser, int(time.Until(pin.Expires).Seconds()))
	view := plexAuthorizationView(row)
	view["authorization_url"] = pin.AuthorizationURL
	respond(w, 201, view)
}
func (a *App) pollPlexAuthorization(w http.ResponseWriter, r *http.Request) {
	owner, ok := a.principal(w, r, false)
	if !ok {
		return
	}
	var input struct{}
	if !decodeStrictBody(w, r, &input) {
		return
	}
	id := r.PathValue("authorization")
	if !validProvisionedID(id) {
		domainError(w, ErrForbidden)
		return
	}
	cookie, err := r.Cookie(plexCookieName(id))
	if err != nil || len(cookie.Value) != 43 {
		domainError(w, ErrForbidden)
		return
	}
	ctx, done, ok := a.startReviewOperation(w, r)
	if !ok {
		return
	}
	defer done()
	var row plexAuthorization
	lease := randomToken()
	err = a.store.write(ctx, func(tx *sql.Tx) error {
		if err := plexSessionOwner(ctx, tx, bearer(r), owner.UUID); err != nil {
			return err
		}
		if err := plexProviderEnabled(ctx, tx); err != nil {
			return err
		}
		var err error
		row, err = scanPlexAuthorization(tx.QueryRowContext(ctx, plexAuthorizationSelect, id, owner.UUID))
		if err != nil {
			return err
		}
		if !plexAuthorizationBound(row, cookie.Value) {
			return ErrForbidden
		}
		if row.Status == "verified" {
			return nil
		}
		if row.Status != "pending" {
			return ErrConflict
		}
		now := time.Now()
		if row.PollAfter > utcTimestamp(now) {
			return errPlexRateLimit
		}
		result, err := tx.ExecContext(ctx, `UPDATE plex_authorizations SET operation_token=?,operation_expires_at=?,poll_after=?,revision=revision+1,updated_at=? WHERE id=? AND revision=? AND (operation_token IS NULL OR operation_expires_at<?)`, lease, utcTimestamp(now.Add(30*time.Second)), utcTimestamp(now.Add(2*time.Second)), utcTimestamp(now), row.ID, row.Revision, utcTimestamp(now))
		if err != nil {
			return err
		}
		count, _ := result.RowsAffected()
		if count != 1 {
			return ErrConflict
		}
		row.Revision++
		return nil
	})
	if err != nil {
		plexAuthorizationError(w, err)
		return
	}
	if row.Status == "verified" {
		respond(w, 200, plexAuthorizationView(row))
		return
	}
	defer func() {
		cleanup, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = a.store.write(cleanup, func(tx *sql.Tx) error {
			_, err := tx.ExecContext(cleanup, "UPDATE plex_authorizations SET operation_token=NULL,operation_expires_at=NULL WHERE id=? AND operation_token=?", id, lease)
			return err
		})
	}()
	secret, err := a.store.openPlexCredential(ctx, plexAuthorizationPurpose(row), row.Secret)
	if err != nil {
		plexAuthorizationError(w, err)
		return
	}
	device, err := plex.NewDevice(a.ProviderHTTP)
	if err != nil {
		plexAuthorizationError(w, err)
		return
	}
	device.ClientID = secret.ClientID
	device.KeyID = secret.KeyID
	device.PrivateKey = ed25519.PrivateKey(secret.PrivateKey)
	result, err := device.PollPIN(ctx, plex.PIN{ID: secret.PINID, Code: secret.PINCode, Expires: secret.Expires, ClientID: secret.ClientID})
	if err != nil {
		plexAuthorizationError(w, err)
		return
	}
	encoded := row.Secret
	if !result.Pending {
		if result.Account == nil {
			plexAuthorizationError(w, errPlexAuthentication)
			return
		}
		secret.Token = result.AuthToken
		secret.AccountID = result.Account.ID
		// PIN proof is no longer reusable as a new cloud assertion after verification.
		secret.PINCode = ""
		secret.PINID = 0
		encoded, err = a.store.sealPlexCredential(ctx, plexAuthorizationPurpose(row), secret)
		if err != nil {
			plexAuthorizationError(w, err)
			return
		}
	}
	err = a.store.write(ctx, func(tx *sql.Tx) error {
		if err := plexSessionOwner(ctx, tx, bearer(r), owner.UUID); err != nil {
			return err
		}
		if err := plexProviderEnabled(ctx, tx); err != nil {
			return err
		}
		next := "pending"
		accountID, username := "", ""
		if !result.Pending {
			next = "verified"
			accountID = result.Account.ID
			username = result.Account.Username
		}
		updated, err := tx.ExecContext(ctx, `UPDATE plex_authorizations SET status=?,secret=?,account_id=?,username=?,operation_token=NULL,operation_expires_at=NULL,revision=revision+1,updated_at=? WHERE id=? AND owner_uuid=? AND browser_hash=? AND revision=? AND status='pending' AND operation_token=? AND operation_expires_at>? AND expires_at>?`, next, encoded, accountID, username, utcTimestamp(time.Now()), id, owner.UUID, tokenHash(cookie.Value), row.Revision, lease, utcTimestamp(time.Now()), utcTimestamp(time.Now()))
		if err != nil {
			return err
		}
		count, _ := updated.RowsAffected()
		if count != 1 {
			return ErrConflict
		}
		row.Status = next
		row.AccountID = accountID
		row.Username = username
		row.Revision++
		if !result.Pending {
			return auditAction(ctx, tx, owner.UUID, "plex.authorization.verified")
		}
		return nil
	})
	if err != nil {
		plexAuthorizationError(w, err)
		return
	}
	respond(w, 200, plexAuthorizationView(row))
}
func (a *App) confirmPlexAuthorization(w http.ResponseWriter, r *http.Request) {
	owner, ok := a.principal(w, r, false)
	if !ok {
		return
	}
	var input struct {
		ExpectedAccountID string `json:"expected_account_id"`
	}
	if !decodeStrictBody(w, r, &input) {
		return
	}
	id := r.PathValue("authorization")
	cookie, err := r.Cookie(plexCookieName(id))
	if !validProvisionedID(id) || err != nil || len(cookie.Value) != 43 {
		domainError(w, ErrForbidden)
		return
	}
	row, err := scanPlexAuthorization(a.store.reader.QueryRowContext(r.Context(), plexAuthorizationSelect, id, owner.UUID))
	if err != nil {
		plexAuthorizationError(w, err)
		return
	}
	if !plexAuthorizationBound(row, cookie.Value) || row.Status != "verified" || row.AccountID != input.ExpectedAccountID {
		domainError(w, ErrConflict)
		return
	}
	secret, err := a.store.openPlexCredential(r.Context(), plexAuthorizationPurpose(row), row.Secret)
	if err != nil {
		plexAuthorizationError(w, err)
		return
	}
	if !secret.Expires.After(time.Now()) || secret.AccountID != row.AccountID || !plex.JWTShape(secret.Token) {
		plexAuthorizationError(w, errPlexAuthentication)
		return
	}
	connectionID := newUUID()
	encoded, err := a.store.sealPlexCredential(r.Context(), plexConnectionPurpose(connectionID, owner.UUID, row.AccountID), secret)
	if err != nil {
		plexAuthorizationError(w, err)
		return
	}
	err = a.store.write(r.Context(), func(tx *sql.Tx) error {
		if err := plexSessionOwner(r.Context(), tx, bearer(r), owner.UUID); err != nil {
			return err
		}
		if err := plexProviderEnabled(r.Context(), tx); err != nil {
			return err
		}
		var exists bool
		if err := tx.QueryRowContext(r.Context(), "SELECT EXISTS(SELECT 1 FROM plex_connections WHERE status='active' AND (owner_uuid=? OR account_id=?)) OR EXISTS(SELECT 1 FROM plex_invitation_credentials WHERE status='active' AND account_id=?)", owner.UUID, row.AccountID, row.AccountID).Scan(&exists); err != nil {
			return err
		}
		if exists {
			return ErrConflict
		}
		result, err := tx.ExecContext(r.Context(), `UPDATE plex_authorizations SET status='consumed',secret=NULL,revision=revision+1,updated_at=? WHERE id=? AND owner_uuid=? AND browser_hash=? AND revision=? AND status='verified' AND expires_at>? AND operation_token IS NULL`, utcTimestamp(time.Now()), id, owner.UUID, row.Browser, row.Revision, utcTimestamp(time.Now()))
		if err != nil {
			return err
		}
		count, _ := result.RowsAffected()
		if count != 1 {
			return ErrConflict
		}
		if _, err := tx.ExecContext(r.Context(), `INSERT INTO plex_connections(id,owner_uuid,account_id,username,secret,status,created_at,verified_at) VALUES(?,?,?,?,?,'active',?,?)`, connectionID, owner.UUID, row.AccountID, row.Username, encoded, utcTimestamp(time.Now()), utcTimestamp(time.Now())); err != nil {
			return err
		}
		if err := auditAction(r.Context(), tx, owner.UUID, "plex.connection.confirm"); err != nil {
			return err
		}
		return claimPlexShares(r.Context(), tx, owner.UUID, row.AccountID)
	})
	if err != nil {
		plexAuthorizationError(w, err)
		return
	}
	a.plexCookie(w, id, "", -1)
	onServer, err := plexAccountOnServer(r.Context(), a.store.reader, owner, row.AccountID)
	if err != nil {
		plexAuthorizationError(w, err)
		return
	}
	respond(w, 201, map[string]any{"id": connectionID, "account_id": row.AccountID, "username": row.Username, "status": "active", "on_server": onServer})
}

// claimPlexShares links the caller's unowned accounts on Plex servers to
// their MUM account when they connect that Plex account: the Plex sign-in
// that made the connection proves the account is theirs, as signing in with
// Plex does. It follows the media server sign-in switch like every other
// self-service link. Accounts owned by someone else stay theirs, and servers
// with an account change underway are left alone.
func claimPlexShares(ctx context.Context, tx *sql.Tx, user, account string) error {
	if account == "" || account == plexOwnerAccountID {
		return nil
	}
	if enabled, _ := serviceSignInSettings(ctx, tx); !enabled {
		return nil
	}
	rows, err := tx.QueryContext(ctx, `SELECT sa.uuid,sa.server_id FROM service_accounts sa JOIN media_servers m ON m.id=sa.server_id
	 WHERE m.service_type='plex' AND sa.external_user_id=? AND sa.removed_at IS NULL
	 AND NOT EXISTS(SELECT 1 FROM service_links l WHERE l.service_uuid=sa.uuid AND l.link_kind='owner') ORDER BY sa.server_id,sa.uuid`, account)
	if err != nil {
		return err
	}
	type share struct {
		service string
		server  int64
	}
	var shares []share
	for rows.Next() {
		var s share
		if err := rows.Scan(&s.service, &s.server); err != nil {
			rows.Close()
			return err
		}
		shares = append(shares, s)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	linked := false
	for _, s := range shares {
		if busy, err := editSourceBusy(ctx, tx, s.server, ""); err != nil {
			return err
		} else if busy {
			continue
		}
		if _, err := tx.ExecContext(ctx, "INSERT INTO service_links(user_uuid,service_uuid,link_kind,created_by,created_at) VALUES(?,?,'owner',?,?)", user, s.service, user, utcTimestamp(time.Now())); err != nil {
			return err
		}
		linked = true
	}
	if !linked {
		return nil
	}
	return auditAction(ctx, tx, user, "account.link.plex")
}

// claimSyncedPlexShares links the unowned accounts on Plex server serverID
// to the MUM accounts whose connected Plex account they are, as connecting
// would have if the account had been on the server then. The same rules
// apply: the media server sign-in switch, never the server owner's account,
// never an account someone already owns.
func claimSyncedPlexShares(ctx context.Context, tx *sql.Tx, serverID int64) error {
	if enabled, _ := serviceSignInSettings(ctx, tx); !enabled {
		return nil
	}
	rows, err := tx.QueryContext(ctx, `INSERT INTO service_links(user_uuid,service_uuid,link_kind,created_by,created_at)
	 SELECT c.owner_uuid,sa.uuid,'owner',c.owner_uuid,? FROM service_accounts sa
	 JOIN plex_connections c ON c.account_id=sa.external_user_id AND c.status='active'
	 JOIN user_accounts u ON u.uuid=c.owner_uuid AND u.deleted_at IS NULL
	 WHERE sa.server_id=? AND sa.removed_at IS NULL AND sa.external_user_id<>?
	 AND NOT EXISTS(SELECT 1 FROM service_links l WHERE l.service_uuid=sa.uuid AND l.link_kind='owner')
	 RETURNING user_uuid`, utcTimestamp(time.Now()), serverID, plexOwnerAccountID)
	if err != nil {
		return err
	}
	var owners []string
	for rows.Next() {
		var owner string
		if err := rows.Scan(&owner); err != nil {
			rows.Close()
			return err
		}
		owners = append(owners, owner)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	for _, owner := range owners {
		if err := auditAction(ctx, tx, owner, "account.link.plex"); err != nil {
			return err
		}
	}
	return nil
}

// plexAccountOnServer reports whether the Plex account has an account on one
// of this MUM's Plex servers. The server owner's own account is not listed
// that way, so for the owner it is unknown (nil).
func plexAccountOnServer(ctx context.Context, db queryRower, p Principal, account string) (any, error) {
	if p.Kind == "owner" {
		return nil, nil
	}
	var found bool
	err := db.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM service_accounts sa JOIN media_servers m ON m.id=sa.server_id
	 WHERE m.service_type='plex' AND sa.external_user_id=? AND sa.removed_at IS NULL)`, account).Scan(&found)
	return found, err
}
func (a *App) getPlexConnection(w http.ResponseWriter, r *http.Request) {
	owner, ok := a.principal(w, r, false)
	if !ok {
		return
	}
	var id, account, username, verified string
	err := a.store.reader.QueryRowContext(r.Context(), "SELECT id,account_id,username,verified_at FROM plex_connections WHERE owner_uuid=? AND status='active'", owner.UUID).Scan(&id, &account, &username, &verified)
	if err == sql.ErrNoRows {
		respond(w, 200, nil)
		return
	}
	if err != nil {
		plexAuthorizationError(w, err)
		return
	}
	onServer, err := plexAccountOnServer(r.Context(), a.store.reader, owner, account)
	if err != nil {
		plexAuthorizationError(w, err)
		return
	}
	out := map[string]any{"id": id, "account_id": account, "username": username, "verified_at": verified, "status": "active", "on_server": onServer}
	// The picture is the one user sync keeps for the Plex server account with
	// the same plex.tv ID (account_avatars.go); none when there is no such
	// account.
	var identity int64
	var avatar string
	err = a.store.reader.QueryRowContext(r.Context(), `SELECT i.id,a.external_avatar_url FROM service_accounts a JOIN identities i ON i.uuid=a.uuid JOIN media_servers s ON s.id=a.server_id
	 WHERE s.service_type='plex' AND s.is_active=1 AND a.external_avatar_url IS NOT NULL AND (a.external_user_id=? OR a.external_account_id=?) ORDER BY a.is_active DESC,a.uuid LIMIT 1`, account, account).Scan(&identity, &avatar)
	if err == nil && serviceHasAvatar("plex", "", avatar) {
		if session, sessionErr := a.requestSession(r.Context(), r); sessionErr == nil {
			out["avatar_url"] = a.serviceAvatarURL(session, identity, time.Now())
		}
	} else if err != nil && err != sql.ErrNoRows {
		plexAuthorizationError(w, err)
		return
	}
	respond(w, 200, out)
}
func (a *App) revokePlexConnection(w http.ResponseWriter, r *http.Request) {
	owner, ok := a.principal(w, r, false)
	if !ok {
		return
	}
	var input struct{}
	if !decodeStrictBody(w, r, &input) {
		return
	}
	id := r.PathValue("connection")
	if !validProvisionedID(id) {
		domainError(w, ErrForbidden)
		return
	}
	err := a.store.write(r.Context(), func(tx *sql.Tx) error {
		if err := plexSessionOwner(r.Context(), tx, bearer(r), owner.UUID); err != nil {
			return err
		}
		result, err := tx.ExecContext(r.Context(), "UPDATE plex_connections SET status='revoked',secret=NULL,revoked_at=? WHERE id=? AND owner_uuid=? AND status='active'", utcTimestamp(time.Now()), id, owner.UUID)
		if err != nil {
			return err
		}
		count, _ := result.RowsAffected()
		if count != 1 {
			return ErrConflict
		}
		if _, err := tx.ExecContext(r.Context(), "UPDATE plex_authorizations SET status='failed',secret=NULL,operation_token=NULL,operation_expires_at=NULL,revision=revision+1,updated_at=? WHERE owner_uuid=? AND status IN ('creating','pending','verified')", utcTimestamp(time.Now()), owner.UUID); err != nil {
			return err
		}
		return auditAction(r.Context(), tx, owner.UUID, "plex.connection.revoke")
	})
	if err != nil {
		plexAuthorizationError(w, err)
		return
	}
	respond(w, 200, map[string]string{"id": id, "status": "revoked", "scope": "local_connection"})
}
