//go:build !windows && !linux && !darwin

package main

import (
	"errors"
	"os"
)

func acquireDataFileLock(file *os.File) error {
	return errors.New("this platform has no supported data-directory lock")
}
func releaseDataFileLock(file *os.File) error { return nil }
