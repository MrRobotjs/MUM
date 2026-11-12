package main

import (
	"app/server/providers/romm"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

type rommProvisionFixture struct {
	server                                      *httptest.Server
	mu                                          sync.Mutex
	beforePolicy                                func()
	mode                                        string
	created, enabled                            bool
	overrides                                   []romm.Override
	creates, forms, passwords, permissionWrites int
	policyReads                                 int
	lastPassword                                string
	hidden                                      []romm.Hidden
	age                                         *int
}

func newRomMProvisionFixture(t *testing.T, mode string) *rommProvisionFixture {
	t.Helper()
	f := &rommProvisionFixture{mode: mode, hidden: []romm.Hidden{}}
	f.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		if r.Header.Get("Authorization") != "Bearer fixture-secret" || r.URL.RawQuery != "" {
			t.Error("unsafe authentication/query")
			http.Error(w, "bad", 401)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		user := func() map[string]any {
			u := map[string]any{"id": 2, "username": "reader", "role": "user", "enabled": f.enabled, "permission_group_id": nil, "has_password": true, "email_managed_by_oidc": false}
			switch f.mode {
			case "admin":
				u["role"] = "admin"
			case "renamed":
				u["username"] = "other-reader"
			case "oidc":
				u["email_managed_by_oidc"] = true
			case "no-password":
				u["has_password"] = false
			case "missing-auth":
				delete(u, "email_managed_by_oidc")
			}
			return u
		}
		switch r.Method + " " + r.URL.Path {
		case "GET /proxy/api/platforms":
			json.NewEncoder(w).Encode([]any{map[string]any{"id": 7, "name": "NES"}})
		case "GET /proxy/api/users":
			if f.mode == "null-users" {
				json.NewEncoder(w).Encode(nil)
				return
			}
			rows := []any{}
			if f.created && f.mode != "absent" {
				rows = append(rows, user())
			}
			json.NewEncoder(w).Encode(rows)
		case "GET /proxy/api/permissions/catalog":
			entities := romm.PermissionEntities
			if f.mode == "catalog" {
				entities = []string{"unknown"}
			}
			json.NewEncoder(w).Encode(map[string]any{"entities": entities, "actions": romm.PermissionActions, "ownable_entities": romm.OwnableEntities})
		case "GET /proxy/api/permissions/groups":
			hidden := []romm.Hidden{}
			if f.mode == "restricted-default" {
				id := int64(7)
				hidden = []romm.Hidden{{Entity: "platforms", ID: &id}}
			}
			// Include a dangerous inherited write grant to prove the full override mask
			// removes unrelated rights before the recipient password can be used.
			json.NewEncoder(w).Encode([]any{map[string]any{"id": 1, "is_default": true, "grants": []any{map[string]any{"entity": "roms", "action": "read", "own_only": false}, map[string]any{"entity": "roms", "action": "write", "own_only": false}}, "hidden": hidden, "age_limit": nil, "hide_unrated_roms": false}})
		case "GET /proxy/api/permissions/users/2":
			if f.beforePolicy != nil {
				f.beforePolicy()
			}
			f.policyReads++
			hidden := f.hidden
			if f.mode == "late-policy" && f.policyReads == 2 {
				id := int64(7)
				hidden = []romm.Hidden{{Entity: "users", ID: &id}}
			}
			ovs := f.overrides
			if ovs == nil {
				ovs = []romm.Override{}
			}
			json.NewEncoder(w).Encode(map[string]any{"user_id": 2, "permission_group_id": nil, "overrides": ovs, "hidden": hidden, "age_limit": f.age, "hide_unrated_roms": nil})
		case "POST /proxy/api/users":
			var body map[string]string
			if json.NewDecoder(r.Body).Decode(&body) != nil || len(body) != 4 || body["username"] != "reader" || body["email"] != "" || body["role"] != "user" || len(body["password"]) < 32 || len(body["password"]) > 72 || body["password"] == "recipient-password" {
				t.Error("unsafe create")
			}
			f.created = true
			f.enabled = true
			f.creates++
			if f.mode == "create" {
				http.Error(w, "private-upstream-secret", 503)
				return
			}
			w.WriteHeader(201)
			json.NewEncoder(w).Encode(user())
		case "PUT /proxy/api/users/2":
			if r.Header.Get("Content-Type") != "application/x-www-form-urlencoded" {
				t.Error("RomM user update requires form encoding")
			}
			if r.ParseForm() != nil || len(r.PostForm) != 1 {
				t.Error("unexpected form fields")
			}
			f.forms++
			if value := r.PostForm.Get("enabled"); value != "" {
				if value != "true" && value != "false" {
					t.Error("invalid enabled value")
				}
				f.enabled = value == "true"
				if f.mode == "enable" && f.enabled || f.mode == "disable" && !f.enabled {
					http.Error(w, "private-upstream-secret", 503)
					return
				}
			} else if pw := r.PostForm.Get("password"); pw != "" {
				if f.enabled || !romm.OverridesMatch(f.overrides, false) {
					t.Error("password was written before verified restriction")
				}
				f.passwords++
				f.lastPassword = pw
				if f.mode == "password" {
					http.Error(w, "private-upstream-secret", 503)
					return
				}
			} else {
				t.Error("unknown form")
			}
			json.NewEncoder(w).Encode(user())
		case "PUT /proxy/api/permissions/users/2":
			var body struct {
				Overrides []romm.Override `json:"overrides"`
			}
			if json.NewDecoder(r.Body).Decode(&body) != nil || len(body.Overrides) != 36 || f.enabled {
				t.Error("unsafe permission mutation")
			}
			f.permissionWrites++
			f.overrides = body.Overrides
			if f.mode == "permissions" {
				http.Error(w, "private-upstream-secret", 503)
				return
			}
			if f.mode == "mismatch" && f.permissionWrites == 2 {
				f.overrides[0].Granted = nil
			}
			json.NewEncoder(w).Encode(map[string]any{})
		default:
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(f.server.Close)
	return f
}
func rommTestProvider(t *testing.T, f *rommProvisionFixture) *serverConnection {
	t.Helper()
	p, err := newServerConnection(ProviderConfig{"romm", f.server.URL + "/proxy", "fixture-secret"}, f.server.Client())
	if err != nil {
		t.Fatal(err)
	}
	return p
}
func TestRomMProvisionAdapter(t *testing.T) {
	f := newRomMProvisionFixture(t, "")
	p := rommTestProvider(t, f)
	stages := []string{}
	if err := p.provisionUser(t.Context(), "reader", "recipient-password", InvitationGrant{AllLibraries: true, LibraryIDs: []string{}, AllowDownloads: true}, func(stage, id string) error {
		stages = append(stages, stage)
		if stage != "creating" && id != "2" {
			t.Error("checkpoint lost recorded ID")
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	user, err := p.inspectProvisionedUser(t.Context(), "2", "reader")
	if err != nil {
		t.Fatal(err)
	}
	if !romm.WriteMatches(user, true, true, rommObserved(user)) || f.creates != 1 || f.passwords != 1 || f.permissionWrites != 2 || f.lastPassword != "recipient-password" || stages[len(stages)-1] != "remote_completed" {
		t.Fatal("incorrect provisioned outcome", stages)
	}
	if !supportsProvisioning("romm") || !supportsRecordedRecovery("romm") {
		t.Fatal("integrated adapter capabilities missing")
	}
}
func TestRomMProvisionFailuresDoNotReplay(t *testing.T) {
	for _, mode := range []string{"catalog", "restricted-default", "create", "admin", "renamed", "oidc", "no-password", "missing-auth", "disable", "permissions", "password", "enable", "mismatch", "late-policy"} {
		t.Run(mode, func(t *testing.T) {
			f := newRomMProvisionFixture(t, mode)
			p := rommTestProvider(t, f)
			last, recorded := "", ""
			err := p.provisionUser(t.Context(), "reader", "recipient-password", InvitationGrant{AllLibraries: true, AllowDownloads: true}, func(stage, id string) error { last = stage; recorded = id; return nil })
			if err == nil || strings.Contains(err.Error(), "private-upstream-secret") || last == "remote_completed" {
				t.Fatal(err, last)
			}
			if f.creates > 1 || f.passwords > 1 {
				t.Fatal("uncertain write replayed")
			}
			if mode == "catalog" || mode == "restricted-default" {
				if f.creates != 0 || last != "" {
					t.Fatal("failed preflight created a user")
				}
			} else if mode == "create" {
				if recorded != "" {
					t.Fatal("unknown create adopted a user")
				}
			} else if recorded != "2" {
				t.Fatal("known identity not checkpointed")
			}
		})
	}
}
func TestRomMProvisionRejectsUnsupportedInputsBeforeRequests(t *testing.T) {
	for _, tc := range []struct {
		name, password string
		grant          InvitationGrant
	}{
		{"reader", "recipient-password", InvitationGrant{LibraryIDs: []string{"7"}, AllowDownloads: true}},
		{"reader", "recipient-password", InvitationGrant{AllLibraries: true}},
		{"Reader", "recipient-password", InvitationGrant{AllLibraries: true, AllowDownloads: true}},
		{"r@e", "recipient-password", InvitationGrant{AllLibraries: true, AllowDownloads: true}},
		{"reader", strings.Repeat("a", 73), InvitationGrant{AllLibraries: true, AllowDownloads: true}},
		{"reader", "password-é-extra", InvitationGrant{AllLibraries: true, AllowDownloads: true}},
	} {
		t.Run(tc.name+tc.password, func(t *testing.T) {
			p := &serverConnection{config: ProviderConfig{Type: "romm"}}
			if err := p.provisionUser(t.Context(), tc.name, tc.password, tc.grant, func(string, string) error { t.Fatal("invalid input checkpointed"); return nil }); err == nil {
				t.Fatal("unsupported input accepted")
			}
		})
	}
	if !romm.ValidCredentials("reader_1-", strings.Repeat("a", 72)) || romm.ValidCredentials("ab", "recipient-password") {
		t.Fatal("credential boundaries")
	}
}
func TestRomMConfigurePreservesContentAndIdentity(t *testing.T) {
	f := newRomMProvisionFixture(t, "")
	f.created = true
	f.enabled = true
	age := 12
	f.age = &age
	id := int64(19)
	f.hidden = []romm.Hidden{{Entity: "roms", ID: &id}}
	p := rommTestProvider(t, f)
	user, err := p.inspectProvisionedUser(t.Context(), "2", "reader")
	if err != nil {
		t.Fatal(err)
	}
	if err := p.resumeRecordedUser(t.Context(), resumeTarget{Step: redemptionStep{RemoteID: user.ID, RemoteName: user.Name}, Grant: InvitationGrant{AllLibraries: true, AllowDownloads: true}, Password: "new+remote&password=with%spaces "}, func(string) error { return nil }); err != nil {
		t.Fatal(err)
	}
	if f.lastPassword != "new+remote&password=with%spaces " {
		t.Fatal("form encoding changed password bytes")
	}
	after, err := p.inspectProvisionedUser(t.Context(), "2", "reader")
	if err != nil || !romm.ContentEqual(rommObserved(after), rommObserved(user)) || f.creates != 0 {
		t.Fatal("content/identity lost", err)
	}
	if err := p.disableProvisionedUser(t.Context(), after); err != nil {
		t.Fatal(err)
	}
	disabled, err := p.inspectProvisionedUser(t.Context(), "2", "reader")
	if err != nil || !disabled.Disabled || !romm.ContentEqual(rommObserved(disabled), rommObserved(user)) {
		t.Fatal(err)
	}
}
func TestRomMCheckpointFailureStopsRemoteEffects(t *testing.T) {
	for _, stop := range []string{"creating", "setting_password", "enabling", "remote_completed"} {
		t.Run(stop, func(t *testing.T) {
			f := newRomMProvisionFixture(t, "")
			p := rommTestProvider(t, f)
			sentinel := errors.New("authority changed")
			err := p.provisionUser(t.Context(), "reader", "recipient-password", InvitationGrant{AllLibraries: true, AllowDownloads: true}, func(stage, id string) error {
				if stage == stop {
					return sentinel
				}
				return nil
			})
			if !errors.Is(err, sentinel) {
				t.Fatal(err)
			}
			if stop == "creating" && f.creates != 0 || stop == "setting_password" && f.passwords != 0 || stop == "enabling" && f.enabled {
				t.Fatal("side effect after rejected checkpoint")
			}
		})
	}
}

func TestRomMRecordedIdentityAndAbsence(t *testing.T) {
	for _, mode := range []string{"absent", "null-users", "catalog", "admin", "renamed", "oidc", "missing-auth"} {
		t.Run(mode, func(t *testing.T) {
			f := newRomMProvisionFixture(t, mode)
			f.created = true
			p := rommTestProvider(t, f)
			observed, err := p.inspectProvisionedUser(t.Context(), "2", "reader")
			if mode == "absent" {
				if err != nil || !observed.Absent {
					t.Fatal("complete absence not recognized", err)
				}
			} else if err == nil {
				t.Fatal("unsafe recorded identity accepted")
			}
			if f.forms != 0 || f.creates != 0 || f.permissionWrites != 0 {
				t.Fatal("inspection mutated remote state")
			}
		})
	}
}
func TestRomMExistingNameAndCancellationDoNotCreate(t *testing.T) {
	f := newRomMProvisionFixture(t, "")
	f.created = true
	p := rommTestProvider(t, f)
	grant := InvitationGrant{AllLibraries: true, AllowDownloads: true}
	if err := p.provisionUser(t.Context(), "reader", "recipient-password", grant, func(string, string) error { t.Fatal("existing name was adopted"); return nil }); err == nil {
		t.Fatal("existing name accepted")
	}
	f.created = false
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if err := p.provisionUser(ctx, "reader", "recipient-password", grant, func(string, string) error { t.Fatal("canceled work checkpointed"); return nil }); err == nil {
		t.Fatal("canceled work accepted")
	}
	if f.creates != 0 || f.forms != 0 {
		t.Fatal("existing/canceled work caused writes")
	}
}

// rommObserved returns the RomM module's observed state of an inspected account.
func rommObserved(u remoteReview) *romm.Observed {
	o, _ := u.Detail.(*romm.Observed)
	return o
}
