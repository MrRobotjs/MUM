package provider

import (
	"errors"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// MaxLiveFrameBytes bounds one frame read from a live connection.
const MaxLiveFrameBytes = 64 * 1024

// LiveConnection describes a service's live notification socket. MUM's core
// opens and supervises it: it dials URL with Header (never following
// redirects), writes Start when it is set, and passes each frame to the
// module's LiveEvent. Frames are only hints that sessions changed; the core
// then reads a complete snapshot over HTTP.
type LiveConnection struct {
	URL    string
	Header http.Header
	// Start is a JSON text message sent once connected (may be empty).
	Start []byte
	// Binary accepts binary frames as well as text frames.
	Binary bool
	// ReadTimeout drops a connection that sends nothing for this long; zero
	// means no limit. PingInterval sends a ping this often; zero means none.
	ReadTimeout, PingInterval time.Duration
}

// ErrLiveSource reports a server address or credential that cannot be used
// for a live connection.
var ErrLiveSource = errors.New("server address cannot be used for a live connection")

// SocketURL turns a configured http(s) server address into a ws(s) address,
// appending suffix to its path (when not empty) and setting query. Addresses
// with credentials, a query or a fragment are refused.
func SocketURL(base, suffix string, query url.Values) (string, error) {
	u, err := url.Parse(base)
	if err != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return "", ErrLiveSource
	}
	switch u.Scheme {
	case "http":
		u.Scheme = "ws"
	case "https":
		u.Scheme = "wss"
	default:
		return "", ErrLiveSource
	}
	if suffix != "" {
		u.Path = strings.TrimRight(u.Path, "/") + suffix
	}
	u.RawPath = ""
	u.RawQuery = query.Encode()
	return u.String(), nil
}
