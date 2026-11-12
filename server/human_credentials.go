package main

import (
	"context"
	"database/sql"
	"net/http"
	"strconv"
	"time"
)

type humanCredentialRecord struct {
	Actor              string `json:"actor_uuid"`
	Target             string `json:"user_uuid"`
	Username           string `json:"username"`
	Active             bool   `json:"is_active"`
	HasPassword        bool   `json:"has_password"`
	Revision           string `json:"credential_revision"`
	ProfileRevision    string `json:"profile_revision"`
	ActivationRevision string `json:"activation_revision"`
	RoleRevision       string `json:"role_revision"`
	CanSetUsername     bool   `json:"can_set_username"`
	CanSetInitial      bool   `json:"can_set_initial"`
	CanReset           bool   `json:"can_reset"`
	Reason             string `json:"availability"`
	SessionsRevoked    bool   `json:"sessions_revoked"`
}

func readHumanCredentials(ctx context.Context, tx *sql.Tx, actor, access, target string) (humanCredentialRecord, error) {
	out := humanCredentialRecord{Actor: actor, Target: target}
	if err := accountPreferenceAuthority(ctx, tx, actor, access); err != nil {
		return out, err
	}
	authority, err := readAdminRoleHierarchyActor(ctx, tx, actor)
	if err != nil {
		return out, err
	}
	if !authority.Owner {
		return out, ErrForbidden
	}
	activation, err := readHumanActivation(ctx, tx, actor, access, target)
	if err != nil {
		return out, err
	}
	out.Username = activation.Username
	out.Active = activation.Active
	out.Reason = activation.Reason
	out.ProfileRevision = activation.ProfileRevision
	out.ActivationRevision = activation.ActivationRevision
	out.RoleRevision = activation.RoleRevision
	var revision int64
	var administrator bool
	if err = tx.QueryRowContext(ctx, `SELECT c.revision,coalesce(u.password_hash,'')<>'',EXISTS(SELECT 1 FROM admin_privileges WHERE user_uuid=u.uuid)
 FROM user_accounts u JOIN human_credential_state c ON c.uuid=u.uuid WHERE u.uuid=?`, target).Scan(&revision, &out.HasPassword, &administrator); err != nil {
		return out, err
	}
	out.Revision = strconv.FormatInt(revision, 10)
	if out.Reason == "protected_owner" || out.Reason == "protected_self" {
		return out, nil
	}
	if administrator && (!out.HasPassword || out.Username == "") {
		out.Reason = "protected_administrator"
		return out, nil
	}
	if out.Reason == "credentials_unavailable" || out.Reason == "expired" {
		out.Reason = "available"
	}
	if out.Reason != "available" {
		return out, nil
	}
	if out.Username == "" && !out.HasPassword {
		out.CanSetUsername = true
		out.CanSetInitial = true
		return out, nil
	}
	username, e := normalizeAccountUsername(out.Username)
	if e != nil || username != out.Username {
		out.Reason = "username_unavailable"
		return out, nil
	}
	out.CanSetInitial = !out.HasPassword
	out.CanReset = out.HasPassword
	return out, nil
}

type humanCredentialInput struct {
	Actor              string `json:"expected_actor_uuid"`
	Target             string `json:"expected_user_uuid"`
	Username           string `json:"expected_username"`
	HasPassword        *bool  `json:"expected_has_password"`
	Revision           string `json:"credential_revision"`
	ProfileRevision    string `json:"profile_revision"`
	ActivationRevision string `json:"activation_revision"`
	RoleRevision       string `json:"role_revision"`
	NewUsername        string `json:"new_username"`
	Operation          string `json:"operation"`
	Current            string `json:"current_owner_password"`
	Replacement        string `json:"new_password"`
	Confirm            string `json:"confirm_password"`
	Revoke             bool   `json:"acknowledge_revoke_sessions"`
	LocalOnly          bool   `json:"acknowledge_local_only"`
}

func matchHumanCredentials(current humanCredentialRecord, in humanCredentialInput) error {
	if in.Actor != current.Actor {
		return ErrForbidden
	}
	if in.Target != current.Target || in.Username != current.Username || in.HasPassword == nil || *in.HasPassword != current.HasPassword || in.Revision != current.Revision || in.ProfileRevision != current.ProfileRevision || in.ActivationRevision != current.ActivationRevision || in.RoleRevision != current.RoleRevision {
		return ErrConflict
	}
	if current.Reason == "protected_owner" || current.Reason == "protected_self" || current.Reason == "protected_administrator" {
		return ErrForbidden
	}
	if current.CanSetUsername {
		normalized, err := normalizeAccountUsername(in.NewUsername)
		if err != nil || normalized != in.NewUsername || current.Username != "" || current.HasPassword {
			return ErrConflict
		}
	} else if in.NewUsername != "" {
		return ErrConflict
	}
	if in.Operation == "set_initial" && current.CanSetInitial || in.Operation == "reset" && current.CanReset {
		return nil
	}
	return ErrConflict
}

func checkInitialCredentialUsername(ctx context.Context, tx *sql.Tx, current humanCredentialRecord, in humanCredentialInput) error {
	if !current.CanSetUsername {
		return nil
	}
	var exists bool
	if err := tx.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM user_accounts WHERE local_username=? COLLATE NOCASE AND uuid<>?)", in.NewUsername, current.Target).Scan(&exists); err != nil {
		return err
	}
	if exists {
		return ErrConflict
	}
	return nil
}

type preparedHumanCredentials struct {
	actor, access, target, actorHash, targetHash, replacement string
	actorRevision                                             int64
	input                                                     humanCredentialInput
}

func (a *App) prepareHumanCredentials(ctx context.Context, actor, access, target string, in humanCredentialInput) (preparedHumanCredentials, error) {
	p := preparedHumanCredentials{actor: actor, access: access, target: target, input: in}
	// Secrets remain request-local; never keep plaintext in the prepared commit.
	p.input.Current = ""
	p.input.Replacement = ""
	p.input.Confirm = ""
	tx, err := a.store.reader.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return p, err
	}
	defer tx.Rollback()
	current, err := readHumanCredentials(ctx, tx, actor, access, target)
	if err == nil {
		err = matchHumanCredentials(current, in)
	}
	if err == nil {
		err = checkInitialCredentialUsername(ctx, tx, current, in)
	}
	if err == nil {
		p.actorHash, err = accountPasswordAuthority(ctx, tx, actor, access)
	}
	if err == nil {
		err = tx.QueryRowContext(ctx, "SELECT revision FROM human_credential_state WHERE uuid=?", actor).Scan(&p.actorRevision)
	}
	if err == nil {
		err = tx.QueryRowContext(ctx, "SELECT coalesce(password_hash,'') FROM user_accounts WHERE uuid=?", target).Scan(&p.targetHash)
	}
	if err == nil {
		err = tx.Commit()
	}
	if err != nil {
		return p, err
	}
	// Verification and replacement KDFs run outside either database transaction.
	if !verifyPassword(p.actorHash, in.Current) {
		return p, errCurrentAccountPassword
	}
	if p.targetHash != "" && verifyPassword(p.targetHash, in.Replacement) {
		return p, ErrConflict
	}
	p.replacement, err = hashPassword(in.Replacement)
	return p, err
}
func commitHumanCredentials(ctx context.Context, tx *sql.Tx, p preparedHumanCredentials) (humanCredentialRecord, error) {
	current, err := readHumanCredentials(ctx, tx, p.actor, p.access, p.target)
	if err != nil {
		return current, err
	}
	if err = matchHumanCredentials(current, p.input); err != nil {
		return current, err
	}
	if err = checkInitialCredentialUsername(ctx, tx, current, p.input); err != nil {
		return current, err
	}
	actorHash, err := accountPasswordAuthority(ctx, tx, p.actor, p.access)
	if err != nil {
		return current, err
	}
	var targetHash string
	if err = tx.QueryRowContext(ctx, "SELECT coalesce(password_hash,'') FROM user_accounts WHERE uuid=?", p.target).Scan(&targetHash); err != nil {
		return current, err
	}
	var actorRevision int64
	if err = tx.QueryRowContext(ctx, "SELECT revision FROM human_credential_state WHERE uuid=?", p.actor).Scan(&actorRevision); err != nil {
		return current, err
	}
	if actorRevision != p.actorRevision || actorHash != p.actorHash || targetHash != p.targetHash || p.replacement == "" {
		return current, ErrConflict
	}
	now := utcTimestamp(time.Now())
	if current.CanSetUsername {
		_, err = tx.ExecContext(ctx, "UPDATE user_accounts SET local_username=?,password_hash=?,force_password_change=0,profile_revision=profile_revision+1,updated_at=? WHERE uuid=?", p.input.NewUsername, p.replacement, now, p.target)
	} else {
		_, err = tx.ExecContext(ctx, "UPDATE user_accounts SET password_hash=?,force_password_change=0,profile_revision=profile_revision+1,updated_at=? WHERE uuid=?", p.replacement, now, p.target)
	}
	if err != nil {
		return current, err
	}
	if err = revokeHumanSignIn(ctx, tx, p.target, now); err != nil {
		return current, err
	}
	if _, err = tx.ExecContext(ctx, `INSERT INTO audit_events(actor_uuid,action,details,occurred_at) VALUES(?,'account.credentials.change',json_object('target_uuid',?,'operation',?,'sessions_revoked',json('true'),'local_only',json('true')),?)`, p.actor, p.target, p.input.Operation, now); err != nil {
		return current, err
	}
	current, err = readHumanCredentials(ctx, tx, p.actor, p.access, p.target)
	current.SessionsRevoked = true
	return current, err
}
func (a *App) humanCredentials(w http.ResponseWriter, r *http.Request) {
	actor, ok := a.principal(w, r, true)
	if !ok {
		return
	}
	if r.URL.RawQuery != "" {
		fail(w, 400, "INVALID_SELECTION", "Select one local human profile")
		return
	}
	if r.Method == http.MethodGet {
		tx, err := a.store.reader.BeginTx(r.Context(), &sql.TxOptions{ReadOnly: true})
		if err != nil {
			domainError(w, err)
			return
		}
		defer tx.Rollback()
		out, err := readHumanCredentials(r.Context(), tx, actor.UUID, bearer(r), r.PathValue("user"))
		if err == nil {
			err = tx.Commit()
		}
		if err != nil {
			domainError(w, err)
			return
		}
		respond(w, 200, out)
		return
	}
	var in humanCredentialInput
	if !decodeStrictBody(w, r, &in) {
		return
	}
	if in.Actor != actor.UUID {
		domainError(w, ErrForbidden)
		return
	}
	if in.HasPassword == nil || !in.Revoke || !in.LocalOnly || (in.Operation != "set_initial" && in.Operation != "reset") || len(in.Current) < 12 || len(in.Current) > 1024 || len(in.Replacement) < 12 || len(in.Replacement) > 1024 || in.Replacement != in.Confirm || in.Replacement == in.Current {
		fail(w, 400, "INVALID_CREDENTIAL_CHANGE", "Provide matching distinct local passwords and acknowledge local-only session revocation")
		return
	}
	if in.NewUsername != "" {
		name, err := normalizeAccountUsername(in.NewUsername)
		if err != nil || name != in.NewUsername {
			fail(w, 400, "INVALID_CREDENTIAL_CHANGE", "Use an exact printable ASCII username of 1–255 bytes")
			return
		}
	}
	if !a.passwordAdmission(w, r) {
		return
	}
	defer func() { <-a.passwordSlots }()
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()
	p, err := a.prepareHumanCredentials(ctx, actor.UUID, bearer(r), r.PathValue("user"), in)
	var out humanCredentialRecord
	if err == nil {
		err = a.store.write(ctx, func(tx *sql.Tx) error { var e error; out, e = commitHumanCredentials(ctx, tx, p); return e })
	}
	if err == errCurrentAccountPassword {
		fail(w, 403, "CURRENT_PASSWORD_INVALID", "Current owner password could not be verified")
		return
	}
	if err != nil {
		domainError(w, err)
		return
	}
	a.hub.closeAccountConnections(out.Target)
	respond(w, 200, out)
}
