package main

import (
	"context"
	"net"
	"net/http"
	"net/netip"
	"strings"
)

// Reverse-proxy support. X-Forwarded-For/-Proto/-Host are honoured only when
// the connection comes from a configured trusted proxy; from anyone else they
// are ignored, so clients cannot spoof their address, scheme or host.

type forwardedHTTPSKey struct{}

func remoteIP(remote string) (netip.Addr, bool) {
	host, _, err := net.SplitHostPort(remote)
	if err != nil {
		host = remote
	}
	addr, err := netip.ParseAddr(host)
	if err != nil {
		return netip.Addr{}, false
	}
	return addr.Unmap(), true
}

func (a *App) trustedProxy(addr netip.Addr) bool {
	for _, prefix := range a.TrustedProxies {
		if prefix.Contains(addr) {
			return true
		}
	}
	return false
}

// firstHeaderValue returns the first comma-separated value of a header.
func firstHeaderValue(r *http.Request, name string) string {
	value, _, _ := strings.Cut(r.Header.Get(name), ",")
	return strings.TrimSpace(value)
}

// applyForwarded rewrites RemoteAddr, Host and the request scheme from a
// trusted proxy's headers. The client is the rightmost X-Forwarded-For entry
// that is not itself a trusted proxy (earlier entries are client-supplied).
func (a *App) applyForwarded(r *http.Request) *http.Request {
	if len(a.TrustedProxies) == 0 {
		return r
	}
	peer, ok := remoteIP(r.RemoteAddr)
	if !ok || !a.trustedProxy(peer) {
		return r
	}
	client := peer
	hops := strings.Split(r.Header.Get("X-Forwarded-For"), ",")
	for i := len(hops) - 1; i >= 0; i-- {
		addr, err := netip.ParseAddr(strings.TrimSpace(hops[i]))
		if err != nil {
			break
		}
		client = addr.Unmap()
		if !a.trustedProxy(client) {
			break
		}
	}
	forwarded := r.WithContext(r.Context())
	forwarded.RemoteAddr = net.JoinHostPort(client.String(), "0")
	if host := firstHeaderValue(r, "X-Forwarded-Host"); host != "" && !strings.ContainsAny(host, "/\\@ ") {
		forwarded.Host = host
	}
	if strings.EqualFold(firstHeaderValue(r, "X-Forwarded-Proto"), "https") {
		forwarded = forwarded.WithContext(context.WithValue(forwarded.Context(), forwardedHTTPSKey{}, true))
	}
	return forwarded
}

// requestHTTPS reports whether the browser reached MUM over HTTPS, either
// directly or through a trusted proxy that terminated TLS.
func requestHTTPS(r *http.Request) bool {
	if r.TLS != nil {
		return true
	}
	https, _ := r.Context().Value(forwardedHTTPSKey{}).(bool)
	return https
}

// secureCookie reports whether cookies must carry the Secure attribute.
func (a *App) secureCookie(r *http.Request) bool {
	return a.SecureCookies || requestHTTPS(r)
}
