package provider

import (
	"errors"
	"net/http"
)

// VerifiedLogin is the server account a user's own login was checked against.
// The server's session token never leaves the module.
type VerifiedLogin struct {
	ID, Name string
}

// ErrInvalidLogin reports a login the server refused. Callers show it the
// same way for an unknown user, a wrong password and a locked account.
var ErrInvalidLogin = errors.New("invalid login")

// LoginRefused maps the statuses servers use to refuse a login.
func LoginRefused(err error) error {
	var status *HTTPError
	if errors.As(err, &status) && (status.StatusCode == http.StatusBadRequest || status.StatusCode == http.StatusUnauthorized || status.StatusCode == http.StatusForbidden || status.StatusCode == http.StatusNotFound) {
		return ErrInvalidLogin
	}
	return err
}

// QuickConnectRequest is a Jellyfin Quick Connect request: the user approves
// Code in an app where they are signed in, and Secret then completes the
// sign-in. Secret is a credential and must not be logged or returned.
type QuickConnectRequest struct {
	Secret, Code string
}

var (
	// ErrQuickConnectOff reports a server with Quick Connect turned off.
	ErrQuickConnectOff = errors.New("Quick Connect is turned off on this server")
	// ErrQuickConnectExpired reports a request the server no longer knows or
	// has not approved.
	ErrQuickConnectExpired = errors.New("Quick Connect request expired")
)
