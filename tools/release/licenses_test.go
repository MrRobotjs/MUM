package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestLicenseFileNames(t *testing.T) {
	for _, ok := range []string{"LICENSE", "license.md", "LICENSE-MIT", "LICENCE.txt", "COPYING", "NOTICE", "UNLICENSE"} {
		if !isLicenseFile(ok) {
			t.Fatal("missed", ok)
		}
	}
	for _, bad := range []string{"README.md", "license.go", "package.json", "licenses"} {
		if isLicenseFile(bad) {
			t.Fatal("accepted", bad)
		}
	}
}

func TestCopyLicenseFiles(t *testing.T) {
	src, dst := t.TempDir(), t.TempDir()
	os.WriteFile(filepath.Join(src, "LICENSE"), []byte("MIT text"), 0o644)
	os.WriteFile(filepath.Join(src, "NOTICE.md"), []byte("notice"), 0o644)
	os.WriteFile(filepath.Join(src, "main.go"), []byte("package x"), 0o644)
	os.Mkdir(filepath.Join(src, "LICENSES"), 0o755)
	copied, err := copyLicenseFiles(src, filepath.Join(dst, "pkg"))
	if err != nil || strings.Join(copied, ",") != "LICENSE,NOTICE.md" {
		t.Fatal(copied, err)
	}
	if data, _ := os.ReadFile(filepath.Join(dst, "pkg", "LICENSE")); string(data) != "MIT text" {
		t.Fatal("license content not copied")
	}
}

func TestNpmRuntimePackagesFromLockfile(t *testing.T) {
	dir := t.TempDir()
	lock := `{"packages":{
		"":{"name":"frontend"},
		"node_modules/react":{"version":"19.2.0","license":"MIT"},
		"node_modules/@scope/lib":{"version":"1.0.0","license":"Apache-2.0"},
		"node_modules/vite":{"version":"7.2.2","dev":true},
		"node_modules/fsevents":{"version":"2.3.3","devOptional":true},
		"node_modules/@platform/win":{"version":"1.0.0","optional":true},
		"node_modules/react/node_modules/nested":{"version":"0.1.0","license":"ISC"}
	}}`
	os.WriteFile(filepath.Join(dir, "package-lock.json"), []byte(lock), 0o644)
	for _, p := range []string{"node_modules/react", "node_modules/@scope/lib", "node_modules/react/node_modules/nested"} {
		os.MkdirAll(filepath.Join(dir, p), 0o755)
		os.WriteFile(filepath.Join(dir, p, "package.json"), []byte("{}"), 0o644)
	}
	got, err := npmRuntimePackages(dir)
	if err != nil {
		t.Fatal(err)
	}
	names := []string{}
	for _, p := range got {
		names = append(names, p.Name+"@"+p.Version+"="+p.License)
	}
	// Dev packages are excluded; an uninstalled optional platform package is skipped.
	if strings.Join(names, ",") != "@scope/lib@1.0.0=Apache-2.0,nested@0.1.0=ISC,react@19.2.0=MIT" {
		t.Fatal(names)
	}
	// A required package that is not installed is an error.
	os.RemoveAll(filepath.Join(dir, "node_modules/react"))
	if _, err := npmRuntimePackages(dir); err == nil {
		t.Fatal("missing required package accepted")
	}
}

func TestLicenseOverrideFillsMissingLicence(t *testing.T) {
	pkg, overrides, dest := t.TempDir(), t.TempDir(), t.TempDir()
	os.WriteFile(filepath.Join(pkg, "package.json"), []byte("{}"), 0o644)
	item := thirdParty{Ecosystem: "npm", Name: "neverpanic", Version: "0.0.5", dir: pkg}

	// Without an override the package has neither files nor a declared licence.
	files, license, overridden, err := packageLicense(item, overrides, filepath.Join(dest, "a"))
	if err != nil || len(files) != 0 || license != "" || overridden {
		t.Fatal("no override", files, license, overridden, err)
	}
	// A reviewed override supplies the upstream text and declared licence.
	dir := filepath.Join(overrides, "npm", safeName(item.Name, item.Version))
	os.MkdirAll(dir, 0o755)
	os.WriteFile(filepath.Join(dir, "LICENSE"), []byte("MIT License text"), 0o644)
	os.WriteFile(filepath.Join(dir, "override.json"), []byte(`{"license":"MIT","source":"https://example.test/LICENSE","note":"added upstream later"}`), 0o644)
	files, license, overridden, err = packageLicense(item, overrides, filepath.Join(dest, "b"))
	if err != nil || strings.Join(files, ",") != "LICENSE" || license != "MIT" || !overridden {
		t.Fatal("override", files, license, overridden, err)
	}
	if data, _ := os.ReadFile(filepath.Join(dest, "b", "LICENSE")); string(data) != "MIT License text" {
		t.Fatal("override text not copied")
	}
	// A package that ships its own licence ignores the override.
	os.WriteFile(filepath.Join(pkg, "LICENSE"), []byte("own"), 0o644)
	if files, _, overridden, _ = packageLicense(item, overrides, filepath.Join(dest, "c")); overridden || strings.Join(files, ",") != "LICENSE" {
		t.Fatal("own licence not preferred", files, overridden)
	}
	// An override without a source or licence name is rejected.
	os.Remove(filepath.Join(pkg, "LICENSE"))
	os.WriteFile(filepath.Join(dir, "override.json"), []byte(`{"license":"MIT"}`), 0o644)
	if _, _, _, err = packageLicense(item, overrides, filepath.Join(dest, "d")); err == nil {
		t.Fatal("override without source accepted")
	}
}

func TestAGPLIncompatibleLicences(t *testing.T) {
	for _, bad := range []string{"Hippocratic-2.1", "(MIT AND Hippocratic-3.0)", "SSPL-1.0", "BUSL-1.1", "CC-BY-NC-4.0", "PolyForm-Noncommercial-1.0.0", "Commons-Clause"} {
		if !agplIncompatible(bad) {
			t.Fatal("accepted", bad)
		}
	}
	for _, ok := range []string{"MIT", "Apache-2.0", "BSD-3-Clause", "ISC", "(CC-BY-4.0 AND OFL-1.1 AND MIT)", "(MIT OR CC0-1.0)", "0BSD", "Unlicense", ""} {
		if agplIncompatible(ok) {
			t.Fatal("rejected", ok)
		}
	}
}

func TestProjectFilesCopied(t *testing.T) {
	root, out := t.TempDir(), t.TempDir()
	if err := copyProjectFiles(root, out); err == nil {
		t.Fatal("missing project files accepted")
	}
	os.WriteFile(filepath.Join(root, "LICENSE"), []byte("GNU AFFERO GENERAL PUBLIC LICENSE"), 0o644)
	if err := copyProjectFiles(root, out); err == nil {
		t.Fatal("missing getting-started guide accepted")
	}
	os.MkdirAll(filepath.Join(root, "deploy"), 0o755)
	os.WriteFile(filepath.Join(root, "deploy", "GETTING_STARTED.md"), []byte("# Getting started"), 0o644)
	if err := copyProjectFiles(root, out); err != nil {
		t.Fatal(err)
	}
	for name, want := range map[string]string{"LICENSE": "GNU AFFERO GENERAL PUBLIC LICENSE", "GETTING_STARTED.md": "# Getting started"} {
		if data, _ := os.ReadFile(filepath.Join(out, name)); string(data) != want {
			t.Fatal(name, "not copied")
		}
	}
}
