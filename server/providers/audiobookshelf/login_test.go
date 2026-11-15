package audiobookshelf

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"app/server/providers/provider"
)

type loginFixture struct {
	server   *httptest.Server
	body     map[string]string
	logouts  []string
	auth     []string
	returned []string
}

func newLoginFixture(t *testing.T, answer func(w http.ResponseWriter)) *loginFixture {
	t.Helper()
	f := &loginFixture{}
	f.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/login":
			f.auth = append(f.auth, r.Header.Get("Authorization"))
			f.returned = append(f.returned, r.Header.Get("x-return-tokens"))
			_ = json.NewDecoder(r.Body).Decode(&f.body)
			answer(w)
		case "/logout":
			f.logouts = append(f.logouts, r.Header.Get("x-refresh-token"))
			_, _ = w.Write([]byte(`{}`))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(f.server.Close)
	return f
}

func (f *loginFixture) adapter() *Server {
	return New(provider.Config{URL: f.server.URL, APIKey: "server-api-key", Transport: provider.Transport{Client: f.server.Client()}})
}

func TestVerifyLoginSuccessEndsServerSession(t *testing.T) {
	f := newLoginFixture(t, func(w http.ResponseWriter) {
		_, _ = w.Write([]byte(`{"user":{"id":"usr_1","username":"alice","refreshToken":"refresh-1","accessToken":"access-1"}}`))
	})
	login, err := f.adapter().VerifyLogin(t.Context(), "alice", "correct horse")
	if err != nil {
		t.Fatal(err)
	}
	if login.ID != "usr_1" || login.Name != "alice" || f.body["username"] != "alice" || f.body["password"] != "correct horse" {
		t.Fatal("login", login, f.body)
	}
	if len(f.returned) != 1 || f.returned[0] != "true" {
		t.Fatal("tokens must be returned in the body, not set as cookies", f.returned)
	}
	if len(f.logouts) != 1 || f.logouts[0] != "refresh-1" {
		t.Fatal("server session not ended", f.logouts)
	}
}

func TestVerifyLoginWrongPassword(t *testing.T) {
	f := newLoginFixture(t, func(w http.ResponseWriter) { w.WriteHeader(http.StatusUnauthorized) })
	if _, err := f.adapter().VerifyLogin(t.Context(), "alice", "wrong"); !errors.Is(err, provider.ErrInvalidLogin) {
		t.Fatal(err)
	}
}

func TestVerifyLoginMissingID(t *testing.T) {
	for _, body := range []string{`{"user":{"id":"","username":"alice"}}`, `{"user":null}`, `[]`} {
		f := newLoginFixture(t, func(w http.ResponseWriter) { _, _ = w.Write([]byte(body)) })
		if _, err := f.adapter().VerifyLogin(t.Context(), "alice", "pw"); err == nil {
			t.Fatal("accepted a login without a user ID", body)
		}
	}
}

func TestVerifyLoginDoesNotSendAPIKey(t *testing.T) {
	f := newLoginFixture(t, func(w http.ResponseWriter) { _, _ = w.Write([]byte(`{"user":{"id":"usr_1","username":"alice"}}`)) })
	if _, err := f.adapter().VerifyLogin(t.Context(), "alice", "pw"); err != nil {
		t.Fatal(err)
	}
	if f.auth[0] != "" {
		t.Fatal("the server API key was sent with a user's login")
	}
}
