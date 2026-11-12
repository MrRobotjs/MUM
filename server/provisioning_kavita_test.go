package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"
)

type kavitaProvisionFixture struct {
	server                          *httptest.Server
	mu                              sync.Mutex
	mode, name                      string
	invites, confirmations, updates int
	confirmed                       bool
	age                             kavitaAgeRestriction
	resets                          int
	lastPassword                    string
	absent                          bool
	beforeInspect                   func()
	roles                           []string
	libraries                       []int64
}

func newKavitaProvisionFixture(t *testing.T, mode string) *kavitaProvisionFixture {
	f := &kavitaProvisionFixture{mode: mode}
	f.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("x-api-key") != "fixture-secret" {
			t.Error("Kavita auth header missing")
			http.Error(w, "unauthorized", 401)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		f.mu.Lock()
		hook := f.beforeInspect
		f.mu.Unlock()
		if r.URL.Path == "/api/Users" && r.URL.Query().Get("includePending") == "true" && hook != nil {
			hook()
		}
		f.mu.Lock()
		defer f.mu.Unlock()
		switch r.Method + " " + r.URL.Path {
		case "GET /api/Library/libraries":
			fmt.Fprint(w, `[{"id":2,"name":"Books","type":2}]`)
		case "GET /api/Users":
			if !f.confirmed || f.absent {
				fmt.Fprint(w, `[]`)
				return
			}
			if f.mode == "null_members" {
				fmt.Fprint(w, `null`)
				return
			}
			roles := slices.Clone(f.roles)
			if f.mode == "unsafe_roles" {
				roles = append(roles, "Admin")
			}
			identity := 0
			if f.mode == "oidc" {
				identity = 1
			}
			libraries := []map[string]int64{}
			for _, id := range f.libraries {
				libraries = append(libraries, map[string]int64{"id": id})
			}
			if f.mode == "broken_users" {
				http.NotFound(w, r)
				return
			}
			row := map[string]any{"id": 17, "username": f.name, "isPending": f.mode == "pending", "identityProvider": identity, "roles": roles, "libraries": libraries, "ageRestriction": f.age}
			if f.mode == "wrong_name" {
				row["username"] = "OtherUser"
			}
			if f.mode == "missing_age" {
				delete(row, "ageRestriction")
			}
			rows := []map[string]any{row}
			if f.mode == "duplicate" {
				rows = append(rows, row)
			}
			_ = json.NewEncoder(w).Encode(rows)
		case "POST /api/Account/invite":
			var body struct {
				Email          string
				Roles          []string
				Libraries      []int64
				AgeRestriction kavitaAgeRestriction
			}
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Error(err)
			}
			if strings.Contains(body.Email, "@") || slices.Contains(body.Roles, "Admin") || slices.Contains(body.Roles, "Login") || slices.Contains(body.Roles, "Pleb") || body.AgeRestriction.AgeRating != -1 || !body.AgeRestriction.IncludeUnknowns {
				t.Error("unsafe invite payload", body)
			}
			f.age = body.AgeRestriction
			f.invites++
			f.name = body.Email
			f.roles = append(slices.Clone(body.Roles), "Pleb")
			f.libraries = body.Libraries
			if f.mode == "invite" {
				http.Error(w, "private upstream token", 503)
				return
			}
			email := body.Email
			if f.mode == "bad_link" {
				email = "OtherUser"
			}
			// An unrelated host must never receive any follow-up HTTP request.
			_ = json.NewEncoder(w).Encode(map[string]any{"emailLink": "https://must-not-contact.invalid/registration/confirm-email?token=confirmation-secret&email=" + email, "emailSent": false})
		case "POST /api/Account/confirm-email":
			var body struct{ Email, Username, Password, Token string }
			_ = json.NewDecoder(r.Body).Decode(&body)
			if body.Email != f.name || body.Username != f.name || body.Token != "confirmation-secret" || body.Password != invitationPassword {
				t.Error("invalid confirmation")
			}
			f.confirmations++
			f.confirmed = true
			if f.mode == "confirm" {
				http.Error(w, "uncertain confirmation", 503)
				return
			}
			name := f.name
			if f.mode == "wrong_identity" {
				name = "OtherUser"
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"id": 17, "username": name, "token": "private-session-token", "refreshToken": "private-refresh-token", "apiKey": "private-user-key"})
		case "POST /api/Account/update":
			var body struct {
				UserID           int64
				Username         string
				Roles            []string
				Libraries        []int64
				IdentityProvider int
				AgeRestriction   kavitaAgeRestriction
			}
			_ = json.NewDecoder(r.Body).Decode(&body)
			if body.UserID != 17 || body.Username != f.name || body.IdentityProvider != 0 || slices.Contains(body.Roles, "Pleb") || slices.Contains(body.Roles, "Admin") {
				t.Error("unsafe enable", body)
			}
			if body.AgeRestriction != f.age {
				t.Error("age restriction changed")
			}
			f.updates++
			if f.mode != "ignored_enable" || !slices.Contains(body.Roles, "Login") {
				f.roles = append(slices.Clone(body.Roles), "Pleb")
				f.libraries = body.Libraries
			}
			if f.mode == "enable" && slices.Contains(body.Roles, "Login") || f.mode == "disable" && !slices.Contains(body.Roles, "Login") {
				http.Error(w, "uncertain enable", 503)
				return
			}
			w.WriteHeader(204)
		case "POST /api/Account/reset-password":
			var body struct{ UserName, Password string }
			_ = json.NewDecoder(r.Body).Decode(&body)
			if body.UserName != f.name || len(body.Password) < 12 || len(body.Password) > 256 || slices.Contains(f.roles, "Login") {
				t.Error("unsafe password reset")
			}
			f.resets++
			f.lastPassword = body.Password
			if f.mode == "reset" {
				http.Error(w, "uncertain password reset", 503)
				return
			}
			w.WriteHeader(204)
		default:
			t.Error("unexpected Kavita request", r.Method, r.URL.String())
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(f.server.Close)
	return f
}

func kavitaInvitation(t *testing.T, a *App, admin string, f *kavitaProvisionFixture, downloads bool) (string, int64) {
	t.Helper()
	id := createManagedServer(t, a, admin, "kavita", f.server.URL)
	if w := apiRequest(a, "POST", fmt.Sprintf("/api/servers/%d/sync", id), admin, nil, nil); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	w := apiRequest(a, "POST", "/api/invitations", admin, map[string]any{"expires_at": time.Now().Add(time.Hour).UTC().Format(time.RFC3339Nano), "max_uses": 1, "grants": []InvitationGrant{{ServerID: id, LibraryIDs: []string{"2"}, AllowDownloads: downloads}}}, nil)
	if w.Code != 201 {
		t.Fatal(w.Code, w.Body.String())
	}
	return "/api/public/invitations/" + responseData(t, w)["token"].(string) + "/redeem", id
}

func TestKavitaProvisioningVerifiesIdentityLibrariesAndExactRoles(t *testing.T) {
	for _, downloads := range []bool{false, true} {
		t.Run(fmt.Sprint(downloads), func(t *testing.T) {
			a, s := testApp(t)
			admin, _ := bootstrapOwner(t, a)
			f := newKavitaProvisionFixture(t, "")
			path, id := kavitaInvitation(t, a, admin, f, downloads)
			body := redeemBody("KavitaReader", newUUID())
			body["email"] = "local-only@example.invalid"
			w := apiRequest(a, "POST", path, "", body, nil)
			if w.Code != 201 || responseData(t, w)["status"] != "completed" {
				t.Fatal(w.Code, w.Body.String())
			}
			for _, secret := range []string{"confirmation-secret", "private-session-token", "private-refresh-token", "private-user-key", "fixture-secret"} {
				if strings.Contains(w.Body.String(), secret) {
					t.Fatal("public secret leak")
				}
			}
			var remote string
			var active bool
			if err := s.reader.QueryRow("SELECT external_user_id,is_active FROM service_accounts WHERE server_id=?", id).Scan(&remote, &active); err != nil || remote != "17" || !active {
				t.Fatal(remote, active, err)
			}
			if w := apiRequest(a, "POST", path, "", body, nil); w.Code != 200 {
				t.Fatal(w.Code)
			}
			f.mu.Lock()
			invites, confirmations, updates := f.invites, f.confirmations, f.updates
			f.mu.Unlock()
			if invites != 1 || confirmations != 1 || updates != 1 {
				t.Fatal("mutation replay", invites, confirmations, updates)
			}
		})
	}
}

func TestKavitaUncertainOrUnsafeOutcomesRetainCapacityWithoutReplay(t *testing.T) {
	for _, mode := range []string{"invite", "confirm", "enable", "bad_link", "unsafe_roles", "wrong_identity", "oidc", "null_members", "ignored_enable"} {
		t.Run(mode, func(t *testing.T) {
			a, _ := testApp(t)
			admin, _ := bootstrapOwner(t, a)
			f := newKavitaProvisionFixture(t, mode)
			path, _ := kavitaInvitation(t, a, admin, f, false)
			body := redeemBody("FailedReader", newUUID())
			w := apiRequest(a, "POST", path, "", body, nil)
			if w.Code != 201 || responseData(t, w)["status"] != "failed" {
				t.Fatal(w.Code, w.Body.String())
			}
			job := currentReview(t, a, responseData(t, w)["id"].(string))
			if !job.Reserved {
				t.Fatal("failed job released capacity")
			}
			private := apiRequest(a, "GET", "/api/provisioning-jobs/"+job.ID, admin, nil, nil)
			if job.Steps[0].RemoteID == "" && responseData(t, private)["resume_available"] != false {
				t.Fatal("unsupported resumption advertised")
			}
			if w := apiRequest(a, "POST", path, "", body, nil); w.Code != 200 {
				t.Fatal(w.Code)
			}
			f.mu.Lock()
			invites := f.invites
			f.mu.Unlock()
			if invites != 1 {
				t.Fatal("uncertain invite replayed")
			}
		})
	}
}

func TestKavitaCredentialAndGrantLimitsFailBeforeReservation(t *testing.T) {
	a, s := testApp(t)
	admin, _ := bootstrapOwner(t, a)
	f := newKavitaProvisionFixture(t, "")
	path, id := kavitaInvitation(t, a, admin, f, false)
	for _, body := range []map[string]any{redeemBody("email@example.invalid", newUUID()), {"request_id": newUUID(), "username": "LongPassword", "password": strings.Repeat("x", 257)}} {
		if w := apiRequest(a, "POST", path, "", body, nil); w.Code != 400 {
			t.Fatal(w.Code, w.Body.String())
		}
	}
	var jobs int
	if err := s.reader.QueryRow("SELECT count(*) FROM provisioning_jobs").Scan(&jobs); err != nil || jobs != 0 {
		t.Fatal(jobs, err)
	}
	w := apiRequest(a, "POST", "/api/invitations", admin, map[string]any{"expires_at": time.Now().Add(time.Hour).UTC().Format(time.RFC3339Nano), "max_uses": 1, "grants": []InvitationGrant{{ServerID: id, AllLibraries: true}}}, nil)
	if w.Code != 409 {
		t.Fatal("dynamic all-libraries grant accepted", w.Code)
	}
}

func TestKavitaSyncRespectsLoginRoleAndExternalCancellation(t *testing.T) {
	a, s := testApp(t)
	admin, _ := bootstrapOwner(t, a)
	f := newKavitaProvisionFixture(t, "enable")
	path, id := kavitaInvitation(t, a, admin, f, false)
	w := apiRequest(a, "POST", path, "", redeemBody("ManualReader", newUUID()), nil)
	if w.Code != 201 {
		t.Fatal(w.Code, w.Body.String())
	}
	job := currentReview(t, a, responseData(t, w)["id"].(string))
	f.mu.Lock()
	f.roles = []string{"Pleb", "Change Password"}
	f.mu.Unlock()
	provider, err := newMediaProvider(ProviderConfig{"kavita", f.server.URL, "fixture-secret"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	users, err := provider.Users(t.Context())
	if err != nil || len(users) != 1 || users[0].Active {
		t.Fatal("role-disabled user marked active", users, err)
	}
	body := reviewBody(job)
	_ = id // cancellation now verifies the recorded disabled identity directly
	w = apiRequest(a, "POST", "/api/provisioning-jobs/"+job.ID+"/cancel", admin, body, nil)
	if w.Code != 200 || responseData(t, w)["status"] != "cancelled" {
		t.Fatal(w.Code, w.Body.String())
	}
	var uses int
	if err := s.reader.QueryRow("SELECT current_uses FROM invites WHERE id=?", job.InviteID).Scan(&uses); err != nil || uses != 0 {
		t.Fatal(uses, err)
	}
}
