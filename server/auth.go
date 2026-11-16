package main

import (
	"context"
	"crypto/pbkdf2"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"
	"time"
)

// Session lifetimes are fixed by the build; general settings report them read-only.
const (
	accessTokenLifetime    = 15 * time.Minute
	refreshSessionLifetime = 14 * 24 * time.Hour
)

const passwordIterations = 600000

// Only the new Go hash format is supported. There is no Flask hash fallback.
func hashPassword(password string) (string, error) {
	if len(password) < 12 || len(password) > 1024 {
		return "", errors.New("password must contain 12 to 1024 bytes")
	}
	salt := make([]byte, 32)
	if _, err := rand.Read(salt); err != nil {
		return "", err
	}
	key, err := pbkdf2.Key(sha256.New, password, salt, passwordIterations, 32)
	if err != nil {
		return "", err
	}
	return "mum-pbkdf2-sha256$" + base64.RawStdEncoding.EncodeToString(salt) + "$" + base64.RawStdEncoding.EncodeToString(key), nil
}

func verifyPassword(encoded, password string) bool {
	parts := strings.Split(encoded, "$")
	if len(parts) != 3 || parts[0] != "mum-pbkdf2-sha256" || len(password) > 1024 {
		return false
	}
	salt, err := base64.RawStdEncoding.DecodeString(parts[1])
	if err != nil || len(salt) != 32 {
		return false
	}
	want, err := base64.RawStdEncoding.DecodeString(parts[2])
	if err != nil || len(want) != 32 {
		return false
	}
	got, err := pbkdf2.Key(sha256.New, password, salt, passwordIterations, 32)
	return err == nil && subtle.ConstantTimeCompare(got, want) == 1
}

func randomToken() string {
	bytes := make([]byte, 32)
	if _, err := rand.Read(bytes); err != nil {
		panic(err)
	}
	return base64.RawURLEncoding.EncodeToString(bytes)
}
func tokenHash(token string) string { return fmt.Sprintf("%x", sha256.Sum256([]byte(token))) }

type Principal struct {
	ID          int64    `json:"id"`
	UUID        string   `json:"uuid"`
	Username    string   `json:"username"`
	DisplayName string   `json:"display_name"`
	Kind        string   `json:"user_type"`
	Active      bool     `json:"is_active"`
	CreatedAt   string   `json:"created_at"`
	Admin       bool     `json:"has_admin_access"`
	Permissions []string `json:"permissions"`
}

type queryRower interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
}

func loadPrincipal(ctx context.Context, db queryRower, uuid string) (Principal, error) {
	p := Principal{Permissions: []string{}}
	err := db.QueryRowContext(ctx, `SELECT i.id,u.uuid,coalesce(u.local_username,''),coalesce(`+humanNameSQL("u")+`,''),u.kind,u.is_active,u.created_at,
	 (u.kind='owner' OR EXISTS(SELECT 1 FROM admin_privileges a JOIN admin_role_permissions rp ON rp.role_id=a.role_id
	 JOIN admin_permissions perm ON perm.id=rp.permission_id WHERE a.user_uuid=u.uuid AND perm.name='administrator'))
	 FROM user_accounts u JOIN identities i ON i.uuid=u.uuid WHERE u.uuid=? AND u.is_active=1
	 AND (u.access_expires_at IS NULL OR julianday(u.access_expires_at)>julianday('now'))`, uuid).Scan(&p.ID, &p.UUID, &p.Username, &p.DisplayName, &p.Kind, &p.Active, &p.CreatedAt, &p.Admin)
	if err != nil {
		return p, ErrForbidden
	}
	if p.Admin {
		p.Permissions = []string{"administrator"}
	}
	return p, nil
}

func (s *Store) Authenticate(ctx context.Context, token string) (Principal, error) {
	if len(token) != 43 {
		return Principal{}, ErrForbidden
	}
	var uuid string
	var origin sessionOrigin
	err := s.reader.QueryRowContext(ctx, `SELECT s.user_uuid,`+sessionOriginColumns+` FROM app_sessions s JOIN session_access_tokens t ON t.session_id=s.id WHERE t.token_hash=? AND t.expires_at>? AND s.refresh_expires_at>?`, tokenHash(token), utcTimestamp(time.Now()), utcTimestamp(time.Now())).Scan(&uuid, &origin.Kind, &origin.Service, &origin.PlexConnection)
	if err != nil {
		return Principal{}, ErrForbidden
	}
	p, err := loadPrincipal(ctx, s.reader, uuid)
	if err != nil {
		return p, err
	}
	if err := sessionOriginAllowed(ctx, s.reader, p, origin); err != nil {
		return Principal{}, err
	}
	return p, nil
}

type sessionTokens struct {
	Access         string
	Refresh        string
	RefreshExpires time.Time
}

func (s *Store) issueSession(ctx context.Context, uuid string, remember bool) (sessionTokens, error) {
	return s.issuePasswordSession(ctx, uuid, "", 0, remember)
}

// The empty hash is reserved for trusted internal callers. Password-authenticated
// HTTP entry points supply the exact hash and profile revision read before KDF
// work. A username change (including change-away-and-back) invalidates that proof.
func (s *Store) issuePasswordSession(ctx context.Context, uuid, verifiedHash string, verifiedRevision int64, remember bool) (sessionTokens, error) {
	var tokens sessionTokens
	err := s.write(ctx, func(tx *sql.Tx) error {
		if verifiedHash != "" {
			var current string
			var revision int64
			if err := tx.QueryRowContext(ctx, "SELECT coalesce(password_hash,''),profile_revision FROM user_accounts WHERE uuid=?", uuid).Scan(&current, &revision); err != nil || current != verifiedHash || verifiedRevision < 1 || revision != verifiedRevision {
				return ErrForbidden
			}
		}
		var err error
		tokens, err = insertSession(ctx, tx, uuid, sessionOrigin{Kind: "password"}, remember)
		return err
	})
	return tokens, err
}

// sessionOrigin is how a session was signed in: "password", "service" (a
// media server login for Service) or "plex_connection" (Plex sign-in through
// the linked PlexConnection).
type sessionOrigin struct {
	Kind, Service, PlexConnection string
}

const sessionOriginColumns = `s.sign_in_origin,coalesce(s.via_service_uuid,''),coalesce(s.via_plex_connection,'')`

// insertSession issues a session inside the caller's transaction, after
// confirming the account may use it now.
func insertSession(ctx context.Context, tx *sql.Tx, uuid string, origin sessionOrigin, remember bool) (sessionTokens, error) {
	tokens := sessionTokens{Access: randomToken(), Refresh: randomToken(), RefreshExpires: time.Now().Add(refreshSessionLifetime)}
	if remember {
		tokens.RefreshExpires = time.Now().Add(30 * 24 * time.Hour)
	}
	p, err := loadPrincipal(ctx, tx, uuid)
	if err != nil {
		return tokens, err
	}
	if err := sessionOriginAllowed(ctx, tx, p, origin); err != nil {
		return tokens, err
	}
	id := newUUID()
	expires := utcTimestamp(time.Now().Add(accessTokenLifetime))
	if _, err := tx.ExecContext(ctx, `INSERT INTO app_sessions(id,user_uuid,access_hash,refresh_hash,access_expires_at,refresh_expires_at,created_at,sign_in_origin,via_service_uuid,via_plex_connection) VALUES(?,?,?,?,?,?,?,?,nullif(?,''),nullif(?,''))`,
		id, uuid, tokenHash(tokens.Access), tokenHash(tokens.Refresh), expires, utcTimestamp(tokens.RefreshExpires), utcTimestamp(time.Now()), origin.Kind, origin.Service, origin.PlexConnection); err != nil {
		return tokens, err
	}
	if _, err := tx.ExecContext(ctx, "INSERT INTO session_access_tokens VALUES(?,?,?)", tokenHash(tokens.Access), id, expires); err != nil {
		return tokens, err
	}
	// Every sign-in passes through here; the Users list shows when an
	// account last signed in.
	_, err = tx.ExecContext(ctx, "UPDATE user_accounts SET last_login_at=? WHERE uuid=?", utcTimestamp(time.Now()), uuid)
	return tokens, err
}

func (s *Store) refreshSession(ctx context.Context, refresh string) (sessionTokens, Principal, error) {
	tokens := sessionTokens{Access: randomToken(), Refresh: randomToken()}
	var p Principal
	if len(refresh) != 43 {
		return tokens, p, ErrForbidden
	}
	err := s.write(ctx, func(tx *sql.Tx) error {
		var id, uuid, expires string
		var origin sessionOrigin
		if err := tx.QueryRowContext(ctx, "SELECT s.id,s.user_uuid,s.refresh_expires_at,"+sessionOriginColumns+" FROM app_sessions s WHERE s.refresh_hash=? AND s.refresh_expires_at>?", tokenHash(refresh), utcTimestamp(time.Now())).Scan(&id, &uuid, &expires, &origin.Kind, &origin.Service, &origin.PlexConnection); err != nil {
			return ErrForbidden
		}
		var err error
		p, err = loadPrincipal(ctx, tx, uuid)
		if err != nil {
			return err
		}
		if err = sessionOriginAllowed(ctx, tx, p, origin); err != nil {
			return err
		}
		tokens.RefreshExpires, err = time.Parse(time.RFC3339Nano, expires)
		if err != nil {
			return err
		}
		expiresAt := utcTimestamp(time.Now().Add(accessTokenLifetime))
		if _, err = tx.ExecContext(ctx, "UPDATE app_sessions SET access_hash=?,refresh_hash=?,access_expires_at=? WHERE id=?", tokenHash(tokens.Access), tokenHash(tokens.Refresh), expiresAt, id); err != nil {
			return err
		}
		_, err = tx.ExecContext(ctx, "INSERT INTO session_access_tokens VALUES(?,?,?)", tokenHash(tokens.Access), id, expiresAt)
		return err
	})
	return tokens, p, err
}
