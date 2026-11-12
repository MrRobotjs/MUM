package main

import (
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// `//go:embed dist/*` silently leaves out files whose names start with "_" or
// "." inside dist's folders, and the server then answers 404 for them. Every
// file the frontend build wrote must be in the binary.
func TestEmbeddedFrontendIncludesEveryBuiltFile(t *testing.T) {
	built := 0
	err := filepath.WalkDir("dist", func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		built++
		name := filepath.ToSlash(path)
		if _, err := fs.Stat(frontendFiles, name); err != nil {
			t.Errorf("%s was built but is not embedded (names starting with _ or . are skipped by go:embed)", name)
		}
		return nil
	})
	if os.IsNotExist(err) {
		t.Skip("no frontend build in server/dist")
	}
	if err != nil {
		t.Fatal(err)
	}
	if built == 0 || !strings.Contains(strings.Join(mustEmbeddedNames(t), ","), "dist/index.html") {
		t.Fatal("frontend build is missing index.html")
	}
}

func mustEmbeddedNames(t *testing.T) []string {
	t.Helper()
	var names []string
	if err := fs.WalkDir(frontendFiles, "dist", func(path string, d fs.DirEntry, err error) error {
		if err == nil && !d.IsDir() {
			names = append(names, path)
		}
		return err
	}); err != nil {
		t.Fatal(err)
	}
	return names
}
