package main

import (
	"context"
	"database/sql"
	"errors"
	"net/http"
	"strings"
	"time"
)

// Users link their own server accounts by signing in to them, so any of those
// logins signs them in to the same MUM account. They can unlink one while
// another way to sign in remains, and a passwordless account can add a MUM
// password after proving a linked login again.

var (
	errLastSignInMethod      = errors.New("no other way to sign in would remain")
	errVerificationRequired  = errors.New("sign in to a linked server account again first")
	errPasswordAlreadySet    = errors.New("this account already has a MUM password")
	errUsernameUnavailable   = errors.New("username is unavailable")
	errAccountChangeUnderway = errors.New("an administrator is changing this server")
)

func accountLinkError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, errLastSignInMethod):
		fail(w, 409, "LAST_SIGN_IN_METHOD", "Keep at least one way to sign in: link another account or set a MUM password first.")
	case errors.Is(err, errVerificationRequired):
		fail(w, 403, "VERIFICATION_REQUIRED", "Sign in to one of your linked server accounts again to set a MUM password.")
	case errors.Is(err, errPasswordAlreadySet):
		fail(w, 409, "PASSWORD_ALREADY_SET", "This account already has a MUM password.")
	case errors.Is(err, errUsernameUnavailable):
		fail(w, 409, "USERNAME_UNAVAILABLE", "This username is not available.")
	case errors.Is(err, errAccountChangeUnderway):
		fail(w, 409, "ACCOUNT_CHANGE_IN_PROGRESS", "An administrator is changing this server. Try again shortly.")
	case errors.Is(err, sql.ErrNoRows), errors.Is(err, ErrNotFound):
		fail(w, 404, "NOT_FOUND", "Linked account not found")
	default:
		serviceLoginError(w, err)
	}
}

// otherSignInMethod reports whether user could still sign in without the
// owner link to except: a MUM password, an active Plex connection, or another
// linked account on an enabled server whose logins sign in to MUM.
func otherSignInMethod(ctx context.Context, db queryRower, user, except string) (bool, error) {
	var found bool
	err := db.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM user_accounts WHERE uuid=? AND password_hash IS NOT NULL)
	 OR EXISTS(SELECT 1 FROM plex_connections WHERE owner_uuid=? AND status='active')
	 OR EXISTS(SELECT 1 FROM service_links l JOIN service_accounts sa ON sa.uuid=l.service_uuid JOIN media_servers m ON m.id=sa.server_id
	  JOIN provider_settings p ON p.provider_id=m.service_type
	  WHERE l.user_uuid=? AND l.link_kind='owner' AND l.service_uuid<>? AND sa.is_active=1 AND sa.removed_at IS NULL
	  AND m.is_active=1 AND p.enabled=1 AND m.service_type IN `+serviceSignInTypesSQL+` AND (m.service_type<>'plex' OR sa.external_user_id<>'1'))`,
		user, user, user, except).Scan(&found)
	return found, err
}

func (a *App) accountServiceLinks(w http.ResponseWriter, r *http.Request) {
	p, ok := a.principal(w, r, false)
	if !ok {
		return
	}
	ctx := r.Context()
	rows, err := a.store.reader.QueryContext(ctx, `SELECT sa.uuid,m.id,m.server_nickname,m.service_type,coalesce(sa.external_username,'')
	 FROM service_links l JOIN service_accounts sa ON sa.uuid=l.service_uuid JOIN media_servers m ON m.id=sa.server_id
	 WHERE l.user_uuid=? AND l.link_kind='owner' AND sa.removed_at IS NULL ORDER BY m.server_nickname COLLATE NOCASE,sa.uuid`, p.UUID)
	if err != nil {
		domainError(w, err)
		return
	}
	type link struct {
		Service, Name, Type, Username string
		Server                        int64
	}
	var links []link
	for rows.Next() {
		var l link
		if err := rows.Scan(&l.Service, &l.Server, &l.Name, &l.Type, &l.Username); err != nil {
			rows.Close()
			domainError(w, err)
			return
		}
		links = append(links, l)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		domainError(w, err)
		return
	}
	out := []map[string]any{}
	for _, l := range links {
		other, err := otherSignInMethod(ctx, a.store.reader, p.UUID, l.Service)
		if err != nil {
			domainError(w, err)
			return
		}
		out = append(out, map[string]any{"service_uuid": l.Service, "server_id": l.Server, "server_name": l.Name, "server_type": l.Type, "username": l.Username, "can_unlink": other})
	}
	enabled, _ := serviceSignInSettings(ctx, a.store.reader)
	servers := []map[string]any{}
	if enabled {
		list, err := a.store.reader.QueryContext(ctx, `SELECT s.id,s.server_nickname,s.service_type FROM media_servers s JOIN provider_settings p ON p.provider_id=s.service_type
		 WHERE s.is_active=1 AND p.enabled=1 AND s.service_type IN `+serviceCredentialTypesSQL+` ORDER BY s.server_nickname COLLATE NOCASE,s.id`)
		if err != nil {
			domainError(w, err)
			return
		}
		defer list.Close()
		for list.Next() {
			var id int64
			var name, kind string
			if err := list.Scan(&id, &name, &kind); err != nil {
				domainError(w, err)
				return
			}
			servers = append(servers, map[string]any{"id": id, "name": name, "type": kind})
		}
		if err := list.Err(); err != nil {
			domainError(w, err)
			return
		}
	}
	respond(w, 200, map[string]any{"links": out, "servers": servers, "service_sign_in": enabled})
}

// linkAccountService links the server account the caller just signed in to.
func (a *App) linkAccountService(w http.ResponseWriter, r *http.Request) {
	p, ok := a.principal(w, r, false)
	if !ok {
		return
	}
	var input serviceCredentials
	if !decodeStrictBody(w, r, &input) {
		return
	}
	if !input.valid() {
		fail(w, 400, "INVALID_SIGN_IN", "Choose a server and enter its username and password (up to 1024 characters)")
		return
	}
	ctx, done, ok := a.startSignInOperation(w, r)
	if !ok {
		return
	}
	defer done()
	login, err := a.verifyServiceLogin(ctx, r, input.ServerID, input.Username, input.Password)
	if err != nil {
		accountLinkError(w, err)
		return
	}
	err = a.store.write(ctx, func(tx *sql.Tx) error {
		if enabled, _ := serviceSignInSettings(ctx, tx); !enabled {
			return errServiceLoginDisabled
		}
		if _, err := loadPrincipal(ctx, tx, p.UUID); err != nil {
			return err
		}
		if busy, err := editSourceBusy(ctx, tx, input.ServerID, ""); err != nil {
			return err
		} else if busy {
			return errAccountChangeUnderway
		}
		owner, service, err := resolveServiceAccount(ctx, tx, input.ServerID, login.ID, false)
		if err != nil {
			return err
		}
		if owner == p.UUID {
			return nil
		}
		if owner != "" {
			return errServiceAccountClaimed
		}
		if _, err := tx.ExecContext(ctx, "INSERT INTO service_links(user_uuid,service_uuid,link_kind,created_by,created_at) VALUES(?,?,'owner',?,?)", p.UUID, service, p.UUID, utcTimestamp(time.Now())); err != nil {
			return err
		}
		return auditAction(ctx, tx, p.UUID, "account.link.self")
	})
	if err != nil {
		accountLinkError(w, err)
		return
	}
	respond(w, 200, map[string]any{"linked": true})
}

// unlinkAccountService removes one of the caller's own links, keeping at least
// one way to sign in. Sessions signed in through it end with the link.
func (a *App) unlinkAccountService(w http.ResponseWriter, r *http.Request) {
	p, ok := a.principal(w, r, false)
	if !ok {
		return
	}
	service := r.PathValue("service")
	err := a.store.write(r.Context(), func(tx *sql.Tx) error {
		ctx := r.Context()
		if _, err := loadPrincipal(ctx, tx, p.UUID); err != nil {
			return err
		}
		var server int64
		if err := tx.QueryRowContext(ctx, "SELECT sa.server_id FROM service_links l JOIN service_accounts sa ON sa.uuid=l.service_uuid WHERE l.user_uuid=? AND l.service_uuid=? AND l.link_kind='owner'", p.UUID, service).Scan(&server); err != nil {
			return err
		}
		if busy, err := editSourceBusy(ctx, tx, server, ""); err != nil {
			return err
		} else if busy {
			return errAccountChangeUnderway
		}
		if other, err := otherSignInMethod(ctx, tx, p.UUID, service); err != nil {
			return err
		} else if !other {
			return errLastSignInMethod
		}
		if _, err := tx.ExecContext(ctx, "DELETE FROM service_links WHERE user_uuid=? AND service_uuid=? AND link_kind='owner'", p.UUID, service); err != nil {
			return err
		}
		return auditAction(ctx, tx, p.UUID, "account.unlink.self")
	})
	if err != nil {
		accountLinkError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// setInitialCredentials gives a passwordless account a MUM username and
// password. The caller proves a linked server login again in the same
// request; an account whose only logins are Plex may instead use a session
// signed in through Plex within the last five minutes.
func (a *App) setInitialCredentials(w http.ResponseWriter, r *http.Request) {
	p, ok := a.principal(w, r, false)
	if !ok {
		return
	}
	var input struct {
		Username     string              `json:"username"`
		Password     string              `json:"password"`
		Verification *serviceCredentials `json:"verification"`
	}
	if !decodeStrictBody(w, r, &input) {
		return
	}
	username, err := normalizeAccountUsername(input.Username)
	if err != nil || !passwordLongEnough(input.Password) || len(input.Password) > 1024 || (input.Verification != nil && !input.Verification.valid()) {
		fail(w, 400, "INVALID_CREDENTIALS_INPUT", "Choose a username of English letters, numbers, spaces and standard symbols (no accents or emoji) and a password of 12 to 1024 characters")
		return
	}
	ctx := r.Context()
	var hasPassword bool
	if err := a.store.reader.QueryRowContext(ctx, "SELECT password_hash IS NOT NULL FROM user_accounts WHERE uuid=?", p.UUID).Scan(&hasPassword); err != nil {
		domainError(w, err)
		return
	}
	if hasPassword {
		accountLinkError(w, errPasswordAlreadySet)
		return
	}
	verifiedServer, verifiedID := int64(0), ""
	if input.Verification != nil {
		operation, done, ok := a.startSignInOperation(w, r)
		if !ok {
			return
		}
		login, err := a.verifyServiceLogin(operation, r, input.Verification.ServerID, input.Verification.Username, input.Verification.Password)
		done()
		if err != nil {
			accountLinkError(w, err)
			return
		}
		verifiedServer, verifiedID = input.Verification.ServerID, login.ID
	}
	if !a.passwordAdmission(w, r) {
		return
	}
	hash, err := hashPassword(input.Password)
	<-a.passwordSlots
	if err != nil {
		fail(w, 400, "INVALID_PASSWORD", err.Error())
		return
	}
	err = a.store.write(ctx, func(tx *sql.Tx) error {
		if _, err := loadPrincipal(ctx, tx, p.UUID); err != nil {
			return err
		}
		if verifiedID != "" {
			owner, _, err := resolveServiceAccount(ctx, tx, verifiedServer, verifiedID, false)
			if err != nil || owner != p.UUID {
				return errVerificationRequired
			}
		} else if err := freshPlexOnlySession(ctx, tx, p.UUID, bearer(r)); err != nil {
			return err
		}
		var taken bool
		if err := tx.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM user_accounts WHERE local_username=? COLLATE NOCASE AND uuid<>?)", username, p.UUID).Scan(&taken); err != nil {
			return err
		}
		if taken {
			return errUsernameUnavailable
		}
		result, err := tx.ExecContext(ctx, "UPDATE user_accounts SET local_username=?,password_hash=?,profile_revision=profile_revision+1,updated_at=? WHERE uuid=? AND password_hash IS NULL", username, hash, utcTimestamp(time.Now()), p.UUID)
		if err != nil {
			if strings.Contains(err.Error(), "UNIQUE") {
				return errUsernameUnavailable
			}
			return err
		}
		if count, _ := result.RowsAffected(); count != 1 {
			return errPasswordAlreadySet
		}
		return auditAction(ctx, tx, p.UUID, "account.credentials.initial")
	})
	if err != nil {
		accountLinkError(w, err)
		return
	}
	var email, lastLogin sql.NullString
	var force bool
	if err := a.store.reader.QueryRowContext(ctx, "SELECT email,last_login_at,force_password_change FROM user_accounts WHERE uuid=?", p.UUID).Scan(&email, &lastLogin, &force); err != nil {
		domainError(w, err)
		return
	}
	nullable := func(v sql.NullString) any {
		if v.Valid {
			return v.String
		}
		return nil
	}
	respond(w, 200, map[string]any{
		"user":         map[string]any{"uuid": p.UUID, "username": username, "email": nullable(email), "display_name": username, "user_type": p.Kind, "has_password": true, "force_password_change": force, "last_login_at": nullable(lastLogin)},
		"capabilities": map[string]any{"can_set_initial_credentials": false, "can_change_password": true},
	})
}

// freshPlexOnlySession accepts the caller's current session in place of a
// re-entered server login only for accounts with no linked server whose login
// MUM can check, when the session was signed in through Plex within the last
// five minutes.
func freshPlexOnlySession(ctx context.Context, tx *sql.Tx, user, access string) error {
	var credentialLinks bool
	if err := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM service_links l JOIN service_accounts sa ON sa.uuid=l.service_uuid JOIN media_servers m ON m.id=sa.server_id
	 WHERE l.user_uuid=? AND l.link_kind='owner' AND sa.is_active=1 AND sa.removed_at IS NULL AND m.service_type IN `+serviceCredentialTypesSQL+`)`, user).Scan(&credentialLinks); err != nil {
		return err
	}
	if credentialLinks {
		return errVerificationRequired
	}
	var fresh bool
	err := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM app_sessions s JOIN session_access_tokens t ON t.session_id=s.id
	 LEFT JOIN service_accounts sa ON sa.uuid=s.via_service_uuid LEFT JOIN media_servers m ON m.id=sa.server_id
	 WHERE s.user_uuid=? AND t.token_hash=? AND s.created_at>? AND (s.sign_in_origin='plex_connection' OR (s.sign_in_origin='service' AND m.service_type='plex')))`,
		user, tokenHash(access), utcTimestamp(time.Now().Add(-5*time.Minute))).Scan(&fresh)
	if err != nil {
		return err
	}
	if !fresh {
		return errVerificationRequired
	}
	return nil
}
