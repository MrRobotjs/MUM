package main

import (
	"fmt"
	"runtime"
	"runtime/debug"
)

// version is stamped by release builds: -ldflags "-X main.version=v1.2.3".
// Local builds report "dev".
var version = "dev"

// versionLine identifies the running binary: release version, source revision
// (with "-dirty" for uncommitted changes), platform and Go toolchain.
func versionLine() string {
	revision, dirty := "unknown", ""
	if info, ok := debug.ReadBuildInfo(); ok {
		for _, setting := range info.Settings {
			switch setting.Key {
			case "vcs.revision":
				revision = setting.Value
				if len(revision) > 12 {
					revision = revision[:12]
				}
			case "vcs.modified":
				if setting.Value == "true" {
					dirty = "-dirty"
				}
			}
		}
	}
	return fmt.Sprintf("MUM %s (%s%s) %s/%s %s", version, revision, dirty, runtime.GOOS, runtime.GOARCH, runtime.Version())
}
