package provider

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/netip"
	"sync"
	"time"
)

// Location is a player's approximate coordinates.
type Location struct {
	Latitude, Longitude float64
}

// LocationCache remembers address lookups across session reads. MUM's core
// owns one for the whole application and passes it in Config, because a
// module is rebuilt for every operation. It holds at most 256 entries: a found
// location for 12 hours, a failed lookup (nil) for 30 seconds. The zero value
// is ready to use; a nil cache remembers nothing.
type LocationCache struct {
	mu      sync.Mutex
	entries map[locationKey]locationEntry
}

type locationKey struct {
	Scope string
	IP    netip.Addr
}

type locationEntry struct {
	Location *Location
	Until    time.Time
}

const locationCacheSize = 256

// Get returns the remembered result for ip within scope (one server and
// credential), and whether there is one. A nil location is a remembered
// failure.
func (c *LocationCache) Get(scope string, ip netip.Addr) (*Location, bool) {
	if c == nil {
		return nil, false
	}
	key := locationKey{Scope: scope, IP: ip}
	c.mu.Lock()
	defer c.mu.Unlock()
	entry, ok := c.entries[key]
	if ok && !entry.Until.After(time.Now()) {
		delete(c.entries, key)
		return nil, false
	}
	return entry.Location, ok
}

// Set remembers a lookup result; nil records a failure. When the cache is
// full, the entry closest to expiry is dropped.
func (c *LocationCache) Set(scope string, ip netip.Addr, location *Location) {
	if c == nil {
		return
	}
	key := locationKey{Scope: scope, IP: ip}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.entries == nil {
		c.entries = make(map[locationKey]locationEntry)
	}
	if _, exists := c.entries[key]; !exists && len(c.entries) >= locationCacheSize {
		var oldest locationKey
		var until time.Time
		for k, v := range c.entries {
			if until.IsZero() || v.Until.Before(until) {
				oldest = k
				until = v.Until
			}
		}
		delete(c.entries, oldest)
	}
	ttl := 12 * time.Hour
	if location == nil {
		ttl = 30 * time.Second
	}
	c.entries[key] = locationEntry{Location: location, Until: time.Now().Add(ttl)}
}

// DecodeObject decodes one JSON object of at most max bytes, rejecting
// duplicate keys at any depth and trailing data. Every failure is
// ErrActivitySnapshot.
func DecodeObject(data []byte, max int) (map[string]json.RawMessage, error) {
	if len(data) > max || !json.Valid(data) {
		return nil, ErrActivitySnapshot
	}
	d := json.NewDecoder(bytes.NewReader(data))
	if err := UniqueJSONKeys(d); err != nil {
		return nil, err
	}
	if _, err := d.Token(); !errors.Is(err, io.EOF) {
		return nil, ErrActivitySnapshot
	}
	var object map[string]json.RawMessage
	if err := json.Unmarshal(data, &object); err != nil {
		return nil, ErrActivitySnapshot
	}
	return object, nil
}
