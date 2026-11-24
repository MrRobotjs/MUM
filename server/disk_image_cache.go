package main

import (
	"bufio"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

const diskCacheDir = "Image Cache"
const diskCacheHeaderMax = 4096
const diskCacheObjectMax = 20 << 20

type diskCachePolicy struct {
	mode        string
	sharedBytes int64
	serverBytes map[int64]int64
	revision    int64
}
type diskCacheHeader struct {
	Server   int64  `json:"server"`
	Revision int64  `json:"revision"`
	Purpose  string `json:"purpose"`
	External string `json:"external"`
	Kind     string `json:"kind"`
	Stored   int64  `json:"stored"`
	Identity string `json:"identity,omitempty"`
}
type diskCacheEntry struct {
	header diskCacheHeader
	path   string
	size   int64
	used   time.Time
}
type diskImageCache struct {
	mu       sync.Mutex
	dir      string
	entries  map[imageCacheKey]diskCacheEntry
	policy   diskCachePolicy
	versions map[int64]uint64
	global   uint64
}

func diskCacheKey(h diskCacheHeader) imageCacheKey {
	return imageCacheKey{server: h.Server, revision: h.Revision, purpose: h.Purpose, external: h.External}
}
func validDiskCacheHeader(h diskCacheHeader) bool {
	return h.Server > 0 && h.Revision >= 0 && len(h.Purpose) > 0 && len(h.Purpose) <= 100 && len(h.External) > 0 && len(h.External) <= 128 && len(h.Identity) <= 128 && h.Stored > 0 && (h.Kind == "image/jpeg" || h.Kind == "image/png" || h.Kind == "image/webp" || h.Kind == "image/gif")
}
func readDiskImage(f *os.File) (diskCacheHeader, []byte, error) {
	var header diskCacheHeader
	reader := bufio.NewReader(io.LimitReader(f, diskCacheHeaderMax+diskCacheObjectMax+1))
	line, err := reader.ReadSlice('\n')
	if err != nil || len(line) > diskCacheHeaderMax || json.Unmarshal(line, &header) != nil || !validDiskCacheHeader(header) {
		return header, nil, errors.New("invalid image cache header")
	}
	body, err := io.ReadAll(reader)
	if err != nil || len(body) == 0 || len(body) > diskCacheObjectMax {
		return header, nil, errors.New("invalid cached image")
	}
	return header, body, nil
}

func openDiskImageCache(dir string) (*diskImageCache, error) {
	root, err := os.OpenRoot(dir)
	if err != nil {
		return nil, err
	}
	defer root.Close()
	if err = root.MkdirAll(diskCacheDir, 0700); err != nil {
		return nil, err
	}
	c := &diskImageCache{dir: dir, entries: make(map[imageCacheKey]diskCacheEntry), versions: make(map[int64]uint64)}
	err = fs.WalkDir(root.FS(), diskCacheDir, func(path string, d fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if d.IsDir() || d.Type()&os.ModeSymlink != 0 {
			return nil
		}
		if strings.HasSuffix(path, ".tmp") {
			_ = root.Remove(path)
			return nil
		}
		if !strings.HasSuffix(path, ".img") {
			return nil
		}
		info, err := d.Info()
		if err != nil || !info.Mode().IsRegular() || info.Size() > diskCacheObjectMax+diskCacheHeaderMax {
			if err == nil && info.Mode().IsRegular() {
				_ = root.Remove(path)
			}
			return nil
		}
		f, err := root.Open(path)
		if err != nil {
			return nil
		}
		h, _, err := readDiskImage(f)
		f.Close()
		if err != nil {
			_ = root.Remove(path)
			return nil
		}
		key := diskCacheKey(h)
		if filepath.Base(path) != cacheFileName(key) {
			_ = root.Remove(path)
			return nil
		}
		if prior, ok := c.entries[key]; !ok || info.ModTime().After(prior.used) {
			if ok {
				_ = root.Remove(prior.path)
			}
			c.entries[key] = diskCacheEntry{header: h, path: path, size: info.Size(), used: info.ModTime()}
		} else {
			_ = root.Remove(path)
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return c, nil
}
func cacheProviderName(provider string) string {
	switch provider {
	case "plex":
		return "Plex"
	case "jellyfin":
		return "Jellyfin"
	case "emby":
		return "Emby"
	case "audiobookshelf":
		return "Audiobookshelf"
	case "kavita":
		return "Kavita"
	case "komga":
		return "Komga"
	case "romm":
		return "RomM"
	}
	return safeCacheName(provider)
}
func safeCacheName(name string) string {
	var out strings.Builder
	for _, r := range name {
		if out.Len() >= 64 {
			break
		}
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '-', r == '_', r == '+':
			out.WriteRune(r)
		case r == ' ':
			out.WriteByte('-')
		}
	}
	if out.Len() == 0 {
		return "Server"
	}
	return out.String()
}
func cacheFileName(key imageCacheKey) string {
	data, _ := json.Marshal(diskCacheHeader{Server: key.server, Revision: key.revision, Purpose: key.purpose, External: key.external})
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:]) + ".img"
}
func (c *diskImageCache) get(key imageCacheKey, now time.Time) (string, []byte, bool) {
	kind, body, _, ok := c.getWithAge(key, now)
	return kind, body, ok
}
func (c *diskImageCache) getWithAge(key imageCacheKey, now time.Time) (string, []byte, time.Time, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	e, ok := c.entries[key]
	if !ok {
		return "", nil, time.Time{}, false
	}
	root, err := os.OpenRoot(c.dir)
	if err != nil {
		return "", nil, time.Time{}, false
	}
	defer root.Close()
	f, err := root.Open(e.path)
	if err != nil {
		delete(c.entries, key)
		return "", nil, time.Time{}, false
	}
	h, body, err := readDiskImage(f)
	f.Close()
	if err != nil || diskCacheKey(h) != key {
		_ = root.Remove(e.path)
		delete(c.entries, key)
		return "", nil, time.Time{}, false
	}
	e.used = now
	c.entries[key] = e
	_ = root.Chtimes(e.path, now, now)
	return h.Kind, body, time.Unix(h.Stored, 0), true
}
func (c *diskImageCache) generation(server int64) uint64 {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.versions[server] + c.global
}
func (c *diskImageCache) put(key imageCacheKey, provider, nickname, kind string, body []byte, now time.Time, policy diskCachePolicy, version uint64) error {
	return c.putMedia(key, provider, nickname, kind, body, now, policy, version, "")
}
func (c *diskImageCache) putMedia(key imageCacheKey, provider, nickname, kind string, body []byte, now time.Time, policy diskCachePolicy, version uint64, identity string) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.versions[key.server]+c.global != version {
		return nil
	}
	if policy.revision >= c.policy.revision {
		c.policy = policy
	} else {
		policy = c.policy
	}
	if len(body) == 0 || len(body) > diskCacheObjectMax {
		return errors.New("invalid image cache size")
	}
	h := diskCacheHeader{Server: key.server, Revision: key.revision, Purpose: key.purpose, External: key.external, Kind: kind, Stored: now.Unix(), Identity: identity}
	if !validDiskCacheHeader(h) {
		return errors.New("invalid image cache entry")
	}
	root, err := os.OpenRoot(c.dir)
	if err != nil {
		return err
	}
	defer root.Close()
	dir := filepath.Join(diskCacheDir, cacheProviderName(provider), fmt.Sprintf("%s--%d", safeCacheName(nickname), key.server))
	if err = root.MkdirAll(dir, 0700); err != nil {
		return err
	}
	path := filepath.Join(dir, cacheFileName(key))
	temp := path + "." + newUUID() + ".tmp"
	f, err := root.OpenFile(temp, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return err
	}
	header, _ := json.Marshal(h)
	_, err = f.Write(append(header, '\n'))
	if err == nil {
		_, err = f.Write(body)
	}
	closeErr := f.Close()
	if err == nil {
		err = closeErr
	}
	if err != nil {
		_ = root.Remove(temp)
		return err
	}
	if err = root.Rename(temp, path); err != nil {
		_ = root.Remove(temp)
		return err
	}
	if old, ok := c.entries[key]; ok && old.path != path {
		_ = root.Remove(old.path)
	}
	_ = root.Chtimes(path, now, now)
	c.entries[key] = diskCacheEntry{header: h, path: path, size: int64(len(header) + 1 + len(body)), used: now}
	return c.enforceLocked(root, policy)
}
func (c *diskImageCache) getMedia(server, revision int64, identity string, now time.Time) (string, []byte, time.Time, bool) {
	if identity == "" {
		return "", nil, time.Time{}, false
	}
	c.mu.Lock()
	var best imageCacheKey
	var stored int64
	for key, e := range c.entries {
		if key.server == server && key.revision == revision && key.purpose == "media-poster" && e.header.Identity == identity && e.header.Stored >= stored {
			best = key
			stored = e.header.Stored
		}
	}
	c.mu.Unlock()
	if stored == 0 {
		return "", nil, time.Time{}, false
	}
	return c.getWithAge(best, now)
}
func (c *diskImageCache) hasMedia(server, revision int64, identity string) bool {
	if identity == "" {
		return false
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	for key, e := range c.entries {
		if key.server == server && key.revision == revision && key.purpose == "media-poster" && e.header.Identity == identity {
			return true
		}
	}
	return false
}
func (c *diskImageCache) applyPolicy(policy diskCachePolicy) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if policy.revision < c.policy.revision {
		return nil
	}
	c.policy = policy
	root, err := os.OpenRoot(c.dir)
	if err != nil {
		return err
	}
	defer root.Close()
	return c.enforceLocked(root, policy)
}
func (c *diskImageCache) enforceLocked(root *os.Root, policy diskCachePolicy) error {
	entries := make([]diskCacheEntry, 0, len(c.entries))
	var total int64
	per := map[int64]int64{}
	for _, e := range c.entries {
		entries = append(entries, e)
		total += e.size
		per[e.header.Server] += e.size
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].used.Before(entries[j].used) })
	for _, e := range entries {
		limit := policy.serverBytes[e.header.Server]
		if limit <= 0 {
			limit = 1 << 30
		}
		over := policy.mode == "shared" && total > policy.sharedBytes || policy.mode == "per_server" && per[e.header.Server] > limit
		if !over {
			continue
		}
		if err := root.Remove(e.path); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
		delete(c.entries, diskCacheKey(e.header))
		total -= e.size
		per[e.header.Server] -= e.size
	}
	return nil
}
func (c *diskImageCache) clear(server int64) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if server == 0 {
		c.global++
	} else {
		c.versions[server]++
	}
	root, err := os.OpenRoot(c.dir)
	if err != nil {
		return err
	}
	defer root.Close()
	for key, e := range c.entries {
		if server != 0 && key.server != server {
			continue
		}
		if err := root.Remove(e.path); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
		delete(c.entries, key)
	}
	return nil
}
func (c *diskImageCache) usage() (int64, map[int64]int64) {
	c.mu.Lock()
	defer c.mu.Unlock()
	var total int64
	per := map[int64]int64{}
	for key, e := range c.entries {
		total += e.size
		per[key.server] += e.size
	}
	return total, per
}

// Rename the display folder without changing keys or losing cached images.
func (c *diskImageCache) renameServer(server int64, provider, nickname string) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.versions[server]++
	root, err := os.OpenRoot(c.dir)
	if err != nil {
		return err
	}
	defer root.Close()
	dir := filepath.Join(diskCacheDir, cacheProviderName(provider), fmt.Sprintf("%s--%d", safeCacheName(nickname), server))
	if err := root.MkdirAll(dir, 0700); err != nil {
		return err
	}
	oldDirs := map[string]bool{}
	for key, e := range c.entries {
		if key.server != server {
			continue
		}
		next := filepath.Join(dir, cacheFileName(key))
		if next == e.path {
			continue
		}
		if err := root.Rename(e.path, next); err != nil {
			return err
		}
		oldDirs[filepath.Dir(e.path)] = true
		e.path = next
		c.entries[key] = e
	}
	for old := range oldDirs {
		_ = root.Remove(old)
	}
	return nil
}
