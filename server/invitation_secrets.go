package main

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"errors"
	"io"
	"os"
	"path/filepath"
)

// Keep the token-recovery key outside SQLite. Back up the entire data directory,
// including invitation.key. A missing/corrupt key must never be silently replaced
// while encrypted invitation records exist.
func (s *Store) invitationAEAD(ctx context.Context, create bool) (cipher.AEAD, error) {
	s.secretsMu.Lock()
	defer s.secretsMu.Unlock()
	path := filepath.Join(s.dataDir, "invitation.key")
	key, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) && create {
		var existing bool
		if err := s.reader.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM invitation_secrets)").Scan(&existing); err != nil {
			return nil, err
		}
		if existing {
			return nil, errors.New("invitation key missing")
		}
		key = make([]byte, 32)
		if _, err = rand.Read(key); err != nil {
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
	if err != nil {
		return nil, err
	}
	if len(key) != 32 {
		return nil, errors.New("invalid invitation key")
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(block)
}

func (s *Store) sealInvitationToken(ctx context.Context, token string) ([]byte, error) {
	aead, err := s.invitationAEAD(ctx, true)
	if err != nil {
		return nil, err
	}
	nonce := make([]byte, aead.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return nil, err
	}
	return aead.Seal(nonce, nonce, []byte(token), []byte("invitation.v1:"+tokenHash(token))), nil
}

func (s *Store) openInvitationToken(ctx context.Context, digest string, encoded []byte) (string, error) {
	aead, err := s.invitationAEAD(ctx, false)
	if err != nil {
		return "", err
	}
	return openInvitationTokenWith(aead, digest, encoded)
}

// openInvitationTokenWith decrypts with an already loaded key, so a list can
// open many rows after one key-file read.
func openInvitationTokenWith(aead cipher.AEAD, digest string, encoded []byte) (string, error) {
	if len(encoded) < aead.NonceSize()+aead.Overhead() {
		return "", errors.New("invalid encrypted invitation")
	}
	plain, err := aead.Open(nil, encoded[:aead.NonceSize()], encoded[aead.NonceSize():], []byte("invitation.v1:"+digest))
	if err != nil {
		return "", err
	}
	token := string(plain)
	if tokenHash(token) != digest {
		return "", errors.New("invalid invitation digest")
	}
	return token, nil
}
