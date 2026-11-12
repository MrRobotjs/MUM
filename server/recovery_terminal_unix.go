//go:build linux || darwin

package main

import (
	"errors"
	"io"

	"golang.org/x/sys/unix"
)

func (r *recoveryTerminal) Read(p []byte) (int, error) {
	if len(p) == 0 {
		return 0, nil
	}
	fd := int(r.file.Fd())
	for {
		if err := r.ctx.Err(); err != nil {
			return 0, err
		}
		fds := []unix.PollFd{{Fd: int32(fd), Events: unix.POLLIN}}
		n, err := unix.Poll(fds, 50)
		if errors.Is(err, unix.EINTR) {
			continue
		}
		if err != nil {
			return 0, err
		}
		if n == 0 {
			continue
		}
		if fds[0].Revents&unix.POLLNVAL != 0 {
			return 0, unix.EBADF
		}
		if err = r.ctx.Err(); err != nil {
			return 0, err
		}
		n, err = unix.Read(fd, p)
		if errors.Is(err, unix.EINTR) || errors.Is(err, unix.EAGAIN) {
			continue
		}
		if n == 0 && err == nil {
			return 0, io.EOF
		}
		return n, err
	}
}
