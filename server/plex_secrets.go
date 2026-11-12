package main

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/ed25519"
	"crypto/rand"
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"time"
)

// Separate key and durable fingerprint: losing the key must never silently
// generate a replacement, even after all authorization/connection rows expire.
func (s *Store) plexAEAD(ctx context.Context, create bool) (cipher.AEAD, error) {
	s.secretsMu.Lock()
	defer s.secretsMu.Unlock()
	var expected string
	err := s.reader.QueryRowContext(ctx, "SELECT key_hash FROM plex_key_metadata WHERE id=1").Scan(&expected)
	if err != nil && err != sql.ErrNoRows {
		return nil, err
	}
	path := filepath.Join(s.dataDir, "plex.key")
	key, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) && create && expected == "" {
		var existing bool
		if err := s.reader.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM plex_authorizations) OR EXISTS(SELECT 1 FROM plex_connections) OR EXISTS(SELECT 1 FROM plex_invitation_authorizations) OR EXISTS(SELECT 1 FROM plex_invitation_credentials)").Scan(&existing); err != nil {
			return nil, err
		}
		if existing {
			return nil, errPlexAuthentication
		}
		key = make([]byte, 32)
		if _, err = io.ReadFull(rand.Reader, key); err != nil {
			return nil, err
		}
		file, openErr := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
		if openErr != nil {
			return nil, openErr
		}
		_, writeErr := file.Write(key)
		syncErr := file.Sync()
		closeErr := file.Close()
		err = errors.Join(writeErr, syncErr, closeErr)
	}
	if err != nil || len(key) != 32 {
		return nil, errPlexAuthentication
	}
	digest := tokenHash(string(key))
	if expected != "" && expected != digest {
		return nil, errPlexAuthentication
	}
	if expected == "" {
		if !create {
			return nil, errPlexAuthentication
		}
		if err := s.write(ctx, func(tx *sql.Tx) error {
			if _, err := tx.ExecContext(ctx, "INSERT INTO plex_key_metadata(id,key_hash) VALUES(1,?) ON CONFLICT(id) DO NOTHING", digest); err != nil {
				return err
			}
			var current string
			if err := tx.QueryRowContext(ctx, "SELECT key_hash FROM plex_key_metadata WHERE id=1").Scan(&current); err != nil {
				return err
			}
			if current != digest {
				return errPlexAuthentication
			}
			return nil
		}); err != nil {
			return nil, err
		}
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(block)
}

// This DTO is serialized only inside authenticated encryption, never to HTTP.
type plexStoredCredential struct {
	ClientID   string    `json:"client_id"`
	KeyID      string    `json:"key_id"`
	PrivateKey []byte    `json:"private_key"`
	PINID      int64     `json:"pin_id"`
	PINCode    string    `json:"pin_code"`
	Expires    time.Time `json:"expires"`
	AccountID  string    `json:"account_id"`
	Token      string    `json:"token"`
}

func (plexStoredCredential) MarshalJSON() ([]byte, error) {
	return nil, errors.New("Plex credentials require authenticated encryption")
}

func (s *Store) sealPlexCredential(ctx context.Context, purpose string, value plexStoredCredential) ([]byte, error) {
	aead, err := s.plexAEAD(ctx, true)
	if err != nil {
		return nil, err
	}
	type encryptedPayload plexStoredCredential
	plain, err := json.Marshal(encryptedPayload(value))
	if err != nil {
		return nil, err
	}
	nonce := make([]byte, aead.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return nil, err
	}
	return aead.Seal(nonce, nonce, plain, []byte("plex.v1:"+purpose)), nil
}
func (s *Store) openPlexCredential(ctx context.Context, purpose string, data []byte) (plexStoredCredential, error) {
	var value plexStoredCredential
	aead, err := s.plexAEAD(ctx, false)
	if err != nil {
		return value, err
	}
	if len(data) < aead.NonceSize()+aead.Overhead() {
		return value, errPlexAuthentication
	}
	plain, err := aead.Open(nil, data[:aead.NonceSize()], data[aead.NonceSize():], []byte("plex.v1:"+purpose))
	if err != nil || json.Unmarshal(plain, &value) != nil {
		return value, errPlexAuthentication
	}
	if !validProvisionedID(value.ClientID) || !validProvisionedID(value.KeyID) || len(value.PrivateKey) != ed25519.PrivateKeySize {
		return plexStoredCredential{}, errPlexAuthentication
	}
	// Reject a corrupted private/public pair instead of emitting invalid assertions.
	derived := ed25519.NewKeyFromSeed(value.PrivateKey[:ed25519.SeedSize])
	if !ed25519.PrivateKey(derived).Equal(ed25519.PrivateKey(value.PrivateKey)) {
		return plexStoredCredential{}, errPlexAuthentication
	}
	return value, nil
}
