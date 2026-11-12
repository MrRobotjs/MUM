package main

import (
	"bytes"
	"context"
	"encoding/json"
	"encoding/xml"
	"errors"
	"io"
	"log/slog"
	"math"
	"net/http"
	"net/netip"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
)

type plexGeoPoint struct {
	Latitude, Longitude float64
	IP                  string
}
type plexGeoKey struct {
	Scope string
	IP    netip.Addr
}
type plexGeoEntry struct {
	Point *plexGeoPoint
	Until time.Time
}
type plexGeoCache struct {
	mu      sync.Mutex
	entries map[plexGeoKey]plexGeoEntry
}

func (c *plexGeoCache) get(key plexGeoKey) (*plexGeoPoint, bool) {
	if c == nil {
		return nil, false
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	entry, ok := c.entries[key]
	if ok && !entry.Until.After(time.Now()) {
		delete(c.entries, key)
		return nil, false
	}
	return entry.Point, ok
}
func (c *plexGeoCache) set(key plexGeoKey, point *plexGeoPoint) {
	if c == nil {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.entries == nil {
		c.entries = make(map[plexGeoKey]plexGeoEntry)
	}
	if _, exists := c.entries[key]; !exists && len(c.entries) >= 256 {
		var oldest plexGeoKey
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
	if point == nil {
		ttl = 30 * time.Second
	}
	c.entries[key] = plexGeoEntry{Point: point, Until: time.Now().Add(ttl)}
}

func sessionAddress(value string) netip.Addr {
	value = strings.TrimSpace(strings.SplitN(value, ",", 2)[0])
	if addr, err := netip.ParseAddr(value); err == nil {
		return addr.WithZone("").Unmap()
	}
	if addr, err := netip.ParseAddrPort(value); err == nil {
		return addr.Addr().WithZone("").Unmap()
	}
	if strings.HasPrefix(value, "[") && strings.HasSuffix(value, "]") {
		if addr, err := netip.ParseAddr(value[1 : len(value)-1]); err == nil {
			return addr.WithZone("").Unmap()
		}
	}
	return netip.Addr{}
}

var nonPublicSessionRanges = []netip.Prefix{
	netip.MustParsePrefix("0.0.0.0/8"), netip.MustParsePrefix("100.64.0.0/10"),
	netip.MustParsePrefix("192.0.0.0/24"), netip.MustParsePrefix("192.0.2.0/24"), netip.MustParsePrefix("192.88.99.0/24"),
	netip.MustParsePrefix("198.18.0.0/15"), netip.MustParsePrefix("198.51.100.0/24"), netip.MustParsePrefix("203.0.113.0/24"), netip.MustParsePrefix("240.0.0.0/4"),
	netip.MustParsePrefix("2001::/32"), netip.MustParsePrefix("2001:2::/48"), netip.MustParsePrefix("2001:db8::/32"), netip.MustParsePrefix("2001:10::/28"), netip.MustParsePrefix("2001:20::/28"), netip.MustParsePrefix("3fff::/20"),
}

func publicSessionAddress(value string) netip.Addr {
	addr := sessionAddress(value)
	if !addr.IsValid() || !addr.IsGlobalUnicast() || addr.IsPrivate() || addr.IsLoopback() || addr.IsLinkLocalUnicast() {
		return netip.Addr{}
	}
	if addr.Is6() && !netip.MustParsePrefix("2000::/3").Contains(addr) {
		return netip.Addr{}
	}
	for _, reserved := range nonPublicSessionRanges {
		if reserved.Contains(addr) {
			return netip.Addr{}
		}
	}
	return addr
}

func parsePlexGeo(body []byte, kind string) (plexGeoPoint, error) {
	var point plexGeoPoint
	bad := errors.New("invalid Plex GeoIP response")
	if len(body) == 0 || len(body) > 64<<10 {
		return point, bad
	}
	coordinates := ""
	if strings.Contains(strings.ToLower(kind), "json") {
		fields, err := decodeProviderSocketFrame(body)
		if err != nil {
			return point, bad
		}
		if json.Unmarshal(fields["coordinates"], &coordinates) != nil {
			return point, bad
		}
		for _, key := range []string{"ip", "ip_address"} {
			if raw, ok := fields[key]; ok {
				if json.Unmarshal(raw, &point.IP) != nil {
					return point, bad
				}
				break
			}
		}
	} else {
		decoder := xml.NewDecoder(bytes.NewReader(body))
		depth, roots := 0, 0
		for {
			token, err := decoder.Token()
			if errors.Is(err, io.EOF) {
				break
			}
			if err != nil {
				return point, bad
			}
			switch node := token.(type) {
			case xml.StartElement:
				depth++
				roots++
				if depth != 1 || roots != 1 || node.Name.Space != "" || (strings.ToLower(node.Name.Local) != "location" && strings.ToLower(node.Name.Local) != "geoip") {
					return point, bad
				}
				seen := map[xml.Name]bool{}
				for _, a := range node.Attr {
					if seen[a.Name] || a.Name.Space != "" {
						return point, bad
					}
					seen[a.Name] = true
					switch a.Name.Local {
					case "coordinates":
						coordinates = a.Value
					case "ip", "ip_address":
						point.IP = a.Value
					}
				}
			case xml.EndElement:
				depth--
			case xml.Directive:
				return point, bad
			case xml.CharData:
				if len(bytes.TrimSpace(node)) > 0 {
					return point, bad
				}
			}
		}
		if roots != 1 || depth != 0 {
			return point, bad
		}
	}
	parts := strings.Split(coordinates, ",")
	if len(parts) != 2 {
		return point, bad
	}
	lat, errLat := strconv.ParseFloat(strings.TrimSpace(parts[0]), 64)
	lon, errLon := strconv.ParseFloat(strings.TrimSpace(parts[1]), 64)
	if errLat != nil || errLon != nil || math.IsNaN(lat) || math.IsNaN(lon) || math.IsInf(lat, 0) || math.IsInf(lon, 0) || lat < -90 || lat > 90 || lon < -180 || lon > 180 {
		return point, bad
	}
	point.Latitude, point.Longitude = lat, lon
	return point, nil
}

func (p *jsonProvider) plexGeo(ctx context.Context, ip netip.Addr) (*plexGeoPoint, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, "https://plex.tv/api/v2/geoip?"+url.Values{"ip_address": {ip.String()}}.Encode(), nil)
	if err != nil {
		return nil, err
	}
	request.Header.Set("Accept", "application/json")
	request.Header.Set("X-Plex-Token", p.config.APIKey)
	request.Header.Set("X-Plex-Client-Identifier", "mum-go")
	client := *p.client
	client.Jar = nil // The provider's redirect refusal is retained.
	response, err := client.Do(request)
	if err != nil {
		return nil, errors.New("Plex GeoIP request failed")
	}
	defer response.Body.Close()
	if response.StatusCode != 200 {
		return nil, errors.New("Plex GeoIP unavailable")
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, (64<<10)+1))
	if err != nil {
		return nil, errors.New("Plex GeoIP response unreadable")
	}
	point, err := parsePlexGeo(body, response.Header.Get("Content-Type"))
	if err != nil {
		return nil, err
	}
	if point.IP != "" && sessionAddress(point.IP) != ip {
		return nil, errors.New("Plex GeoIP address mismatch")
	}
	return &point, nil
}

func (p *jsonProvider) enrichPlexGeo(ctx context.Context, snapshot *activitySnapshot) {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	scope := tokenHash(p.config.URL + "\x00" + p.config.APIKey)
	seen := map[netip.Addr]*plexGeoPoint{}
	lookups, failures := 0, 0
	for i := range snapshot.Sessions {
		d := snapshot.Sessions[i].Display
		if d == nil || d.LocationType == "LAN" {
			continue
		}
		ip := publicSessionAddress(d.IP)
		if !ip.IsValid() {
			continue
		}
		public := true
		d.PublicIP = &public
		point, known := seen[ip]
		if !known {
			key := plexGeoKey{Scope: scope, IP: ip}
			point, known = p.geoCache.get(key)
			if !known {
				if lookups >= 16 || ctx.Err() != nil {
					continue
				}
				lookups++
				var err error
				point, err = p.plexGeo(ctx, ip)
				if err != nil {
					point = nil
					failures++
				}
				p.geoCache.set(key, point)
			}
			seen[ip] = point
		}
		if point != nil {
			lat, lon := point.Latitude, point.Longitude
			d.Latitude, d.Longitude = &lat, &lon
		}
	}
	if failures > 0 {
		slog.Warn("Plex GeoIP unavailable; stream locations omitted", "failed_lookups", failures)
	}
}
