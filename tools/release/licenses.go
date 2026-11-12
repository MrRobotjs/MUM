package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
)

// Third-party licence collection for release output. Everything is read from
// local copies (Go module cache, frontend/node_modules, reviewed overrides);
// nothing is fetched.

var licenseFileName = regexp.MustCompile(`(?i)^(un)?(licen[cs]e|copying|notice)(-[\w.-]+)?(\.(md|txt|markdown|rst|html))?$`)

func isLicenseFile(name string) bool { return licenseFileName.MatchString(name) }

// copyLicenseFiles copies licence/notice files from a package root into dest
// and returns their names in order.
func copyLicenseFiles(src, dest string) ([]string, error) {
	entries, err := os.ReadDir(src)
	if err != nil {
		return nil, err
	}
	copied := []string{}
	for _, entry := range entries {
		if entry.IsDir() || !isLicenseFile(entry.Name()) {
			continue
		}
		data, err := os.ReadFile(filepath.Join(src, entry.Name()))
		if err != nil {
			return nil, err
		}
		if err := os.MkdirAll(dest, 0o755); err != nil {
			return nil, err
		}
		if err := os.WriteFile(filepath.Join(dest, entry.Name()), data, 0o644); err != nil {
			return nil, err
		}
		copied = append(copied, entry.Name())
	}
	slices.Sort(copied)
	return copied, nil
}

type thirdParty struct {
	Ecosystem string   `json:"ecosystem"`
	Name      string   `json:"name"`
	Version   string   `json:"version"`
	License   string   `json:"license"` // declared licence (npm); empty for Go modules
	Files     []string `json:"files"`
	// Overridden is set when the licence text came from licenseOverridesDir.
	Overridden bool `json:"overridden,omitempty"`
	dir        string
}

// goLinkedModules lists the non-main modules compiled into the binary for
// every release target, with their module-cache directories.
func goLinkedModules() ([]thirdParty, error) {
	seen := map[string]thirdParty{}
	for _, target := range releaseTargets {
		output, err := command(".", buildEnv(os.Environ(), target), "go", "list", "-deps",
			"-f", "{{with .Module}}{{if not .Main}}{{.Path}}\t{{.Version}}\t{{.Dir}}{{end}}{{end}}", serverPackage)
		if err != nil {
			return nil, fmt.Errorf("go list for %s/%s: %w\n%s", target.GOOS, target.GOARCH, err, output)
		}
		for _, line := range strings.Split(output, "\n") {
			parts := strings.Split(strings.TrimSpace(line), "\t")
			if len(parts) != 3 || parts[0] == "" {
				continue
			}
			if parts[2] == "" {
				return nil, fmt.Errorf("module %s %s is not in the local module cache (run go mod download)", parts[0], parts[1])
			}
			seen[parts[0]] = thirdParty{Ecosystem: "go", Name: parts[0], Version: parts[1], dir: parts[2]}
		}
	}
	// The Go runtime and standard library are compiled into every binary.
	root, err := command(".", nil, "go", "env", "GOROOT")
	if err != nil {
		return nil, fmt.Errorf("go env GOROOT: %w", err)
	}
	goVersion, err := command(".", nil, "go", "env", "GOVERSION")
	if err != nil {
		return nil, fmt.Errorf("go env GOVERSION: %w", err)
	}
	seen["go (runtime and standard library)"] = thirdParty{Ecosystem: "go", Name: "go (runtime and standard library)", Version: goVersion, dir: root}
	modules := make([]thirdParty, 0, len(seen))
	for _, module := range seen {
		modules = append(modules, module)
	}
	slices.SortFunc(modules, func(a, b thirdParty) int { return strings.Compare(a.Name, b.Name) })
	return modules, nil
}

// npmRuntimePackages lists every non-dev package in the frontend lockfile, a
// superset of what the production bundle includes. Optional packages that are
// not installed (other platforms' binaries) are skipped; a missing required
// package is an error.
func npmRuntimePackages(frontendDir string) ([]thirdParty, error) {
	raw, err := os.ReadFile(filepath.Join(frontendDir, "package-lock.json"))
	if err != nil {
		return nil, err
	}
	var lock struct {
		Packages map[string]struct {
			Version     string `json:"version"`
			License     any    `json:"license"`
			Dev         bool   `json:"dev"`
			DevOptional bool   `json:"devOptional"`
			Optional    bool   `json:"optional"`
		} `json:"packages"`
	}
	if err := json.Unmarshal(raw, &lock); err != nil {
		return nil, fmt.Errorf("package-lock.json: %w", err)
	}
	packages := []thirdParty{}
	for path, entry := range lock.Packages {
		if path == "" || entry.Dev || entry.DevOptional || !strings.HasPrefix(path, "node_modules/") {
			continue
		}
		dir := filepath.Join(frontendDir, filepath.FromSlash(path))
		if _, err := os.Stat(filepath.Join(dir, "package.json")); err != nil {
			if entry.Optional && errors.Is(err, os.ErrNotExist) {
				continue
			}
			return nil, fmt.Errorf("frontend package %s is not installed (run npm ci)", path)
		}
		name := path[strings.LastIndex(path, "node_modules/")+len("node_modules/"):]
		license := ""
		switch value := entry.License.(type) {
		case string:
			license = value
		case map[string]any:
			license, _ = value["type"].(string)
		}
		packages = append(packages, thirdParty{Ecosystem: "npm", Name: name, Version: entry.Version, License: license, dir: dir})
	}
	slices.SortFunc(packages, func(a, b thirdParty) int {
		if c := strings.Compare(a.Name, b.Name); c != 0 {
			return c
		}
		return strings.Compare(a.Version, b.Version)
	})
	return packages, nil
}

// licenseOverridesDir holds reviewed licence texts for packages whose
// published copy omits them: <ecosystem>/<name@version>/ with the licence
// file(s) and override.json naming the licence and where the text came from.
const licenseOverridesDir = "tools/release/license-overrides"

type licenseOverride struct {
	License string `json:"license"`
	Source  string `json:"source"`
	Note    string `json:"note"`
}

// packageLicense copies a package's own licence files into dest. Only when it
// ships none does a reviewed override apply; the declared licence then comes
// from the override.
func packageLicense(item thirdParty, overrides, dest string) (files []string, license string, overridden bool, err error) {
	files, err = copyLicenseFiles(item.dir, dest)
	if err != nil || len(files) != 0 {
		return files, item.License, false, err
	}
	dir := filepath.Join(overrides, item.Ecosystem, safeName(item.Name, item.Version))
	raw, err := os.ReadFile(filepath.Join(dir, "override.json"))
	if errors.Is(err, os.ErrNotExist) {
		return files, item.License, false, nil
	}
	if err != nil {
		return nil, "", false, err
	}
	var override licenseOverride
	if err := json.Unmarshal(raw, &override); err != nil || override.License == "" || override.Source == "" {
		return nil, "", false, fmt.Errorf("%s: override.json needs license and source", dir)
	}
	if files, err = copyLicenseFiles(dir, dest); err != nil {
		return nil, "", false, err
	}
	if len(files) == 0 {
		return nil, "", false, fmt.Errorf("%s: override has no licence file", dir)
	}
	return files, override.License, true, nil
}

// MUM is licensed AGPL-3.0-only. These licence families add use restrictions
// (ethical-use, field-of-use, non-commercial, source-available) that the AGPL
// forbids, so a dependency declaring one cannot ship in a release.
var agplIncompatiblePattern = regexp.MustCompile(`(?i)hippocratic|sspl|busl|\bbsl-|cc-by-nc|-nc-|polyform|commons[- ]clause|elastic-license|\bjson\b`)

func agplIncompatible(license string) bool { return agplIncompatiblePattern.MatchString(license) }

// projectFiles are copied from the repository into every release directory
// (source path -> release name); a release missing any of them is refused.
var projectFiles = [][2]string{
	{"LICENSE", "LICENSE"},
	{filepath.Join("deploy", "GETTING_STARTED.md"), "GETTING_STARTED.md"},
}

func copyProjectFiles(root, dest string) error {
	for _, file := range projectFiles {
		data, err := os.ReadFile(filepath.Join(root, file[0]))
		if err != nil {
			return fmt.Errorf("project file %s: %w", file[0], err)
		}
		if err := os.WriteFile(filepath.Join(dest, file[1]), data, 0o644); err != nil {
			return err
		}
	}
	return nil
}

func safeName(name, version string) string {
	return strings.NewReplacer("/", "_", "@", "", "\\", "_", ":", "_", " ", "_", "(", "", ")", "").Replace(name) + "@" + version
}

// collectLicenses writes licenses/<ecosystem>/<package>/ files and
// THIRD_PARTY_LICENSES.md under dir. Go modules must ship a licence file; npm
// packages without one are listed with their declared licence.
func collectLicenses(dir string, allowUnlicensed map[string]bool) ([]thirdParty, error) {
	modules, err := goLinkedModules()
	if err != nil {
		return nil, err
	}
	npm, err := npmRuntimePackages("frontend")
	if err != nil {
		return nil, err
	}
	all := append(modules, npm...)
	var index strings.Builder
	index.WriteString("# Third-party licences\n\nGo modules compiled into the MUM executables, and the production (non-development) frontend packages from `frontend/package-lock.json` (a superset of what the embedded web bundle contains). Licence texts are in `licenses/`.\n\n| Ecosystem | Package | Version | Declared licence | Files |\n|---|---|---|---|---|\n")
	missing, incompatible := []string{}, []string{}
	for i := range all {
		item := &all[i]
		dest := filepath.Join(dir, "licenses", item.Ecosystem, safeName(item.Name, item.Version))
		files, license, overridden, err := packageLicense(*item, licenseOverridesDir, dest)
		if err != nil {
			return nil, fmt.Errorf("%s %s: %w", item.Name, item.Version, err)
		}
		item.Files, item.License, item.Overridden = files, license, overridden
		unlicensed := len(files) == 0 && (item.Ecosystem == "go" || item.License == "")
		if unlicensed && !allowUnlicensed[item.Name+"@"+item.Version] {
			missing = append(missing, item.Ecosystem+":"+item.Name+"@"+item.Version)
		}
		if agplIncompatible(item.License) {
			incompatible = append(incompatible, item.Ecosystem+":"+item.Name+"@"+item.Version+" ("+item.License+")")
		}
		shown := strings.Join(files, ", ")
		if shown == "" {
			shown = "(no licence file shipped; see declared licence)"
		}
		if overridden {
			shown += " (not in the published package; reviewed upstream text from " + licenseOverridesDir + ")"
		}
		if unlicensed {
			shown = "**NO LICENCE: included by explicit -allow-unlicensed approval**"
		}
		fmt.Fprintf(&index, "| %s | %s | %s | %s | %s |\n", item.Ecosystem, item.Name, item.Version, item.License, shown)
	}
	if len(incompatible) != 0 {
		return nil, fmt.Errorf("licences incompatible with MUM's AGPL-3.0: %s (replace these packages)", strings.Join(incompatible, ", "))
	}
	if len(missing) != 0 {
		return nil, fmt.Errorf("no licence information for: %s (resolve it, or approve each explicitly with -allow-unlicensed name@version)", strings.Join(missing, ", "))
	}
	if err := os.WriteFile(filepath.Join(dir, "THIRD_PARTY_LICENSES.md"), []byte(index.String()), 0o644); err != nil {
		return nil, err
	}
	return all, nil
}
