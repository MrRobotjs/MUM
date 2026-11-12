// Command release builds MUM release artifacts locally. It never publishes.
//
// Run from the repository root (the Go application is the ./server package):
//
//	go run ./tools/release -version v1.0.0
//
// It builds the frontend into dist/ (unless -skip-frontend), then the three
// CGO-disabled executables with -trimpath and the version stamped into
// main.version, copies LICENSE and GETTING_STARTED.md, collects third-party
// licences (licenses/, THIRD_PARTY_LICENSES.md),
// and writes SHA256SUMS and release-manifest.json. A real
// version is refused for a working tree with uncommitted changes unless
// -allow-dirty is given; the manifest always records the tree state.
package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"slices"
	"strings"
)

type releaseTarget struct {
	GOOS, GOARCH, File string
}

// The distribution targets named in AGENTS.md: Windows amd64, Linux amd64 and
// macOS arm64, all with CGO disabled.
var releaseTargets = []releaseTarget{
	{"windows", "amd64", "mum-windows-amd64.exe"},
	{"linux", "amd64", "mum-linux-amd64"},
	{"darwin", "arm64", "mum-macos-arm64"},
}

// serverPackage is the Go application package, relative to the repository root.
const serverPackage = "./server"

var releaseVersion = regexp.MustCompile(`^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z]+(\.[0-9A-Za-z]+)*)?$`)

func validReleaseVersion(v string) bool {
	return v == "dev" || releaseVersion.MatchString(v)
}

// buildEnv returns the parent environment with the target's GOOS/GOARCH and
// CGO_ENABLED=0 replacing any inherited values.
func buildEnv(parent []string, target releaseTarget) []string {
	env := []string{}
	for _, entry := range parent {
		name, _, _ := strings.Cut(entry, "=")
		switch strings.ToUpper(name) {
		case "CGO_ENABLED", "GOOS", "GOARCH":
			continue
		}
		env = append(env, entry)
	}
	return append(env, "CGO_ENABLED=0", "GOOS="+target.GOOS, "GOARCH="+target.GOARCH)
}

// checksumFile renders files in sha256sum format, sorted by name.
func checksumFile(files map[string][]byte) string {
	names := make([]string, 0, len(files))
	for name := range files {
		names = append(names, name)
	}
	slices.Sort(names)
	var out strings.Builder
	for _, name := range names {
		sum := sha256.Sum256(files[name])
		fmt.Fprintf(&out, "%s  %s\n", hex.EncodeToString(sum[:]), name)
	}
	return out.String()
}

type artifact struct {
	File   string `json:"file"`
	GOOS   string `json:"goos"`
	GOARCH string `json:"goarch"`
	Size   int    `json:"size"`
	SHA256 string `json:"sha256"`
}

type manifest struct {
	Version       string     `json:"version"`
	License       string     `json:"license"`
	Commit        string     `json:"commit"`
	Dirty         bool       `json:"dirty"`
	GoVersion     string     `json:"go_version"`
	FrontendBuilt bool       `json:"frontend_built"`
	CGOEnabled    bool       `json:"cgo_enabled"`
	Artifacts     []artifact `json:"artifacts"`
	ThirdParty    struct {
		GoModules    int `json:"go_modules"`
		NpmPackages  int `json:"npm_packages"`
		LicenseFiles int `json:"license_files"`
		DeclaredOnly int `json:"npm_declared_licence_only"`
		Overridden   int `json:"licence_overrides"`
	} `json:"third_party"`
	UnlicensedApproved []string `json:"unlicensed_approved"`
	Published          bool     `json:"published"`
}

func command(dir string, env []string, name string, args ...string) (string, error) {
	cmd := exec.Command(name, args...)
	cmd.Dir = dir
	if env != nil {
		cmd.Env = env
	}
	var output bytes.Buffer
	cmd.Stdout, cmd.Stderr = &output, &output
	err := cmd.Run()
	return strings.TrimSpace(output.String()), err
}

func run() error {
	versionFlag := flag.String("version", "dev", "release version (vMAJOR.MINOR.PATCH[-pre]) or dev")
	out := flag.String("out", "release", "output directory (a <version> folder is created inside)")
	skipFrontend := flag.Bool("skip-frontend", false, "use the existing server/dist/ instead of rebuilding the frontend")
	allowDirty := flag.Bool("allow-dirty", false, "allow a real version from a working tree with uncommitted changes")
	allowUnlicensed := flag.String("allow-unlicensed", "", "comma-separated name@version packages approved for release without licence information")
	flag.Parse()
	if flag.NArg() != 0 || !validReleaseVersion(*versionFlag) {
		return errors.New("use -version vMAJOR.MINOR.PATCH[-pre] or -version dev")
	}
	if module, err := os.ReadFile("go.mod"); err != nil || !bytes.HasPrefix(module, []byte("module app\n")) && !bytes.HasPrefix(module, []byte("module app\r\n")) {
		return errors.New("run from the MUM repository root")
	}
	commit, err := command(".", nil, "git", "rev-parse", "HEAD")
	if err != nil {
		commit = "unknown"
	}
	status, err := command(".", nil, "git", "status", "--porcelain")
	dirty := err != nil || status != ""
	if dirty && *versionFlag != "dev" && !*allowDirty {
		return errors.New("the working tree has uncommitted changes; commit them or pass -allow-dirty (recorded in the manifest)")
	}
	if !*skipFrontend {
		fmt.Println("building frontend into server/dist/ ...")
		if output, err := command("frontend", nil, "node", "node_modules/vite/bin/vite.js", "build"); err != nil {
			return fmt.Errorf("frontend build failed: %w\n%s", err, output)
		}
	}
	if info, err := os.Stat(filepath.Join("server", "dist", "index.html")); err != nil || info.IsDir() {
		return errors.New("server/dist/index.html is missing; build the frontend first")
	}
	directory := filepath.Join(*out, *versionFlag)
	if err := os.MkdirAll(directory, 0o755); err != nil {
		return err
	}
	files := map[string][]byte{}
	result := manifest{Version: *versionFlag, License: "AGPL-3.0-only", Commit: commit, Dirty: dirty, FrontendBuilt: !*skipFrontend, Artifacts: []artifact{}, UnlicensedApproved: []string{}}
	goVersion, err := command(".", nil, "go", "env", "GOVERSION")
	if err != nil {
		return fmt.Errorf("go toolchain unavailable: %w", err)
	}
	result.GoVersion = goVersion
	for _, target := range releaseTargets {
		path := filepath.Join(directory, target.File)
		fmt.Printf("building %s/%s ...\n", target.GOOS, target.GOARCH)
		output, err := command(".", buildEnv(os.Environ(), target), "go", "build", "-trimpath",
			"-ldflags", "-s -w -X main.version="+*versionFlag, "-o", path, serverPackage)
		if err != nil {
			return fmt.Errorf("build %s/%s failed: %w\n%s", target.GOOS, target.GOARCH, err, output)
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		files[target.File] = data
		sum := sha256.Sum256(data)
		result.Artifacts = append(result.Artifacts, artifact{target.File, target.GOOS, target.GOARCH, len(data), hex.EncodeToString(sum[:])})
	}
	fmt.Println("collecting third-party licences ...")
	approved := map[string]bool{}
	for _, item := range strings.Split(*allowUnlicensed, ",") {
		if item = strings.TrimSpace(item); item != "" {
			approved[item] = true
			result.UnlicensedApproved = append(result.UnlicensedApproved, item)
		}
	}
	if err := copyProjectFiles(".", directory); err != nil {
		return err
	}
	parties, err := collectLicenses(directory, approved)
	if err != nil {
		return err
	}
	for _, party := range parties {
		if party.Ecosystem == "go" {
			result.ThirdParty.GoModules++
		} else {
			result.ThirdParty.NpmPackages++
		}
		result.ThirdParty.LicenseFiles += len(party.Files)
		if len(party.Files) == 0 {
			result.ThirdParty.DeclaredOnly++
		}
		if party.Overridden {
			result.ThirdParty.Overridden++
		}
	}
	if err := os.WriteFile(filepath.Join(directory, "SHA256SUMS"), []byte(checksumFile(files)), 0o644); err != nil {
		return err
	}
	encoded, err := json.MarshalIndent(result, "", "  ")
	if err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(directory, "release-manifest.json"), append(encoded, '\n'), 0o644); err != nil {
		return err
	}
	fmt.Printf("release %s written to %s (dirty=%t, %s, host %s/%s); nothing was published\n", *versionFlag, directory, dirty, goVersion, runtime.GOOS, runtime.GOARCH)
	return nil
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "release:", err)
		os.Exit(1)
	}
}
