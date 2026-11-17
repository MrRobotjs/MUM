package main

import (
	"strings"
	"testing"
)

// Limits are counted in characters: six accented letters are twelve bytes but
// only six characters, so they are not a 12-character password.
func TestNewPasswordsAndReasonsCountCharacters(t *testing.T) {
	if _, err := hashPassword(strings.Repeat("é", 6)); err == nil {
		t.Fatal("a six-character password was accepted")
	}
	if _, err := hashPassword(strings.Repeat("é", 12)); err != nil {
		t.Fatal("a twelve-character password was refused", err)
	}
	if validReason(strings.Repeat("é", 5)) || !validReason(strings.Repeat("é", 10)) || !validReason(strings.Repeat("é", 1000)) || validReason(strings.Repeat("x", 1001)) {
		t.Fatal("reasons should be 10 to 1000 characters")
	}
}

// Changing a password through the API refuses a new password that is short
// in characters, with a message that talks in characters.
func TestPasswordChangeRefusesShortAccentedPassword(t *testing.T) {
	a, s := testApp(t)
	token, _ := bootstrapOwner(t, a)
	owner, _ := s.Authenticate(t.Context(), token)
	short := strings.Repeat("é", 6)
	w := apiRequest(a, "POST", "/api/account/password", token, map[string]any{"expected_user_uuid": owner.UUID, "current_password": "a-strong-new-password", "new_password": short, "confirm_password": short, "acknowledge_revoke_sessions": true}, nil)
	if w.Code != 400 || !strings.Contains(w.Body.String(), "12 to 1024 characters") || strings.Contains(w.Body.String(), "bytes") {
		t.Fatal(w.Code, w.Body.String())
	}
}
