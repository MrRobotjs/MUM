package main

import (
	"strings"
	"testing"
)

func TestReleaseVersionValidation(t *testing.T) {
	for _, ok := range []string{"dev", "v1.0.0", "v0.12.3", "v2.0.0-rc.1"} {
		if !validReleaseVersion(ok) {
			t.Fatal("rejected", ok)
		}
	}
	for _, bad := range []string{"", "1.0.0", "v1.0", "v1.0.0 ", "v1.0.0;rm", "latest", "v1.0.0-", "../v1.0.0"} {
		if validReleaseVersion(bad) {
			t.Fatal("accepted", bad)
		}
	}
}

func TestReleaseTargetsStayCGODisabledThreePlatforms(t *testing.T) {
	names := []string{}
	for _, target := range releaseTargets {
		names = append(names, target.GOOS+"/"+target.GOARCH+"="+target.File)
	}
	if strings.Join(names, ",") != "windows/amd64=mum-windows-amd64.exe,linux/amd64=mum-linux-amd64,darwin/arm64=mum-macos-arm64" {
		t.Fatal(names)
	}
	env := buildEnv([]string{"CGO_ENABLED=1", "GOOS=plan9", "PATH=x"}, releaseTargets[1])
	joined := strings.Join(env, " ")
	if !strings.Contains(joined, "CGO_ENABLED=0") || strings.Contains(joined, "CGO_ENABLED=1") || !strings.Contains(joined, "GOOS=linux") || strings.Contains(joined, "plan9") || !strings.Contains(joined, "PATH=x") {
		t.Fatal(env)
	}
}

func TestChecksumFileFormat(t *testing.T) {
	got := checksumFile(map[string][]byte{"b": []byte("two"), "a": []byte("one")})
	want := "7692c3ad3540bb803c020b3aee66cd8887123234ea0c6e7143c0add73ff431ed  a\n" +
		"3fc4ccfe745870e2c0d99f71f30ff0656c8dedd41cc1d7d3d376b0dbe685e2f3  b\n"
	if got != want {
		t.Fatalf("%q", got)
	}
}
