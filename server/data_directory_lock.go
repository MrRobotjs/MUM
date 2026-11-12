package main

import (
	"errors"
	"os"
	"path/filepath"
	"sync"
)

var errDataDirectoryInUse = errors.New("application data directory is in use; stop the other MUM process first")

// The file remains in place. Ownership is the OS lock, never a stale PID/file.
type dataDirectoryLock struct {
	file *os.File
	once sync.Once
	err  error
}

func lockDataDirectory(directory string) (*dataDirectoryLock, error) {
	path := filepath.Join(directory, ".mum.lock")
	if info, err := os.Lstat(path); err == nil && !info.Mode().IsRegular() {
		return nil, errors.New("data-directory lock must be a regular file")
	} else if err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	file, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return nil, err
	}
	info, err := file.Stat()
	if err != nil {
		file.Close()
		return nil, err
	}
	named, err := os.Lstat(path)
	if err != nil || !named.Mode().IsRegular() || !os.SameFile(info, named) {
		file.Close()
		return nil, errors.New("data-directory lock changed while opening")
	}
	if err = acquireDataFileLock(file); err != nil {
		file.Close()
		return nil, errors.Join(errDataDirectoryInUse, err)
	}
	return &dataDirectoryLock{file: file}, nil
}
func (l *dataDirectoryLock) Close() error {
	if l == nil {
		return nil
	}
	l.once.Do(func() { l.err = errors.Join(releaseDataFileLock(l.file), l.file.Close()) })
	return l.err
}
