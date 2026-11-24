package tofa

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"app/server/providers/provider"
)

func TestUsersRequireCompleteAuthorizedSnapshot(t *testing.T) {
	body := `[ {"id":"01234567-89ab-4cde-8fab-0123456789ab","username":"Alice","disabled":false,"preferences":{}}, {"id":"11234567-89ab-4cde-8fab-0123456789ab","username":"Bob","disabled":true,"preferences":{}} ]`
	status := http.StatusOK
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/proxy/api/v1/users" || r.Header.Get("Authorization") != "Bearer fixture-key" {
			t.Errorf("unexpected request")
		}
		w.WriteHeader(status)
		fmt.Fprint(w, body)
	}))
	defer srv.Close()
	s := New(provider.Config{URL: srv.URL + "/proxy", APIKey: "fixture-key", Transport: provider.Transport{Client: srv.Client()}})
	users, err := s.Users(context.Background())
	if err != nil || len(users) != 2 || users[0].Name != "Alice" || !users[0].Active || users[1].Active {
		t.Fatal(users, err)
	}
	for _, invalid := range []string{`null`, `{}`, `[{"id":"x","username":"A","preferences":{}}]`, `[{"id":"x","username":"A","disabled":false,"preferences":{}}]`, `[{"id":"01234567-89ab-4cde-8fab-0123456789ab","username":"A","disabled":false,"preferences":{}},{"id":"01234567-89ab-4cde-8fab-0123456789ab","username":"B","disabled":false,"preferences":{}}]`} {
		body = invalid
		if _, err = s.Users(context.Background()); err == nil {
			t.Fatalf("accepted invalid snapshot %s", invalid)
		}
	}
	status = http.StatusForbidden
	body = `[]`
	if _, err = s.Users(context.Background()); err == nil {
		t.Fatal("accepted forbidden response")
	}
}

func TestConnectionRequiresAdminUserRead(t *testing.T) {
	allow := false
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer fixture-key" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		switch r.URL.Path {
		case "/api/v1/system/info":
			fmt.Fprint(w, `{"version":"0.14.0"}`)
		case "/api/v1/users":
			if !allow {
				w.WriteHeader(http.StatusForbidden)
				return
			}
			fmt.Fprint(w, `[]`)
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()
	s := New(provider.Config{URL: srv.URL, APIKey: "fixture-key", Transport: provider.Transport{Client: srv.Client()}})
	if info, err := s.Health(context.Background()); err != nil || info.Version != "0.14.0" {
		t.Fatal("health should not require the user list", info, err)
	}
	if _, err := s.Test(context.Background()); err == nil {
		t.Fatal("accepted credential without user-list authority")
	}
	allow = true
	info, err := s.Test(context.Background())
	if err != nil || info.Version != "0.14.0" {
		t.Fatal(info, err)
	}
}
