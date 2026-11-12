package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/netip"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// Network settings a user chooses without command-line flags. Precedence:
// command-line flag > environment variable > <data dir>/mum-config.json >
// default. The file is created with the defaults on first run so users can
// find and edit it; an existing file is never rewritten.
const runtimeConfigFile = "mum-config.json"

type runtimeConfig struct {
	Listen         string
	SecureCookies  bool
	TrustedProxies []netip.Prefix
}

// runtimeFlags holds values given explicitly on the command line (nil = not given).
type runtimeFlags struct {
	Listen         *string
	SecureCookies  *bool
	TrustedProxies *string
}

type runtimeConfigJSON struct {
	Listen         *string  `json:"listen"`
	SecureCookies  *bool    `json:"secure_cookies"`
	TrustedProxies []string `json:"trusted_proxies"`
}

func validListen(value string) error {
	host, port, err := net.SplitHostPort(value)
	if err != nil {
		return fmt.Errorf("listen %q must be host:port, for example 0.0.0.0:5699", value)
	}
	if n, err := strconv.Atoi(port); err != nil || n < 0 || n > 65535 {
		return fmt.Errorf("listen %q has an invalid port", value)
	}
	if host != "" && host != "localhost" {
		if _, err := netip.ParseAddr(host); err != nil {
			return fmt.Errorf("listen %q must use an IP address, localhost or an empty host", value)
		}
	}
	return nil
}

// parseTrustedProxies accepts IP addresses and CIDR ranges.
func parseTrustedProxies(values []string) ([]netip.Prefix, error) {
	prefixes := []netip.Prefix{}
	for _, raw := range values {
		value := strings.TrimSpace(raw)
		if value == "" {
			continue
		}
		if prefix, err := netip.ParsePrefix(value); err == nil {
			prefixes = append(prefixes, prefix.Masked())
			continue
		}
		addr, err := netip.ParseAddr(value)
		if err != nil {
			return nil, fmt.Errorf("trusted proxy %q is not an IP address or CIDR range", value)
		}
		prefixes = append(prefixes, netip.PrefixFrom(addr.Unmap(), addr.Unmap().BitLen()))
	}
	return prefixes, nil
}

func defaultRuntimeConfigFile() []byte {
	encoded, _ := json.MarshalIndent(map[string]any{"listen": "127.0.0.1:5699", "secure_cookies": false, "trusted_proxies": []string{}}, "", "  ")
	return append(encoded, '\n')
}

func loadRuntimeConfig(dataDir string, getenv func(string) string, flags runtimeFlags) (runtimeConfig, error) {
	config := runtimeConfig{Listen: "127.0.0.1:5699", TrustedProxies: []netip.Prefix{}}
	path := filepath.Join(dataDir, runtimeConfigFile)
	raw, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		if err := os.WriteFile(path, defaultRuntimeConfigFile(), 0o644); err != nil {
			return config, fmt.Errorf("create %s: %w", path, err)
		}
	} else if err != nil {
		return config, fmt.Errorf("read %s: %w", path, err)
	} else {
		var file runtimeConfigJSON
		decoder := json.NewDecoder(bytes.NewReader(raw))
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&file); err != nil {
			return config, fmt.Errorf("%s: %w", path, err)
		}
		if _, err := decoder.Token(); !errors.Is(err, io.EOF) {
			return config, fmt.Errorf("%s: unexpected content after the settings object", path)
		}
		if file.Listen != nil {
			if err := validListen(*file.Listen); err != nil {
				return config, fmt.Errorf("%s: %w", path, err)
			}
			config.Listen = *file.Listen
		}
		if file.SecureCookies != nil {
			config.SecureCookies = *file.SecureCookies
		}
		if file.TrustedProxies != nil {
			if config.TrustedProxies, err = parseTrustedProxies(file.TrustedProxies); err != nil {
				return config, fmt.Errorf("%s: %w", path, err)
			}
		}
	}
	if value := getenv("MUM_LISTEN"); value != "" {
		if err := validListen(value); err != nil {
			return config, fmt.Errorf("MUM_LISTEN: %w", err)
		}
		config.Listen = value
	}
	if value := getenv("MUM_SECURE_COOKIES"); value != "" {
		secure, err := strconv.ParseBool(value)
		if err != nil {
			return config, fmt.Errorf("MUM_SECURE_COOKIES must be true or false, got %q", value)
		}
		config.SecureCookies = secure
	}
	if value := getenv("MUM_TRUSTED_PROXIES"); value != "" {
		if config.TrustedProxies, err = parseTrustedProxies(strings.Split(value, ",")); err != nil {
			return config, fmt.Errorf("MUM_TRUSTED_PROXIES: %w", err)
		}
	}
	if flags.Listen != nil {
		if err := validListen(*flags.Listen); err != nil {
			return config, fmt.Errorf("--listen: %w", err)
		}
		config.Listen = *flags.Listen
	}
	if flags.SecureCookies != nil {
		config.SecureCookies = *flags.SecureCookies
	}
	if flags.TrustedProxies != nil {
		if config.TrustedProxies, err = parseTrustedProxies(strings.Split(*flags.TrustedProxies, ",")); err != nil {
			return config, fmt.Errorf("--trusted-proxies: %w", err)
		}
	}
	return config, nil
}
