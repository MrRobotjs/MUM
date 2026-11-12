package main

import (
	"context"
	"os"
)

// The recovery command exclusively consumes its raw terminal input. Platform
// reads wait at most 50ms before checking cancellation; no reader goroutine survives.
type recoveryTerminal struct {
	ctx      context.Context
	file     *os.File
	pending  []byte
	high     uint16
	repeated rune
	repeats  int
}
