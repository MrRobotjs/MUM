//go:build linux || darwin

package main

import (
	"golang.org/x/sys/unix"
	"os"
)

func acquireDataFileLock(file *os.File) error {
	return unix.Flock(int(file.Fd()), unix.LOCK_EX|unix.LOCK_NB)
}
func releaseDataFileLock(file *os.File) error { return unix.Flock(int(file.Fd()), unix.LOCK_UN) }
