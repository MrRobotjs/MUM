package main

import (
	"bufio"
	"fmt"
	"io"
)

// waitBeforeClosing keeps a double-clicked console window open after a
// start-up error so the message can be read. From a terminal it returns at
// once; end of input (no console) never blocks.
func waitBeforeClosing(in io.Reader, out io.Writer, doubleClicked bool) {
	if !doubleClicked {
		return
	}
	fmt.Fprintln(out, "Press Enter to close this window.")
	_, _ = bufio.NewReader(in).ReadString('\n')
}

// listenError explains the usual causes of a failed listen and where the
// address is configured.
func listenError(addr, configPath string, err error) error {
	return fmt.Errorf("cannot listen on %s; MUM or another program may already be using this port. Stop it, or choose another address with \"listen\" in %s (or --listen / MUM_LISTEN): %w", addr, configPath, err)
}
