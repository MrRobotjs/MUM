//go:build !windows && !linux && !darwin

package main

import "errors"

func (r *recoveryTerminal) Read(p []byte) (int, error) {
	return 0, errors.New("owner recovery terminal is unsupported on this platform")
}
