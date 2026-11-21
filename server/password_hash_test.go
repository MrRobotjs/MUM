package main

import (
	"crypto/pbkdf2"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"strings"
	"testing"
)

// The application's cost is the OWASP Password Storage minimum for Argon2id.
func TestPasswordHashCost(t *testing.T) {
	if owaspArgon2 != (argon2Cost{memory: 19 * 1024, time: 2, threads: 1}) || argon2SaltLen < 16 || argon2KeyLen != 32 {
		t.Fatalf("Argon2id cost %+v, salt %d, key %d", owaspArgon2, argon2SaltLen, argon2KeyLen)
	}
	// Hashing at the real cost produces the standard PHC string and verifies.
	saved := argon2Params
	argon2Params = owaspArgon2
	defer func() { argon2Params = saved }()
	hash, err := hashPassword("correct horse battery staple")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(hash, "$argon2id$v=19$m=19456,t=2,p=1$") || passwordNeedsRehash(hash) {
		t.Fatal(hash)
	}
	if !verifyPassword(hash, "correct horse battery staple") || verifyPassword(hash, "correct horse battery stapler") {
		t.Fatal("verification")
	}
}

// legacyHash is a PBKDF2 hash in the format used before Argon2id.
func legacyHash(t *testing.T, password string) string {
	t.Helper()
	salt := make([]byte, 32)
	_, _ = rand.Read(salt)
	key, err := pbkdf2.Key(sha256.New, password, salt, passwordIterations, 32)
	if err != nil {
		t.Fatal(err)
	}
	return "mum-pbkdf2-sha256$" + base64.RawStdEncoding.EncodeToString(salt) + "$" + base64.RawStdEncoding.EncodeToString(key)
}

func TestPasswordHashFormats(t *testing.T) {
	old := legacyHash(t, "an older password 1")
	if !verifyPassword(old, "an older password 1") || verifyPassword(old, "an older password 2") || !passwordNeedsRehash(old) {
		t.Fatal("PBKDF2 hashes keep verifying and are due for replacement")
	}
	current, _ := hashPassword("a current password")
	weaker := strings.Replace(current, "t=1", "t=3", 1)
	if passwordNeedsRehash(current) || !passwordNeedsRehash(weaker) {
		t.Fatal("a hash at another cost is due for replacement")
	}
	// Tampered or unbounded hashes never verify.
	for _, bad := range []string{
		strings.Replace(current, "m=64", "m=999999999", 1),
		strings.Replace(current, "p=1", "p=0", 1),
		strings.Replace(current, "v=19", "v=16", 1),
		strings.Replace(current, "$argon2id$", "$argon2i$", 1),
		"$argon2id$v=19$m=64,t=1,p=1$c2hvcnQ$c2hvcnQ",
		"pbkdf2:sha256:600000$salt$hash",
		"",
	} {
		if verifyPassword(bad, "a current password") {
			t.Fatalf("accepted %q", bad)
		}
	}
}

// Signing in with a password stored the older way replaces its hash with an
// Argon2id one; the session works and the next sign-in uses the new hash.
func TestSignInUpgradesPasswordHash(t *testing.T) {
	a, s := testApp(t)
	_, _ = bootstrapOwner(t, a)
	activityExec(t, s, "UPDATE user_accounts SET password_hash=? WHERE kind='owner'", legacyHash(t, "a-strong-new-password"))
	var username string
	_ = s.reader.QueryRow("SELECT local_username FROM user_accounts WHERE kind='owner'").Scan(&username)
	for round := 0; round < 2; round++ {
		w := apiRequest(a, "POST", "/api/auth/login", "", map[string]any{"username": username, "password": "a-strong-new-password"}, nil)
		if w.Code != 200 {
			t.Fatal(round, w.Code, w.Body.String())
		}
		session := responseData(t, w)
		if session["access_token"] == nil {
			t.Fatal(round, session)
		}
		access, _ := session["access_token"].(string)
		if w := apiRequest(a, "GET", "/api/auth/session", access, nil, nil); w.Code != 200 {
			t.Fatal("the session after the upgrade doesn't work", w.Code)
		}
		var stored string
		_ = s.reader.QueryRow("SELECT password_hash FROM user_accounts WHERE kind='owner'").Scan(&stored)
		if !strings.HasPrefix(stored, "$argon2id$") || passwordNeedsRehash(stored) {
			t.Fatal(round, "hash not upgraded", stored)
		}
	}
	// A wrong password changes nothing.
	activityExec(t, s, "UPDATE user_accounts SET password_hash=? WHERE kind='owner'", legacyHash(t, "a-strong-new-password"))
	if w := apiRequest(a, "POST", "/api/auth/login", "", map[string]any{"username": username, "password": "not the password at all"}, nil); w.Code != 401 {
		t.Fatal(w.Code)
	}
	var stored string
	_ = s.reader.QueryRow("SELECT password_hash FROM user_accounts WHERE kind='owner'").Scan(&stored)
	if !strings.HasPrefix(stored, "mum-pbkdf2-sha256$") {
		t.Fatal("a failed sign-in replaced the hash")
	}
}

func TestPasswordUpgradeFailureDoesNotIssueSession(t *testing.T) {
	a, s := testApp(t)
	bootstrapOwner(t, a)
	activityExec(t, s, "UPDATE user_accounts SET password_hash=? WHERE kind='owner'", legacyHash(t, "a-strong-new-password"))
	activityExec(t, s, "CREATE TRIGGER reject_hash_upgrade BEFORE UPDATE OF password_hash ON user_accounts BEGIN SELECT RAISE(ABORT, 'upgrade failed'); END")
	before := countRows(t, s, "SELECT count(*) FROM app_sessions")
	w := apiRequest(a, "POST", "/api/auth/login", "", map[string]any{"username": "owner", "password": "a-strong-new-password"}, nil)
	if w.Code == 200 || countRows(t, s, "SELECT count(*) FROM app_sessions") != before {
		t.Fatal("failed upgrade issued a session", w.Code)
	}
}
