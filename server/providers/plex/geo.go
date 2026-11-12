package plex

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
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
	"time"

	"app/server/providers/provider"
)

// maxGeoBytes bounds one plex.tv GeoIP reply.
const maxGeoBytes = 64 << 10

// GeoPoint is a parsed plex.tv GeoIP reply. IP is the address plex.tv says it
// located, when it reports one.
type GeoPoint struct {
	Latitude, Longitude float64
	IP                  string
}

// ParseGeo reads a JSON or XML GeoIP reply. Duplicate keys or attributes,
// extra elements, text and coordinates out of range are rejected.
func ParseGeo(body []byte, kind string) (GeoPoint, error) {
	var point GeoPoint
	bad := errors.New("invalid Plex GeoIP response")
	if len(body) == 0 || len(body) > maxGeoBytes {
		return point, bad
	}
	coordinates := ""
	if strings.Contains(strings.ToLower(kind), "json") {
		fields, err := provider.DecodeObject(body, maxGeoBytes)
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

// geo asks plex.tv for the location of one public address with the server's
// token.
func (s *Server) geo(ctx context.Context, ip netip.Addr) (*provider.Location, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "https://plex.tv/api/v2/geoip?"+url.Values{"ip_address": {ip.String()}}.Encode(), nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("X-Plex-Token", s.token)
	req.Header.Set("X-Plex-Client-Identifier", DefaultClientID)
	kind, body, err := s.transport.Fetch(req, maxGeoBytes, nil)
	if err != nil {
		return nil, err
	}
	point, err := ParseGeo(body, kind)
	if err != nil {
		return nil, err
	}
	if point.IP != "" && SessionAddress(point.IP) != ip {
		return nil, errors.New("Plex GeoIP address mismatch")
	}
	return &provider.Location{Latitude: point.Latitude, Longitude: point.Longitude}, nil
}

// maxGeoLookups bounds the plex.tv requests made for one snapshot.
const maxGeoLookups = 16

// enrichLocations adds coordinates to sessions from public (WAN) addresses.
// It is optional: a failed or skipped lookup only leaves the location out,
// and failures are remembered briefly so a down service is not asked every
// poll. Results are cached per server and token.
func (s *Server) enrichLocations(ctx context.Context, snapshot *provider.ActivitySnapshot) {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	sum := sha256.Sum256([]byte(s.url + "\x00" + s.token))
	scope := hex.EncodeToString(sum[:])
	seen := map[netip.Addr]*provider.Location{}
	lookups, failures := 0, 0
	for i := range snapshot.Sessions {
		d := snapshot.Sessions[i].Display
		if d == nil || d.LocationType == "LAN" {
			continue
		}
		ip := PublicSessionAddress(d.IP)
		if !ip.IsValid() {
			continue
		}
		public := true
		d.PublicIP = &public
		location, known := seen[ip]
		if !known {
			location, known = s.locations.Get(scope, ip)
			if !known {
				if lookups >= maxGeoLookups || ctx.Err() != nil {
					continue
				}
				lookups++
				var err error
				location, err = s.geo(ctx, ip)
				if err != nil {
					location = nil
					failures++
				}
				s.locations.Set(scope, ip, location)
			}
			seen[ip] = location
		}
		if location != nil {
			lat, lon := location.Latitude, location.Longitude
			d.Latitude, d.Longitude = &lat, &lon
		}
	}
	if failures > 0 {
		slog.Warn("Plex GeoIP unavailable; stream locations omitted", "failed_lookups", failures)
	}
}
