//go:build windows

package main

import (
	"syscall"
	"unsafe"
)

// launchedByDoubleClick reports whether MUM is the only process attached to
// its console, which is the case when Explorer started it in a new window
// rather than from an existing terminal.
func launchedByDoubleClick() bool {
	proc := syscall.NewLazyDLL("kernel32.dll").NewProc("GetConsoleProcessList")
	if proc.Find() != nil {
		return false
	}
	var ids [2]uint32
	count, _, _ := proc.Call(uintptr(unsafe.Pointer(&ids[0])), uintptr(len(ids)))
	return count == 1
}
