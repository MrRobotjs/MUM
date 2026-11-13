// Package provider holds what every media service module shares: the data a
// module reports to MUM, the errors it returns and the HTTP transport it must
// use. Modules live in sibling packages (one per service) and never touch the
// database; MUM's core owns storage, jobs, checkpoints and permissions.
package provider

import (
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

// Definition names a compiled media service.
type Definition struct {
	ID          string
	Name        string
	Description string
	// DownloadLabels reports that Users fills UserAccess.DownloadsKnown, so
	// MUM can keep download labels for this service's accounts.
	DownloadLabels bool
}

// Config is what MUM gives a module for one configured server. Transport
// already carries MUM's redirect refusal and authority guard.
type Config struct {
	URL       string
	APIKey    string
	Transport Transport
	// ClientID identifies MUM to services that require it (Plex). Empty means
	// the module's default.
	ClientID string
	// Locations is the application's address-lookup cache, shared by every
	// read of every server. Nil means lookups are not remembered.
	Locations *LocationCache
}

type Info struct {
	Name    string `json:"name"`
	Version string `json:"version,omitempty"`
}

type Library struct {
	ID        string
	Name      string
	Type      string
	ItemCount *int64
}

type UserAccess struct {
	LibrariesKnown    bool
	DownloadsKnown    bool
	AllowDownloads    bool
	ContentRestricted bool
}

type User struct {
	ID           string
	Name         string
	Email        string
	Active       bool
	AllLibraries bool
	LibraryIDs   []string
	Access       *UserAccess
	Profile      *UserProfile
	Relationship *UserRelationship
}

// UserRelationship is how a user relates to the server owner, for services
// that report it (Plex). nil means not reported: the sync then leaves the
// matching automatic roles as they are.
type UserRelationship struct {
	Home       bool // a member of the owner's Plex Home
	SharesBack bool // shares their own server with the owner
}

// UserProfile holds optional observations, independent of access policy.
// Empty values mean unavailable, not deletion.
type UserProfile struct {
	AvatarURL string
	JoinDate  string
}

// Grant is the library access an invitation or Edit operation gives one server.
type Grant struct {
	ServerID       int64    `json:"server_id"`
	AllLibraries   bool     `json:"all_libraries"`
	LibraryIDs     []string `json:"library_ids"`
	AllowDownloads bool     `json:"allow_downloads"`
}

// Account is one remote account as a module observed it by its recorded ID.
// Detail is the module's own observed state, opaque to MUM: the core hands it
// back unchanged so the module can verify that nothing else was altered.
type Account struct {
	ID, Name         string
	Absent, Disabled bool
	Detail           any
}

// Resume is a recorded account whose interrupted setup MUM asks a module to
// finish: the remote ID and name recorded at creation, the frozen grant and
// the password the invitee chose.
type Resume struct {
	RemoteID, RemoteName string
	Grant                Grant
	Password             string
}

// ErrConflict means the remote state is not exactly what was expected. MUM
// treats it as "do not proceed and do not assume success".
var ErrConflict = errors.New("resource conflict")

// HTTPError is a non-2xx response from a media server.
type HTTPError struct{ StatusCode int }

func (e *HTTPError) Error() string {
	return fmt.Sprintf("provider returned HTTP %d", e.StatusCode)
}

// CredentialsError rejects a username or password the service cannot accept.
// Code is the stable API error code shown to clients.
type CredentialsError struct{ Code, Message string }

func (e *CredentialsError) Error() string { return e.Message }

// ValidID reports whether a remote ID is safe to record and to place in a URL
// path: 1–255 ASCII letters, digits, '-' or '_'.
func ValidID(id string) bool {
	if id == "" || len(id) > 255 {
		return false
	}
	for _, c := range []byte(id) {
		if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '-' || c == '_') {
			return false
		}
	}
	return true
}

// RandomToken returns 32 random bytes, URL-safe base64 encoded.
func RandomToken() string {
	bytes := make([]byte, 32)
	if _, err := rand.Read(bytes); err != nil {
		panic(err)
	}
	return base64.RawURLEncoding.EncodeToString(bytes)
}

// SetJSONHeaders marks a request as sending and accepting JSON.
func SetJSONHeaders(header http.Header, hasBody bool) {
	header.Set("Accept", "application/json")
	if hasBody {
		header.Set("Content-Type", "application/json")
	}
}

// CheckLibraries rejects a library list MUM cannot store: too many entries, a
// missing ID or name, a duplicate ID or a negative item count.
func CheckLibraries(rows []Library) error {
	if len(rows) > 10000 {
		return errors.New("too many libraries in one synchronization")
	}
	seen := map[string]bool{}
	for _, r := range rows {
		if r.ID == "" || strings.TrimSpace(r.Name) == "" || seen[r.ID] || r.ItemCount != nil && *r.ItemCount < 0 {
			return errors.New("provider returned invalid or duplicate libraries")
		}
		seen[r.ID] = true
	}
	return nil
}

// ValidText reports whether value is non-empty, trimmed, valid UTF-8 without
// control characters and at most maximum bytes: the shape MUM accepts for
// names and labels a media server reports.
func ValidText(value string, maximum int) bool {
	if value == "" || value != strings.TrimSpace(value) || len(value) > maximum || !utf8.ValidString(value) {
		return false
	}
	for _, c := range value {
		if unicode.IsControl(c) {
			return false
		}
	}
	return true
}

// Catalogue limits: MUM refuses a snapshot larger than these rather than
// storing part of it.
const (
	CatalogueMaxItems    = 50000
	CatalogueMaxEpisodes = 10000
	CataloguePageSize    = 200
	CatalogueImageMax    = 8 << 20
)

// ErrCatalogueUnsupported refuses a catalogue request a module cannot serve.
var ErrCatalogueUnsupported = errors.New("item catalogue is not implemented for this provider")

// CatalogueItem is one library item or episode a module reports.
type CatalogueItem struct {
	ID, Title, SortTitle, Type, Summary, AddedAt, ImageTag string
	Year                                                   *int64
	Rating                                                 *float64
	DurationMS                                             *int64
	// Season and Episode are set only for episodes.
	Season, Episode *int64
}

// BandwidthSample is one bin of a server's bandwidth statistics: the bytes
// sent at At to one account's device, locally or remotely.
type BandwidthSample struct {
	At              time.Time
	Bytes           int64
	LAN             bool
	Account, Device string
}

// Named is an account or device a statistics answer names.
type Named struct{ ID, Name string }

// BandwidthStatistics is a server's bandwidth samples with the accounts and
// devices they name.
type BandwidthStatistics struct {
	Samples           []BandwidthSample
	Accounts, Devices []Named
}

// ResourceSample is one reading of the server machine's and the media
// server's CPU and memory use, in percent; nil when not reported.
type ResourceSample struct {
	At                                             time.Time
	HostCPU, ProcessCPU, HostMemory, ProcessMemory *float64
}

// CatalogueCollection is one library collection a module reports.
type CatalogueCollection struct {
	ID, Title, SortTitle, ImageTag, AddedAt string
	ChildCount                              *int64
	Smart                                   bool
}

// TruncateRunes trims value and cuts it to at most max characters.
func TruncateRunes(value string, max int) string {
	value = strings.TrimSpace(value)
	if utf8.RuneCountInString(value) <= max {
		return value
	}
	return string([]rune(value)[:max])
}

// Timestamp formats t the way MUM stores times.
func Timestamp(t time.Time) string { return t.UTC().Format("2006-01-02T15:04:05.000000000Z") }
