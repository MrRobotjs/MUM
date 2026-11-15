package kavita

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"app/server/providers/provider"
)

type loginFixture struct {
	server *httptest.Server
	body   map[string]string
	keys   []string
}

func newLoginFixture(t *testing.T, answer func(w http.ResponseWriter)) *loginFixture {
	t.Helper()
	f := &loginFixture{}
	f.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/Account/login" || r.Method != http.MethodPost {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		f.keys = append(f.keys, r.Header.Get("x-api-key"))
		_ = json.NewDecoder(r.Body).Decode(&f.body)
		answer(w)
	}))
	t.Cleanup(f.server.Close)
	return f
}

func (f *loginFixture) adapter() *Server {
	return New(provider.Config{URL: f.server.URL, APIKey: "server-api-key", Transport: provider.Transport{Client: f.server.Client()}})
}

func TestVerifyLoginSuccess(t *testing.T) {
	f := newLoginFixture(t, func(w http.ResponseWriter) {
		_, _ = w.Write([]byte(`{"id":7,"username":"alice","token":"jwt","refreshToken":"r"}`))
	})
	login, err := f.adapter().VerifyLogin(t.Context(), "alice", "correct horse")
	if err != nil {
		t.Fatal(err)
	}
	if login.ID != "7" || login.Name != "alice" || f.body["username"] != "alice" || f.body["password"] != "correct horse" {
		t.Fatal("login", login, f.body)
	}
}

func TestVerifyLoginWrongPassword(t *testing.T) {
	f := newLoginFixture(t, func(w http.ResponseWriter) { w.WriteHeader(http.StatusUnauthorized) })
	if _, err := f.adapter().VerifyLogin(t.Context(), "alice", "wrong"); !errors.Is(err, provider.ErrInvalidLogin) {
		t.Fatal(err)
	}
}

func TestVerifyLoginMissingID(t *testing.T) {
	for _, body := range []string{`{"id":0,"username":"alice"}`, `{"username":"alice"}`, `{"id":-3,"username":"a"}`, `{"id":"7","username":"a"}`} {
		f := newLoginFixture(t, func(w http.ResponseWriter) { _, _ = w.Write([]byte(body)) })
		if _, err := f.adapter().VerifyLogin(t.Context(), "alice", "pw"); err == nil {
			t.Fatal("accepted a login without a valid user ID", body)
		}
	}
}

func TestVerifyLoginDoesNotSendAPIKey(t *testing.T) {
	f := newLoginFixture(t, func(w http.ResponseWriter) { _, _ = w.Write([]byte(`{"id":7,"username":"alice"}`)) })
	if _, err := f.adapter().VerifyLogin(t.Context(), "alice", "pw"); err != nil {
		t.Fatal(err)
	}
	if f.keys[0] != "" || f.body["apiKey"] != "" {
		t.Fatal("the server API key was sent with a user's login", f.keys, f.body)
	}
}
