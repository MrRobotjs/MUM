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
	"strconv"
	"strings"
	"time"

	"golang.org/x/crypto/argon2"
)

// accessTokenLifetime is how long an access key lasts before the browser
// renews it; how long a sign-in lasts is set in General settings (sessions.go).
const accessTokenLifetime = 15 * time.Minute

// Passwords are stored with Argon2id at the OWASP Password Storage Cheat
// Sheet minimum: 19 MiB of memory, 2 iterations, 1 degree of parallelism, a
// 16-byte random salt and a 32-byte key, in the standard PHC string format
// ($argon2id$v=19$m=19456,t=2,p=1$salt$key). Hashes made before Argon2id
// (PBKDF2-SHA256, 600,000 iterations) still verify, and a successful sign-in
// replaces them, or any Argon2id hash with other parameters, with the
// current one.

// owaspArgon2 is the OWASP minimum cost; argon2Params is the cost of every
// new hash. argon2Params is a variable only so the test binary can lower it
// (testing_speed_test.go); nothing in the application changes it.
var (
	owaspArgon2  = argon2Cost{memory: 19 * 1024, time: 2, threads: 1}
	argon2Params = owaspArgon2
)

type argon2Cost struct {
	memory  uint32 // KiB
	time    uint32
	threads uint8
}

const (
	argon2SaltLen = 16
	argon2KeyLen  = 32
)

// passwordIterations is the PBKDF2 cost of a hash made before Argon2id. It is
// a variable only so the test binary can lower it.
var passwordIterations = 600000

func hashPassword(password string) (string, error) {
	if !passwordLongEnough(password) || len(password) > 1024 {
		return "", errors.New("password must be 12 to 1024 characters")
	}
	return newPasswordHash(password)
}

// newPasswordHash hashes an already accepted password at the current cost.
func newPasswordHash(password string) (string, error) {
	salt := make([]byte, argon2SaltLen)
	if _, err := rand.Read(salt); err != nil {
		return "", err
	}
	c := argon2Params
	key := argon2.IDKey([]byte(password), salt, c.time, c.memory, c.threads, argon2KeyLen)
	return fmt.Sprintf("$argon2id$v=%d$m=%d,t=%d,p=%d$%s$%s", argon2.Version, c.memory, c.time, c.threads,
		base64.RawStdEncoding.EncodeToString(salt), base64.RawStdEncoding.EncodeToString(key)), nil
}

// parseArgon2id reads a PHC Argon2id hash. Costs above these bounds are
// refused, so a tampered hash can't make a sign-in exhaust memory or time.
func parseArgon2id(encoded string) (cost argon2Cost, salt, key []byte, ok bool) {
	parts := strings.Split(encoded, "$")
	if len(parts) != 6 || parts[0] != "" || parts[1] != "argon2id" || parts[2] != "v="+strconv.Itoa(argon2.Version) {
		return cost, nil, nil, false
	}
	var m, t, p uint64
	for _, field := range strings.Split(parts[3], ",") {
		name, value, found := strings.Cut(field, "=")
		n, err := strconv.ParseUint(value, 10, 32)
		if !found || err != nil {
			return cost, nil, nil, false
		}
		switch name {
		case "m":
			m = n
		case "t":
			t = n
		case "p":
			p = n
		default:
			return cost, nil, nil, false
		}
	}
	if m < 8 || m > 256*1024 || t < 1 || t > 16 || p < 1 || p > 8 {
		return cost, nil, nil, false
	}
	salt, err := base64.RawStdEncoding.DecodeString(parts[4])
	if err != nil || len(salt) < 16 || len(salt) > 64 {
		return cost, nil, nil, false
	}
	key, err = base64.RawStdEncoding.DecodeString(parts[5])
	if err != nil || len(key) < 16 || len(key) > 64 {
		return cost, nil, nil, false
	}
	return argon2Cost{memory: uint32(m), time: uint32(t), threads: uint8(p)}, salt, key, true
}

// passwordNeedsRehash reports whether a stored hash isn't an Argon2id hash at
// the current cost.
func passwordNeedsRehash(encoded string) bool {
	cost, salt, key, ok := parseArgon2id(encoded)
	return !ok || cost != argon2Params || len(salt) != argon2SaltLen || len(key) != argon2KeyLen
}

func verifyPassword(encoded, password string) bool {
	if len(password) > 1024 {
		return false
	}
	if strings.HasPrefix(encoded, "$argon2id$") {
		cost, salt, want, ok := parseArgon2id(encoded)
		if !ok {
			return false
		}
		got := argon2.IDKey([]byte(password), salt, cost.time, cost.memory, cost.threads, uint32(len(want)))
		return subtle.ConstantTimeCompare(got, want) == 1
	}
	parts := strings.Split(encoded, "$")
	if len(parts) != 3 || parts[0] != "mum-pbkdf2-sha256" {
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
	err := s.reader.QueryRowContext(ctx, `SELECT s.user_uuid,`+sessionOriginColumns+` FROM app_sessions s JOIN session_access_tokens t ON t.session_id=s.id WHERE t.token_hash=? AND t.expires_at>? AND s.refresh_expires_at>?`, tokenHash(token), utcTimestamp(time.Now()), utcTimestamp(time.Now())).Scan(&uuid, &origin.Kind, &origin.Service, &origin.PlexConnection, &origin.Discord)
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
	Remember       bool
}

func (s *Store) issueSession(ctx context.Context, uuid string, remember bool) (sessionTokens, error) {
	return s.issuePasswordSession(ctx, uuid, "", 0, remember)
}

// The empty hash is reserved for trusted internal callers. Password-authenticated
// HTTP entry points supply the exact hash and profile revision read before KDF
// work. A username change (including change-away-and-back) invalidates that proof.
func (s *Store) issuePasswordSession(ctx context.Context, uuid, verifiedHash string, verifiedRevision int64, remember bool) (sessionTokens, error) {
	return s.issuePasswordSessionWithUpgrade(ctx, uuid, verifiedHash, verifiedRevision, remember, "")
}

func (s *Store) issuePasswordSessionWithUpgrade(ctx context.Context, uuid, verifiedHash string, verifiedRevision int64, remember bool, upgradedHash string) (sessionTokens, error) {
	var tokens sessionTokens
	err := s.write(ctx, func(tx *sql.Tx) error {
		if verifiedHash != "" {
			var current string
			var revision int64
			if err := tx.QueryRowContext(ctx, "SELECT coalesce(password_hash,''),profile_revision FROM user_accounts WHERE uuid=?", uuid).Scan(&current, &revision); err != nil || current != verifiedHash || verifiedRevision < 1 || revision != verifiedRevision {
				return ErrForbidden
			}
		}
		if upgradedHash != "" {
			if _, err := tx.ExecContext(ctx, "UPDATE user_accounts SET password_hash=? WHERE uuid=? AND password_hash=?", upgradedHash, uuid, verifiedHash); err != nil {
				return err
			}
		}
		var err error
		tokens, err = insertSession(ctx, tx, uuid, sessionOrigin{Kind: "password"}, remember)
		return err
	})
	return tokens, err
}

// sessionOrigin is how a session was signed in: "password", "service" (a
// media server login for Service), "plex_connection" (Plex sign-in through
// the linked PlexConnection) or "discord" (the linked Discord account).
type sessionOrigin struct {
	Kind, Service, PlexConnection, Discord string
}

const sessionOriginColumns = `s.sign_in_origin,coalesce(s.via_service_uuid,''),coalesce(s.via_plex_connection,''),coalesce(s.via_discord_id,'')`

// insertSession issues a session inside the caller's transaction, after
// confirming the account may use it now.
// insertSession signs uuid in. Its length comes from the session settings
// (sessionLimits). Remember controls browser cookie persistence.
// The device is the request's (withSessionDevice).
func insertSession(ctx context.Context, tx *sql.Tx, uuid string, origin sessionOrigin, remember bool) (sessionTokens, error) {
	now := time.Now()
	// Bound cleanup work per sign-in; foreign keys remove the session's old keys.
	if _, err := tx.ExecContext(ctx, "DELETE FROM app_sessions WHERE id IN (SELECT id FROM app_sessions WHERE refresh_expires_at<=? LIMIT 100)", utcTimestamp(now)); err != nil {
		return sessionTokens{}, err
	}
	idle, max := sessionLimits(ctx, tx)
	tokens := sessionTokens{Access: randomToken(), Refresh: randomToken(), RefreshExpires: sessionExpiry(now, now, idle, max), Remember: remember}
	p, err := loadPrincipal(ctx, tx, uuid)
	if err != nil {
		return tokens, err
	}
	if err := sessionOriginAllowed(ctx, tx, p, origin); err != nil {
		return tokens, err
	}
	id := newUUID()
	expires := utcTimestamp(time.Now().Add(accessTokenLifetime))
	device := deviceFrom(ctx)
	if _, err := tx.ExecContext(ctx, `INSERT INTO app_sessions(id,user_uuid,access_hash,refresh_hash,access_expires_at,refresh_expires_at,created_at,sign_in_origin,via_service_uuid,via_plex_connection,via_discord_id,last_used_at,user_agent,client_ip,remember_device) VALUES(?,?,?,?,?,?,?,?,nullif(?,''),nullif(?,''),nullif(?,''),?,nullif(?,''),nullif(?,''),?)`,
		id, uuid, tokenHash(tokens.Access), tokenHash(tokens.Refresh), expires, utcTimestamp(tokens.RefreshExpires), utcTimestamp(now), origin.Kind, origin.Service, origin.PlexConnection, origin.Discord, utcTimestamp(now), device.userAgent, device.ip, remember); err != nil {
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

// errRefreshReused reports a refresh key presented again after it was
// replaced and the grace period passed: the session has been ended.
var errRefreshReused = errors.New("refresh key reused")

// refreshSession renews a session from its refresh key. A session past its
// inactivity timeout or maximum length (as the settings are now) is ended. The
// key a session replaced last, presented within refreshReuseGrace, gets a new
// access key without another rotation (two tabs renewing at once); presented
// later, it ends the session and returns errRefreshReused. A renewal without a
// new refresh key returns tokens with an empty Refresh.
func (s *Store) refreshSession(ctx context.Context, refresh string) (sessionTokens, Principal, error) {
	tokens := sessionTokens{Access: randomToken(), Refresh: randomToken()}
	var p Principal
	if len(refresh) != 43 {
		return tokens, p, ErrForbidden
	}
	reused := false
	expired := false
	err := s.write(ctx, func(tx *sql.Tx) error {
		now := time.Now()
		var id, uuid, created, lastUsed string
		var rotated sql.NullString
		var mostRecent bool
		var remember bool
		var origin sessionOrigin
		grace := false
		err := tx.QueryRowContext(ctx, "SELECT s.id,s.user_uuid,s.created_at,coalesce(s.last_used_at,s.created_at),s.remember_device,"+sessionOriginColumns+" FROM app_sessions s WHERE s.refresh_hash=?", tokenHash(refresh)).Scan(&id, &uuid, &created, &lastUsed, &remember, &origin.Kind, &origin.Service, &origin.PlexConnection, &origin.Discord)
		if errors.Is(err, sql.ErrNoRows) {
			err = tx.QueryRowContext(ctx, "SELECT s.id,s.user_uuid,s.created_at,coalesce(s.last_used_at,s.created_at),h.rotated_at,(h.token_hash=s.previous_refresh_hash),s.remember_device,"+sessionOriginColumns+" FROM session_refresh_history h JOIN app_sessions s ON s.id=h.session_id WHERE h.token_hash=?", tokenHash(refresh)).Scan(&id, &uuid, &created, &lastUsed, &rotated, &mostRecent, &remember, &origin.Kind, &origin.Service, &origin.PlexConnection, &origin.Discord)
			if err != nil {
				return ErrForbidden
			}
			at, perr := time.Parse(time.RFC3339Nano, rotated.String)
			if !mostRecent || !rotated.Valid || perr != nil || now.Sub(at) > refreshReuseGrace {
				if _, err := tx.ExecContext(ctx, "DELETE FROM app_sessions WHERE id=?", id); err != nil {
					return err
				}
				reused = true
				p.UUID = uuid
				return auditAction(ctx, tx, uuid, "session.refresh_reused")
			}
			grace = true
		} else if err != nil {
			return ErrForbidden
		}
		createdAt, err1 := time.Parse(time.RFC3339Nano, created)
		usedAt, err2 := time.Parse(time.RFC3339Nano, lastUsed)
		idle, max := sessionLimits(ctx, tx)
		if err1 != nil || err2 != nil || !sessionExpiry(createdAt, usedAt, idle, max).After(now) {
			if _, err := tx.ExecContext(ctx, "DELETE FROM app_sessions WHERE id=?", id); err != nil {
				return err
			}
			expired = true
			return nil
		}
		if p, err = loadPrincipal(ctx, tx, uuid); err != nil {
			return err
		}
		if err = sessionOriginAllowed(ctx, tx, p, origin); err != nil {
			return err
		}
		usedForExpiry := now
		if background, _ := ctx.Value(backgroundRefreshKey{}).(bool); background {
			usedForExpiry = usedAt
		}
		tokens.RefreshExpires = sessionExpiry(createdAt, usedForExpiry, idle, max)
		tokens.Remember = remember
		accessExpires := utcTimestamp(now.Add(accessTokenLifetime))
		device := deviceFrom(ctx)
		if grace {
			tokens.Refresh = ""
			if _, err = tx.ExecContext(ctx, "UPDATE app_sessions SET access_hash=?,access_expires_at=?,last_used_at=?,refresh_expires_at=? WHERE id=?", tokenHash(tokens.Access), accessExpires, utcTimestamp(usedForExpiry), utcTimestamp(tokens.RefreshExpires), id); err != nil {
				return err
			}
		} else {
			if _, err = tx.ExecContext(ctx, "INSERT INTO session_refresh_history(token_hash,session_id,rotated_at) VALUES(?,?,?)", tokenHash(refresh), id, utcTimestamp(now)); err != nil {
				return err
			}
			if _, err = tx.ExecContext(ctx, `UPDATE app_sessions SET access_hash=?,previous_refresh_hash=refresh_hash,refresh_hash=?,rotated_at=?,access_expires_at=?,last_used_at=?,refresh_expires_at=?,
		 user_agent=coalesce(nullif(?,''),user_agent),client_ip=coalesce(nullif(?,''),client_ip) WHERE id=?`,
				tokenHash(tokens.Access), tokenHash(tokens.Refresh), utcTimestamp(now), accessExpires, utcTimestamp(usedForExpiry), utcTimestamp(tokens.RefreshExpires), device.userAgent, device.ip, id); err != nil {
				return err
			}
		}
		_, err = tx.ExecContext(ctx, "INSERT INTO session_access_tokens VALUES(?,?,?)", tokenHash(tokens.Access), id, accessExpires)
		return err
	})
	if err == nil && reused {
		return tokens, p, errRefreshReused
	}
	if err == nil && expired {
		return tokens, p, ErrForbidden
	}
	return tokens, p, err
}
