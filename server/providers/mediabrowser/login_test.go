package mediabrowser

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"app/server/providers/provider"
)

type loginFixture struct {
	server  *httptest.Server
	logouts []string
	body    map[string]string
	apiKeys []string
}

func newLoginFixture(t *testing.T, prefix string, answer func(w http.ResponseWriter)) *loginFixture {
	t.Helper()
	f := &loginFixture{}
	f.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if key := r.Header.Get("X-Emby-Token"); key != "" && r.URL.Path == prefix+"/Users/AuthenticateByName" {
			f.apiKeys = append(f.apiKeys, key)
		}
		switch r.URL.Path {
		case prefix + "/Users/AuthenticateByName":
			if r.Method != http.MethodPost || !strings.Contains(r.Header.Get("X-Emby-Authorization"), `Client="MUM"`) {
				w.WriteHeader(http.StatusBadRequest)
				return
			}
			_ = json.NewDecoder(r.Body).Decode(&f.body)
			answer(w)
		case prefix + "/Sessions/Logout":
			f.logouts = append(f.logouts, r.Header.Get("X-Emby-Token"))
			w.WriteHeader(http.StatusNoContent)
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(f.server.Close)
	return f
}

func loginServer(f *loginFixture, emby bool) *Server {
	return New(provider.Config{URL: f.server.URL, APIKey: "server-api-key", Transport: provider.Transport{Client: f.server.Client()}}, emby)
}

func TestVerifyLoginSuccessEndsServerSession(t *testing.T) {
	for _, emby := range []bool{false, true} {
		prefix := ""
		if emby {
			prefix = "/emby"
		}
		f := newLoginFixture(t, prefix, func(w http.ResponseWriter) {
			_, _ = w.Write([]byte(`{"User":{"Id":"5f0e6c4b-3C1D-4A55-9F3A-0123456789ab","Name":"Alice"},"AccessToken":"user-session-token"}`))
		})
		login, err := loginServer(f, emby).VerifyLogin(t.Context(), "alice", "correct horse")
		if err != nil {
			t.Fatal(emby, err)
		}
		if login.ID != "5f0e6c4b3c1d4a559f3a0123456789ab" || login.Name != "Alice" {
			t.Fatal("unexpected login", login)
		}
		if f.body["Username"] != "alice" || f.body["Pw"] != "correct horse" {
			t.Fatal("login request body", f.body)
		}
		if len(f.logouts) != 1 || f.logouts[0] != "user-session-token" {
			t.Fatal("server session not ended with its own token", f.logouts)
		}
	}
}

func TestVerifyLoginWrongPassword(t *testing.T) {
	for _, status := range []int{http.StatusUnauthorized, http.StatusBadRequest, http.StatusForbidden} {
		f := newLoginFixture(t, "", func(w http.ResponseWriter) { w.WriteHeader(status) })
		if _, err := loginServer(f, false).VerifyLogin(t.Context(), "alice", "wrong"); !errors.Is(err, provider.ErrInvalidLogin) {
			t.Fatal(status, err)
		}
	}
	f := newLoginFixture(t, "", func(w http.ResponseWriter) { w.WriteHeader(http.StatusInternalServerError) })
	if _, err := loginServer(f, false).VerifyLogin(t.Context(), "alice", "pw"); err == nil || errors.Is(err, provider.ErrInvalidLogin) {
		t.Fatal("a server error must not look like a refused login", err)
	}
}

func TestVerifyLoginMissingID(t *testing.T) {
	for _, body := range []string{`{"User":{"Id":"","Name":"Alice"},"AccessToken":"t"}`, `{"User":null,"AccessToken":"t"}`, `{}`, `not json`} {
		f := newLoginFixture(t, "", func(w http.ResponseWriter) { _, _ = w.Write([]byte(body)) })
		if login, err := loginServer(f, false).VerifyLogin(t.Context(), "alice", "pw"); err == nil {
			t.Fatal("accepted a login without a user ID", body, login)
		}
	}
}

func TestVerifyLoginDoesNotSendAPIKey(t *testing.T) {
	f := newLoginFixture(t, "", func(w http.ResponseWriter) {
		_, _ = w.Write([]byte(`{"User":{"Id":"abc","Name":"Alice"},"AccessToken":"t"}`))
	})
	if _, err := loginServer(f, false).VerifyLogin(t.Context(), "alice", "pw"); err != nil {
		t.Fatal(err)
	}
	if len(f.apiKeys) != 0 {
		t.Fatal("the server API key was sent with a user's login", f.apiKeys)
	}
}

func TestCanonicalUserID(t *testing.T) {
	if CanonicalUserID("5F0E6C4B-3C1D-4A55-9F3A-0123456789AB") != "5f0e6c4b3c1d4a559f3a0123456789ab" {
		t.Fatal("canonical ID")
	}
}
