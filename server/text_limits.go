package main

import "unicode/utf8"

// Length limits people see are in characters, so an accented letter or an
// emoji counts once (user decision 2026-11-16). Where a limit protects stored
// size, the byte check stays as well; the message still talks in characters.

// characters counts what a person would count.
func characters(s string) int { return utf8.RuneCountInString(s) }

// passwordLongEnough is the 12-character minimum for a new password. A
// current password is only checked against its hash, so older passwords that
// met the earlier byte rule still work.
func passwordLongEnough(password string) bool { return characters(password) >= 12 }

// validReason is an audited reason of 10–1000 characters.
func validReason(reason string) bool {
	n := characters(reason)
	return utf8.ValidString(reason) && n >= 10 && n <= 1000
}
