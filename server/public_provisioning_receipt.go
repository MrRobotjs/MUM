package main

import (
	"context"
	"database/sql"
	"errors"
	"net/http"
	"strings"
	"time"
)

type publicReceiptInput struct {
	JobID     string `json:"job_id"`
	RequestID string `json:"request_id"`
	Username  string `json:"username"`
	Password  string `json:"password"`
}
type publicReceiptAuthority struct{ user, name, hash string }

func (a *App) readPublicReceiptAuthority(ctx context.Context, token string, input publicReceiptInput) (publicReceiptAuthority, error) {
	var auth publicReceiptAuthority
	err := a.store.reader.QueryRowContext(ctx, `SELECT u.uuid,coalesce(j.requested_username,u.local_username,''),coalesce(u.password_hash,'') FROM provisioning_jobs j JOIN invites i ON i.id=j.invite_id JOIN user_accounts u ON u.uuid=j.user_uuid WHERE i.token=? AND j.request_hash=? AND j.id=?`, tokenHash(token), tokenHash(input.RequestID), input.JobID).Scan(&auth.user, &auth.name, &auth.hash)
	return auth, err
}

// Receipt lookup has no reservation/proof/worker fallback. Expired or revoked
// invitations can expose their existing history only to these local credentials.
func (a *App) publicProvisioningReceipt(w http.ResponseWriter, r *http.Request) {
	var input publicReceiptInput
	if !decodeStrictBody(w, r, &input) {
		return
	}
	input.Username = strings.TrimSpace(input.Username)
	if len(r.PathValue("token")) != 43 || !validProvisionedID(input.JobID) || len(input.RequestID) < 32 || len(input.RequestID) > 128 || len(input.Username) < 1 || len(input.Username) > 255 || len(input.Password) < 12 || len(input.Password) > 1024 {
		fail(w, 400, "INVALID_RECEIPT_REFERENCE", "Provide the job/request reference and original local credentials")
		return
	}
	if !a.passwordAdmission(w, r) {
		return
	}
	defer func() { <-a.passwordSlots }()
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	before, err := a.readPublicReceiptAuthority(ctx, r.PathValue("token"), input)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		domainError(w, err)
		return
	}
	hash := before.hash
	if hash == "" {
		hash = a.dummyHash
	}
	valid := verifyPassword(hash, input.Password)
	if err != nil || before.hash == "" || !valid || !strings.EqualFold(before.name, input.Username) {
		fail(w, 403, "RECEIPT_UNAVAILABLE", "Receipt reference or local credentials could not be verified")
		return
	}
	job, err := a.loadRedemption(ctx, input.JobID)
	if err != nil {
		domainError(w, err)
		return
	}
	// Hashing is outside a transaction. Recheck credential/job binding after the
	// receipt read so concurrent password/profile/reference changes fail closed.
	after, err := a.readPublicReceiptAuthority(ctx, r.PathValue("token"), input)
	if err != nil || before != after {
		fail(w, 403, "RECEIPT_UNAVAILABLE", "Receipt reference or local credentials could not be verified")
		return
	}
	respond(w, 200, publicRedemption(job))
}
