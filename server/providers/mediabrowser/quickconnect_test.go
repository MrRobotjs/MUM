package mediabrowser

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"app/server/providers/provider"
)

// quickConnectFixture is a Jellyfin server whose Quick Connect request is
// approved once approved is set.
type quickConnectFixture struct {
	server   *httptest.Server
	mu       sync.Mutex
	enabled  bool
	approved bool
	finishes []string
	logouts  []string
	apiKeys  int
	unsigned int
}

func newQuickConnectFixture(t *testing.T) *quickConnectFixture {
	t.Helper()
	f := &quickConnectFixture{enabled: true}
	f.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		if r.Header.Get("X-Emby-Token") == "server-api-key" {
			f.apiKeys++
		}
		if r.URL.Path != "/Sessions/Logout" && !strings.Contains(r.Header.Get("Authorization"), `Client="MUM"`) {
			f.unsigned++
		}
		switch {
		case r.URL.Path == "/QuickConnect/Initiate" && r.Method == http.MethodPost:
			if !f.enabled {
				w.WriteHeader(http.StatusUnauthorized)
				return
			}
			_, _ = w.Write([]byte(`{"Authenticated":false,"Secret":"qc-secret","Code":"123456"}`))
		case r.URL.Path == "/QuickConnect/Connect" && r.Method == http.MethodGet:
			if r.URL.Query().Get("secret") != "qc-secret" {
				w.WriteHeader(http.StatusNotFound)
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"Authenticated": f.approved, "Secret": "qc-secret", "Code": "123456"})
		case r.URL.Path == "/Users/AuthenticateWithQuickConnect" && r.Method == http.MethodPost:
			var body struct{ Secret string }
			_ = json.NewDecoder(r.Body).Decode(&body)
			f.finishes = append(f.finishes, body.Secret)
			if body.Secret != "qc-secret" || !f.approved {
				w.WriteHeader(http.StatusBadRequest)
				return
			}
			_, _ = w.Write([]byte(`{"User":{"Id":"5f0e6c4b-3C1D-4A55-9F3A-0123456789ab","Name":"Alice"},"AccessToken":"user-session-token"}`))
		case r.URL.Path == "/Sessions/Logout":
			f.logouts = append(f.logouts, r.Header.Get("X-Emby-Token"))
			w.WriteHeader(http.StatusNoContent)
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(f.server.Close)
	return f
}

func (f *quickConnectFixture) jellyfin() *Server {
	return New(provider.Config{URL: f.server.URL, APIKey: "server-api-key", Transport: provider.Transport{Client: f.server.Client()}}, false)
}

func TestQuickConnectSignsInTheApprovingUser(t *testing.T) {
	f := newQuickConnectFixture(t)
	s := f.jellyfin()
	request, err := s.StartQuickConnect(t.Context())
	if err != nil || request.Secret != "qc-secret" || request.Code != "123456" {
		t.Fatal(request, err)
	}
	if approved, err := s.CheckQuickConnect(t.Context(), request.Secret); err != nil || approved {
		t.Fatal("approved before the user approved", approved, err)
	}
	f.approved = true
	if approved, err := s.CheckQuickConnect(t.Context(), request.Secret); err != nil || !approved {
		t.Fatal("approval not seen", approved, err)
	}
	login, err := s.FinishQuickConnect(t.Context(), request.Secret)
	if err != nil || login.ID != "5f0e6c4b3c1d4a559f3a0123456789ab" || login.Name != "Alice" {
		t.Fatal(login, err)
	}
	if len(f.logouts) != 1 || f.logouts[0] != "user-session-token" {
		t.Fatal("server session not ended", f.logouts)
	}
	if f.apiKeys != 0 || f.unsigned != 0 {
		t.Fatal("Quick Connect sent the server API key or no client header", f.apiKeys, f.unsigned)
	}
}

func TestQuickConnectOffAndExpired(t *testing.T) {
	f := newQuickConnectFixture(t)
	f.enabled = false
	if _, err := f.jellyfin().StartQuickConnect(t.Context()); !errors.Is(err, provider.ErrQuickConnectOff) {
		t.Fatal("Quick Connect off not reported", err)
	}
	if _, err := f.jellyfin().CheckQuickConnect(t.Context(), "unknown"); !errors.Is(err, provider.ErrQuickConnectExpired) {
		t.Fatal("unknown request not reported as expired", err)
	}
	if _, err := f.jellyfin().FinishQuickConnect(t.Context(), "qc-secret"); !errors.Is(err, provider.ErrQuickConnectExpired) {
		t.Fatal("unapproved finish not refused", err)
	}
}
