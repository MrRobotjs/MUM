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
	err := db.QueryRowContext(ctx, `SELECT i.id,u.uuid,coalesce(u.local_username,''),u.kind,u.is_active,u.created_at,
	 (u.kind='owner' OR EXISTS(SELECT 1 FROM admin_privileges a JOIN admin_role_permissions rp ON rp.role_id=a.role_id
	 JOIN admin_permissions perm ON perm.id=rp.permission_id WHERE a.user_uuid=u.uuid AND perm.name='administrator'))
	 FROM user_accounts u JOIN identities i ON i.uuid=u.uuid WHERE u.uuid=? AND u.is_active=1
	 AND (u.access_expires_at IS NULL OR julianday(u.access_expires_at)>julianday('now'))`, uuid).Scan(&p.ID, &p.UUID, &p.Username, &p.Kind, &p.Active, &p.CreatedAt, &p.Admin)
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
	err := s.reader.QueryRowContext(ctx, `SELECT s.user_uuid FROM app_sessions s JOIN session_access_tokens t ON t.session_id=s.id WHERE t.token_hash=? AND t.expires_at>? AND s.refresh_expires_at>?`, tokenHash(token), utcTimestamp(time.Now()), utcTimestamp(time.Now())).Scan(&uuid)
	if err != nil {
		return Principal{}, ErrForbidden
	}
	return loadPrincipal(ctx, s.reader, uuid)
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
	tokens := sessionTokens{Access: randomToken(), Refresh: randomToken(), RefreshExpires: time.Now().Add(refreshSessionLifetime)}
	if remember {
		tokens.RefreshExpires = time.Now().Add(30 * 24 * time.Hour)
	}
	err := s.write(ctx, func(tx *sql.Tx) error {
		if verifiedHash != "" {
			var current string
			var revision int64
			if err := tx.QueryRowContext(ctx, "SELECT coalesce(password_hash,''),profile_revision FROM user_accounts WHERE uuid=?", uuid).Scan(&current, &revision); err != nil || current != verifiedHash || verifiedRevision < 1 || revision != verifiedRevision {
				return ErrForbidden
			}
		}
		if _, err := loadPrincipal(ctx, tx, uuid); err != nil {
			return err
		}
		id := newUUID()
		expires := utcTimestamp(time.Now().Add(accessTokenLifetime))
		if _, err := tx.ExecContext(ctx, `INSERT INTO app_sessions VALUES(?,?,?,?,?,?,?)`, id, uuid, tokenHash(tokens.Access), tokenHash(tokens.Refresh), expires, utcTimestamp(tokens.RefreshExpires), utcTimestamp(time.Now())); err != nil {
			return err
		}
		_, err := tx.ExecContext(ctx, "INSERT INTO session_access_tokens VALUES(?,?,?)", tokenHash(tokens.Access), id, expires)
		return err
	})
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
		if err := tx.QueryRowContext(ctx, "SELECT id,user_uuid,refresh_expires_at FROM app_sessions WHERE refresh_hash=? AND refresh_expires_at>?", tokenHash(refresh), utcTimestamp(time.Now())).Scan(&id, &uuid, &expires); err != nil {
			return ErrForbidden
		}
		var err error
		p, err = loadPrincipal(ctx, tx, uuid)
		if err != nil {
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
