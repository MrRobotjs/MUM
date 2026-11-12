package main

import (
	"encoding/json"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestRuntimeConfigPrecedenceAndFirstRunFile(t *testing.T) {
	dir := t.TempDir()
	noEnv := func(string) string { return "" }
	got, err := loadRuntimeConfig(dir, noEnv, runtimeFlags{})
	if err != nil {
		t.Fatal(err)
	}
	if got.Listen != "127.0.0.1:5699" || got.SecureCookies || len(got.TrustedProxies) != 0 {
		t.Fatal("defaults", got)
	}
	// First run writes an editable file with the defaults.
	raw, err := os.ReadFile(filepath.Join(dir, runtimeConfigFile))
	if err != nil {
		t.Fatal("config file not created", err)
	}
	var written map[string]any
	if json.Unmarshal(raw, &written) != nil || written["listen"] != "127.0.0.1:5699" || written["secure_cookies"] != false {
		t.Fatal("written defaults", string(raw))
	}

	// The file overrides defaults.
	os.WriteFile(filepath.Join(dir, runtimeConfigFile), []byte(`{"listen":"0.0.0.0:8080","secure_cookies":true,"trusted_proxies":["10.0.0.0/8","192.168.1.5"]}`), 0o644)
	got, err = loadRuntimeConfig(dir, noEnv, runtimeFlags{})
	if err != nil || got.Listen != "0.0.0.0:8080" || !got.SecureCookies || len(got.TrustedProxies) != 2 {
		t.Fatal("file", got, err)
	}
	// Environment overrides the file.
	env := map[string]string{"MUM_LISTEN": "0.0.0.0:9000", "MUM_SECURE_COOKIES": "false", "MUM_TRUSTED_PROXIES": "172.16.0.0/12"}
	got, err = loadRuntimeConfig(dir, func(k string) string { return env[k] }, runtimeFlags{})
	if err != nil || got.Listen != "0.0.0.0:9000" || got.SecureCookies || len(got.TrustedProxies) != 1 || got.TrustedProxies[0].String() != "172.16.0.0/12" {
		t.Fatal("env", got, err)
	}
	// Flags override everything.
	listen, secure := "127.0.0.1:7000", true
	got, err = loadRuntimeConfig(dir, func(k string) string { return env[k] }, runtimeFlags{Listen: &listen, SecureCookies: &secure})
	if err != nil || got.Listen != "127.0.0.1:7000" || !got.SecureCookies {
		t.Fatal("flags", got, err)
	}
	// An existing file is never rewritten.
	after, _ := os.ReadFile(filepath.Join(dir, runtimeConfigFile))
	if !strings.Contains(string(after), "0.0.0.0:8080") {
		t.Fatal("user file overwritten", string(after))
	}
}

func TestRuntimeConfigRejectsMistakes(t *testing.T) {
	for name, body := range map[string]string{
		"typo key":      `{"listn":"0.0.0.0:5699"}`,
		"bad json":      `{"listen":`,
		"bad listen":    `{"listen":"5699"}`,
		"bad port":      `{"listen":"0.0.0.0:99999"}`,
		"bad proxy":     `{"trusted_proxies":["not-an-ip"]}`,
		"trailing data": `{"listen":"0.0.0.0:5699"} {}`,
	} {
		t.Run(name, func(t *testing.T) {
			dir := t.TempDir()
			os.WriteFile(filepath.Join(dir, runtimeConfigFile), []byte(body), 0o644)
			if _, err := loadRuntimeConfig(dir, func(string) string { return "" }, runtimeFlags{}); err == nil || !strings.Contains(err.Error(), runtimeConfigFile) {
				t.Fatal("mistake accepted or not attributed to the file", err)
			}
		})
	}
	for name, env := range map[string]map[string]string{
		"env listen": {"MUM_LISTEN": "localhost"},
		"env bool":   {"MUM_SECURE_COOKIES": "yes please"},
		"env proxy":  {"MUM_TRUSTED_PROXIES": "10.0.0.0/33"},
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := loadRuntimeConfig(t.TempDir(), func(k string) string { return env[k] }, runtimeFlags{}); err == nil {
				t.Fatal("invalid environment accepted")
			}
		})
	}
}

func TestDashboardURLForWildcardListener(t *testing.T) {
	if got := dashboardURL(&net.TCPAddr{IP: net.IPv4zero, Port: 5699}); !strings.HasPrefix(got, "http://localhost:5699 ") {
		t.Fatal(got)
	}
	if got := dashboardURL(&net.TCPAddr{IP: net.ParseIP("127.0.0.1"), Port: 5699}); got != "http://127.0.0.1:5699" {
		t.Fatal(got)
	}
}
