//go:build windows

package main

import (
	"errors"
	"unicode/utf16"
	"unicode/utf8"
	"unsafe"

	"golang.org/x/sys/windows"
)

var readRecoveryConsoleInput = windows.NewLazySystemDLL("kernel32.dll").NewProc("ReadConsoleInputW")

// INPUT_RECORD with its KEY_EVENT_RECORD union arm (20 bytes on supported Windows).
type recoveryKeyEvent struct {
	event, padding               uint16
	down                         int32
	repeat, key, scan, character uint16
	control                      uint32
}

func (r *recoveryTerminal) Read(p []byte) (int, error) {
	if len(p) == 0 {
		return 0, nil
	}
	for {
		if err := r.ctx.Err(); err != nil {
			return 0, err
		}
		if len(r.pending) != 0 {
			n := copy(p, r.pending)
			clear(r.pending[:n])
			r.pending = r.pending[n:]
			return n, nil
		}
		if r.repeats > 0 {
			r.pending = utf8.AppendRune(r.pending, r.repeated)
			r.repeats--
			continue
		}
		status, err := windows.WaitForSingleObject(windows.Handle(r.file.Fd()), 50)
		if err != nil {
			return 0, err
		}
		if status == uint32(windows.WAIT_TIMEOUT) {
			continue
		}
		if status != windows.WAIT_OBJECT_0 {
			return 0, errors.New("unexpected recovery console wait result")
		}
		if err = r.ctx.Err(); err != nil {
			return 0, err
		}
		// Only this command consumes the input buffer. Read one available event;
		// key-up, focus and other events never trigger a blocking character read.
		var event recoveryKeyEvent
		var count uint32
		ok, _, callErr := readRecoveryConsoleInput.Call(r.file.Fd(), uintptr(unsafe.Pointer(&event)), 1, uintptr(unsafe.Pointer(&count)))
		if ok == 0 {
			return 0, callErr
		}
		// Alt+numpad/ConPTY Unicode characters arrive on VK_MENU release.
		// Ordinary releases carry duplicate text and must still be ignored.
		if count == 0 || event.event != 1 || (event.down == 0 && event.key != 0x12) || event.character == 0 {
			continue
		}
		c := event.character
		if c >= 0xd800 && c <= 0xdbff {
			if r.high != 0 {
				return 0, errors.New("invalid recovery console Unicode input")
			}
			r.high = c
			continue
		}
		character := rune(c)
		if r.high != 0 {
			character = utf16.DecodeRune(rune(r.high), rune(c))
			r.high = 0
			if character == utf8.RuneError {
				return 0, errors.New("invalid recovery console Unicode input")
			}
		} else if c >= 0xdc00 && c <= 0xdfff {
			return 0, errors.New("invalid recovery console Unicode input")
		}
		r.repeated = character
		r.repeats = max(1, int(event.repeat))
	}
}
