package main

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"
	"unicode/utf8"

	"golang.org/x/term"
)

type offlineOwnerRecovery struct {
	uuid, username, hash string
	credential, profile  int64
}

func readOfflineOwner(ctx context.Context, tx *sql.Tx) (offlineOwnerRecovery, error) {
	var p offlineOwnerRecovery
	if err := tx.QueryRowContext(ctx, `SELECT u.uuid,coalesce(u.local_username,''),coalesce(u.password_hash,''),c.revision,u.profile_revision FROM user_accounts u JOIN human_credential_state c ON c.uuid=u.uuid WHERE u.kind='owner'`).Scan(&p.uuid, &p.username, &p.hash, &p.credential, &p.profile); err != nil {
		return p, errors.New("recovery requires an existing configured owner")
	}
	if !validAdminMemberCursor(p.uuid) || strings.TrimSpace(p.username) == "" || p.hash == "" {
		return p, errors.New("owner has no supported existing local credentials")
	}
	principal, err := loadPrincipal(ctx, tx, p.uuid)
	if err != nil || principal.Kind != "owner" {
		return p, errors.New("owner must be active and unexpired; recovery does not repair account state")
	}
	return p, nil
}
func ownerRecoverySnapshot(ctx context.Context, s *Store) (offlineOwnerRecovery, error) {
	tx, err := s.reader.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return offlineOwnerRecovery{}, err
	}
	defer tx.Rollback()
	p, err := readOfflineOwner(ctx, tx)
	if err == nil {
		err = tx.Commit()
	}
	return p, err
}
func commitOwnerRecovery(ctx context.Context, s *Store, expected offlineOwnerRecovery, replacement string) error {
	if s.directoryLock == nil || replacement == "" {
		return ErrForbidden
	}
	return s.write(ctx, func(tx *sql.Tx) error {
		current, err := readOfflineOwner(ctx, tx)
		if err != nil {
			return err
		}
		if current != expected {
			return ErrConflict
		}
		now := utcTimestamp(time.Now())
		if _, err = tx.ExecContext(ctx, "UPDATE user_accounts SET password_hash=?,force_password_change=0,profile_revision=profile_revision+1,updated_at=? WHERE uuid=? AND kind='owner'", replacement, now, current.uuid); err != nil {
			return err
		}
		if err = revokeHumanSignIn(ctx, tx, current.uuid, now); err != nil {
			return err
		}
		_, err = tx.ExecContext(ctx, `INSERT INTO audit_events(actor_uuid,action,details,occurred_at) VALUES(?,'account.owner.recover',json_object('target_uuid',?,'offline',json('true'),'sessions_revoked',json('true')),?)`, current.uuid, current.uuid, now)
		return err
	})
}

// Bounded raw-terminal line input: no echo, history, shell, file or environment password source.
// Ctrl-C/Ctrl-D cancel locally so the caller's deferred terminal restore always runs.
func readRecoveryLine(ctx context.Context, input io.Reader, previousCR *bool, limit int) ([]byte, error) {
	result := make([]byte, 0, limit)
	valid := false
	defer func() {
		if !valid {
			clear(result[:cap(result)])
		}
	}()
	overflow, bad := false, false
	var b [1]byte
	for {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		if _, err := io.ReadFull(input, b[:]); err != nil {
			return nil, err
		}
		c := b[0]
		if *previousCR {
			*previousCR = false
			if c == '\n' {
				continue
			}
		}
		if c == 3 || c == 4 {
			return nil, errors.New("owner recovery canceled")
		}
		if c == '\r' || c == '\n' {
			*previousCR = c == '\r'
			break
		}
		if c == 8 || c == 127 {
			if len(result) > 0 {
				_, n := utf8.DecodeLastRune(result)
				result = result[:len(result)-n]
			}
			continue
		}
		if c < 32 {
			bad = true
			continue
		}
		if len(result) >= limit {
			overflow = true
			continue
		}
		result = append(result, c)
	}
	if overflow || bad || !utf8.Valid(result) {
		clear(result)
		return nil, errors.New("unsupported or overlong terminal input; recovery was not changed")
	}
	valid = true
	return result, nil
}
func runOwnerRecovery(ctx context.Context, directory string, input, output *os.File) (err error) {
	if strings.TrimSpace(directory) == "" {
		return errors.New("owner recovery requires an explicit existing data directory")
	}
	path, err := filepath.Abs(filepath.Join(directory, "mum.sqlite"))
	if err != nil {
		return err
	}
	s, err := OpenRecoveryStore(ctx, path)
	if err != nil {
		return err
	}
	defer func() { err = errors.Join(err, s.Close()) }()
	owner, err := ownerRecoverySnapshot(ctx, s)
	if err != nil {
		return err
	}
	if !term.IsTerminal(int(input.Fd())) || !term.IsTerminal(int(output.Fd())) {
		return errors.New("owner recovery requires an interactive terminal; passwords cannot be piped")
	}
	state, err := term.MakeRaw(int(input.Fd()))
	if err != nil {
		return err
	}
	defer func() { err = errors.Join(err, term.Restore(int(input.Fd()), state)) }()
	terminal := recoveryTerminal{ctx: ctx, file: input}
	fmt.Fprintf(output, "Offline owner recovery for %q in %q.\r\n", owner.username, s.dataDir)
	fmt.Fprint(output, "This replaces only the local owner password and signs out all owner sessions.\r\nType RECOVER to continue (input hidden): ")
	cr := false
	confirmation, err := readRecoveryLine(ctx, &terminal, &cr, 16)
	fmt.Fprint(output, "\r\n")
	if err != nil {
		return err
	}
	if string(confirmation) != "RECOVER" {
		return errors.New("owner recovery canceled")
	}
	fmt.Fprint(output, "New owner password (12–1024 UTF-8 bytes; input hidden): ")
	password, err := readRecoveryLine(ctx, &terminal, &cr, 1024)
	fmt.Fprint(output, "\r\n")
	if err != nil {
		return err
	}
	defer clear(password)
	if len(password) < 12 {
		return errors.New("password must contain 12–1024 bytes; recovery was not changed")
	}
	fmt.Fprint(output, "Confirm new owner password (input hidden): ")
	repeat, err := readRecoveryLine(ctx, &terminal, &cr, 1024)
	fmt.Fprint(output, "\r\n")
	if err != nil {
		return err
	}
	defer clear(repeat)
	if string(password) != string(repeat) {
		return errors.New("passwords do not match; recovery was not changed")
	}
	if verifyPassword(owner.hash, string(password)) {
		return errors.New("choose a different owner password; recovery was not changed")
	}
	// All KDF work precedes the writer; no application workers or key loaders run.
	replacement, err := hashPassword(string(password))
	if err != nil {
		return err
	}
	if err = commitOwnerRecovery(ctx, s, owner, replacement); err != nil {
		return err
	}
	fmt.Fprint(output, "Owner password recovered. All prior owner sessions were revoked. Start MUM normally and sign in with the new password.\r\n")
	return nil
}
