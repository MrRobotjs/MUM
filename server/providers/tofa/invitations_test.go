package tofa

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"app/server/providers/provider"
)

func TestOnboardingInviteCreateAndInspect(t *testing.T) {
	id := "11234567-89ab-4cde-8fab-0123456789ab"
	lib := "21234567-89ab-4cde-8fab-0123456789ab"
	state, calls := "queued", 0
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if r.Header.Get("Authorization") != "Bearer fixture" {
			t.Fatal("missing authorization")
		}
		if r.Method == http.MethodPost && r.URL.Path == "/api/v1/onboarding/invites" {
			var body map[string]any
			if json.NewDecoder(r.Body).Decode(&body) != nil || body["idempotency_key"] != "stable-key" || body["email"] != "a@example.test" || body["unrestricted_libraries"] != false || len(body["library_ids"].([]any)) != 1 {
				t.Fatal("invalid invite request", body)
			}
		} else if r.Method == http.MethodPost && r.URL.Path == "/api/v1/onboarding/invites/"+id+"/revoke" {
			state = "revoked"
		} else if r.Method != http.MethodGet || r.URL.Path != "/api/v1/onboarding/invites/"+id {
			t.Fatal("unexpected request", r.Method, r.URL.Path)
		}
		fmt.Fprintf(w, `{"id":%q,"email":"a@example.test","state":%q}`, id, state)
	}))
	defer up.Close()
	s := New(provider.Config{URL: up.URL, APIKey: "fixture", Transport: provider.Transport{Client: up.Client()}})
	invite, err := s.CreateOnboardingInvite(context.Background(), "stable-key", "a@example.test", false, []string{lib})
	if err != nil || invite.ID != id || invite.State != "queued" {
		t.Fatal(invite, err)
	}
	state = "joined"
	invite, err = s.InspectOnboardingInvite(context.Background(), id)
	if err != nil || invite.State != "joined" {
		t.Fatal(invite, err)
	}
	state = "unknown"
	if _, err = s.InspectOnboardingInvite(context.Background(), id); err == nil {
		t.Fatal("accepted unknown state")
	}
	invite, err = s.RevokeOnboardingInvite(context.Background(), id)
	if err != nil || invite.State != "revoked" {
		t.Fatal(invite, err)
	}
	before := calls
	if _, err = s.CreateOnboardingInvite(context.Background(), "stable-key", "a@example.test", false, []string{"../bad"}); err == nil || before != calls {
		t.Fatal("accepted invalid grant")
	}
}

func TestOnboardingInviteDoesNotReplayOrAcceptMalformedReply(t *testing.T) {
	calls := 0
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"id":"11234567-89ab-4cde-8fab-0123456789ab","email":"a@example.test","state":"queued","state":"joined"}`)
	}))
	defer up.Close()
	s := New(provider.Config{URL: up.URL, APIKey: "fixture", Transport: provider.Transport{Client: up.Client()}})
	_, err := s.CreateOnboardingInvite(context.Background(), "stable-key", "a@example.test", true, nil)
	if err == nil || calls != 1 {
		t.Fatal("accepted malformed response or retried", calls, err)
	}
}

func TestOnboardingInvitePreservesFailureAndDoesNotLeakProviderBody(t *testing.T) {
	calls := 0
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		w.WriteHeader(http.StatusForbidden)
		fmt.Fprint(w, "private provider body")
	}))
	defer up.Close()
	s := New(provider.Config{URL: up.URL, APIKey: "fixture", Transport: provider.Transport{Client: up.Client()}})
	_, err := s.CreateOnboardingInvite(context.Background(), "stable-key", "a@example.test", true, nil)
	var status *provider.HTTPError
	if calls != 1 || !errors.As(err, &status) || status.StatusCode != http.StatusForbidden || strings.Contains(err.Error(), "private") {
		t.Fatal(calls, err)
	}
}
