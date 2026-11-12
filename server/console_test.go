package main

import (
	"bytes"
	"errors"
	"strings"
	"testing"
)

func TestWaitBeforeClosingOnlyWhenDoubleClicked(t *testing.T) {
	var out bytes.Buffer
	waitBeforeClosing(strings.NewReader(""), &out, false)
	if out.Len() != 0 {
		t.Fatal("prompted although started from a terminal:", out.String())
	}
	in := strings.NewReader("\n")
	waitBeforeClosing(in, &out, true)
	if !strings.Contains(out.String(), "Press Enter") || in.Len() != 0 {
		t.Fatal("did not wait for Enter", out.String(), in.Len())
	}
	// A closed input (no console) must not block.
	out.Reset()
	waitBeforeClosing(strings.NewReader(""), &out, true)
}

func TestListenErrorExplainsTheFix(t *testing.T) {
	err := listenError("127.0.0.1:5699", `C:\data\mum-config.json`, errors.New("bind: address already in use"))
	for _, want := range []string{"127.0.0.1:5699", "already", `C:\data\mum-config.json`, "--listen", "bind: address already in use"} {
		if !strings.Contains(err.Error(), want) {
			t.Fatalf("missing %q in %q", want, err)
		}
	}
}
