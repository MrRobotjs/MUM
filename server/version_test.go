package main

import (
	"runtime"
	"strings"
	"testing"
)

func TestVersionLineReportsBuild(t *testing.T) {
	line := versionLine()
	for _, want := range []string{"MUM " + version + " ", runtime.GOOS + "/" + runtime.GOARCH, runtime.Version()} {
		if !strings.Contains(line, want) {
			t.Fatalf("%q missing %q", line, want)
		}
	}
	if strings.Contains(line, "\n") {
		t.Fatal("version line spans lines", line)
	}
}
