package main

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

func rommLabelFixture(t *testing.T) (*App, *Store, string, int64, *rommPermissionFixture) {
	t.Helper()
	f := newRomMPermissionFixture(t, "")
	a, s := testApp(t)
	a.ProviderHTTP = f.server.Client()
	token, _ := bootstrapOwner(t, a)
	id := createManagedServer(t, a, token, "romm", f.server.URL+"/proxy")
	return a, s, token, id, f
}
func syncRomMLabel(t *testing.T, a *App, token string, id int64, want int) {
	t.Helper()
	w := apiRequest(a, "POST", fmt.Sprintf("/api/servers/%d/sync", id), token, nil, nil)
	if w.Code != want {
		t.Fatal(w.Code, w.Body.String())
	}
}
func rommLabelSource(t *testing.T, s *Store, id int64) (string, string, bool, int64) {
	t.Helper()
	var service, role string
	var allowed bool
	var revision int64
	if err := s.reader.QueryRow(`SELECT o.service_uuid,o.role_id,o.allowed,o.source_revision FROM download_observations o WHERE o.server_id=?`, id).Scan(&service, &role, &allowed, &revision); err != nil {
		t.Fatal(err)
	}
	return service, role, allowed, revision
}
func rommLabelState(t *testing.T, s *Store, id int64) string {
	t.Helper()
	var value string
	if err := s.reader.QueryRow(`SELECT json_object('server',(SELECT json_array(revision,last_sync_at) FROM media_servers WHERE id=?),
 'accounts',(SELECT json_group_array(json_array(uuid,external_user_id,is_active,allow_downloads,service_settings)) FROM service_accounts WHERE server_id=?),
 'observations',(SELECT json_group_array(json_array(service_uuid,server_id,external_user_id,role_id,allowed,source_revision,observed_at)) FROM download_observations WHERE server_id=?),
 'members',(SELECT json_group_array(json_array(user_uuid,role_id)) FROM identity_user_roles),
 'audit',(SELECT count(*) FROM audit_events))`, id, id, id).Scan(&value); err != nil {
		t.Fatal(err)
	}
	return value
}

func TestRomMDownloadLabelsKnownLifecycleAndManualHumanProtection(t *testing.T) {
	a, s, token, id, f := rommLabelFixture(t)
	owner, _ := s.Authenticate(t.Context(), token)
	manual, err := s.CreateAccount(t.Context(), owner.UUID, "label-human", "fixture-hash", false)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.writer.Exec("INSERT INTO user_roles(id,name) VALUES('manual-label','Friend')"); err != nil {
		t.Fatal(err)
	}
	syncRomMLabel(t, a, token, id, 200)
	service, role, allowed, source := rommLabelSource(t, s, id)
	if !allowed {
		t.Fatal("known grant not observed")
	}
	if _, err = s.writer.Exec("INSERT INTO identity_user_roles VALUES(?,'manual-label'),(?,'manual-label')", service, manual); err != nil {
		t.Fatal(err)
	}
	if err = s.LinkServiceAccounts(t.Context(), owner.UUID, manual, []string{service}); err != nil {
		t.Fatal(err)
	}
	var member, automatic bool
	var serverRevision, catalogRevision int64
	if err = s.reader.QueryRow("SELECT EXISTS(SELECT 1 FROM identity_user_roles WHERE user_uuid=? AND role_id=?),(SELECT is_auto_managed FROM user_roles WHERE id=?),(SELECT revision FROM media_servers WHERE id=?),(SELECT revision FROM user_role_state)", service, role, role, id).Scan(&member, &automatic, &serverRevision, &catalogRevision); err != nil || !member || !automatic || source != serverRevision {
		t.Fatal(member, automatic, source, serverRevision, err)
	}
	syncRomMLabel(t, a, token, id, 200)
	var afterRevision int64
	s.reader.QueryRow("SELECT revision FROM user_role_state").Scan(&afterRevision)
	if afterRevision != catalogRevision {
		t.Fatal("idempotent observation rewrote catalog")
	}
	f.setVariant("deny")
	syncRomMLabel(t, a, token, id, 200)
	sameService, sameRole, allowFalse, _ := rommLabelSource(t, s, id)
	if sameService != service || sameRole != role || allowFalse {
		t.Fatal("explicit denial did not retain bound observation")
	}
	if err = s.reader.QueryRow("SELECT EXISTS(SELECT 1 FROM identity_user_roles WHERE user_uuid=? AND role_id=?)", service, role).Scan(&member); err != nil || member {
		t.Fatal("observed denial did not remove owned label", err)
	}
	f.setVariant("grant")
	syncRomMLabel(t, a, token, id, 200)
	var intact bool
	if err = s.reader.QueryRow(`SELECT EXISTS(SELECT 1 FROM identity_user_roles WHERE user_uuid=? AND role_id='manual-label') AND EXISTS(SELECT 1 FROM identity_user_roles WHERE user_uuid=? AND role_id='manual-label') AND NOT EXISTS(SELECT 1 FROM identity_user_roles WHERE user_uuid=? AND role_id=?) AND EXISTS(SELECT 1 FROM service_links WHERE user_uuid=? AND service_uuid=? AND link_kind='owner') AND NOT EXISTS(SELECT 1 FROM admin_privileges WHERE user_uuid=?)`, service, manual, manual, role, manual, service, manual).Scan(&intact); err != nil || !intact {
		t.Fatal("manual labels, human ownership or privileges changed", err)
	}
	catalog := responseData(t, apiRequest(a, "GET", "/api/user-role-catalog", token, nil, nil))
	managed := catalogRole(t, catalog, role)
	if managed["can_update"] != false || managed["can_delete"] != false || catalog["can_reorder"] != false {
		t.Fatal(managed)
	}
	selector := responseData(t, apiRequest(a, "GET", "/api/user-role-catalog/"+role+"/members", token, nil, nil))
	if selector["mutations_available"] != false {
		t.Fatal(selector)
	}
	profile := responseData(t, apiRequest(a, "GET", "/api/users/"+service, token, nil, nil))
	if strings.Contains(fmt.Sprint(profile), "never-persist") {
		t.Fatal("raw provider hash persisted")
	}
}

func TestRomMDownloadLabelsPreserveUnknownFailedAbsentAndLibraryOnlyObservations(t *testing.T) {
	a, s, token, id, f := rommLabelFixture(t)
	syncRomMLabel(t, a, token, id, 200)
	service, role, _, source := rommLabelSource(t, s, id)
	for _, variant := range []string{"identity", "missing-overrides", "catalog", "policy-error", "too-many-users"} {
		t.Run(variant, func(t *testing.T) {
			before := rommLabelState(t, s, id)
			f.setVariant(variant)
			want := 409
			if variant == "policy-error" {
				want = 502
			}
			syncRomMLabel(t, a, token, id, want)
			if rommLabelState(t, s, id) != before {
				t.Fatal("failed snapshot changed labels/provenance")
			}
		})
	}
	f.setVariant("")
	f.mode.Store(2)
	before := rommLabelState(t, s, id)
	syncRomMLabel(t, a, token, id, 409)
	if rommLabelState(t, s, id) != before {
		t.Fatal("null snapshot changed labels")
	}
	f.mode.Store(0)
	for _, access := range []*ProviderUserAccess{nil, {DownloadsKnown: false, AllowDownloads: false}} {
		server, err := a.loadServer(t.Context(), id)
		if err != nil {
			t.Fatal(err)
		}
		before := rommLabelState(t, s, id)
		err = s.write(t.Context(), func(tx *sql.Tx) error {
			change, err := reconcileDownloadLabel(t.Context(), tx, server, role, service, ProviderUser{ID: "2", Access: access}, "2099-01-01T00:00:00Z")
			if change != nil {
				t.Fatal("unknown policy produced observation")
			}
			return err
		})
		if err != nil || rommLabelState(t, s, id) != before {
			t.Fatal("unknown policy modified state", err)
		}
	}
	f.setVariant("disabled")
	syncRomMLabel(t, a, token, id, 200)
	_, _, allowed, beforeLibraries := rommLabelSource(t, s, id)
	if !allowed {
		t.Fatal("inactive flag inferred a policy denial")
	}
	server, err := a.loadServer(t.Context(), id)
	if err != nil {
		t.Fatal(err)
	}
	owner, _ := s.Authenticate(t.Context(), token)
	if _, err = a.syncServer(t.Context(), owner.UUID, token, server, true, false); err != nil {
		t.Fatal(err)
	}
	_, _, _, newSource := rommLabelSource(t, s, id)
	if newSource != beforeLibraries || newSource <= source {
		t.Fatal("known observation did not advance")
	}
	var empty atomic.Bool
	proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if empty.Load() && r.URL.Path == "/proxy/api/users" {
			w.Header().Set("Content-Type", "application/json")
			fmt.Fprint(w, "[]")
			return
		}
		f.server.Config.Handler.ServeHTTP(w, r)
	}))
	defer proxy.Close()
	// Replace the disposable server URL under the writer before the next fetch.
	if _, err = s.writer.Exec("UPDATE media_servers SET url=?,revision=revision+1 WHERE id=?", proxy.URL+"/proxy", id); err != nil {
		t.Fatal(err)
	}
	a.ProviderHTTP = proxy.Client()
	empty.Store(true)
	syncRomMLabel(t, a, token, id, 200)
	_, _, allowed, lastSource := rommLabelSource(t, s, id)
	if !allowed || lastSource != newSource {
		t.Fatal("absent user erased or refreshed old policy provenance")
	}
	var retained bool
	if err = s.reader.QueryRow("SELECT is_active=0 AND EXISTS(SELECT 1 FROM identity_user_roles WHERE user_uuid=? AND role_id=?) FROM service_accounts WHERE uuid=?", service, role, service).Scan(&retained); err != nil || !retained {
		t.Fatal("absent user did not retain last observed label", err)
	}
}

func TestRomMDownloadLabelsRejectUnownedDefinitionsAndProvenance(t *testing.T) {
	for _, mode := range []string{"manual-name", "automatic-name", "capacity", "definition-drift", "untracked-member", "missing-member", "newer-source", "wrong-source", "wrong-provider", "wrong-external"} {
		t.Run(mode, func(t *testing.T) {
			a, s, token, id, _ := rommLabelFixture(t)
			if mode == "manual-name" || mode == "automatic-name" {
				if _, err := s.writer.Exec("INSERT INTO user_roles(id,name,is_auto_managed) VALUES('unowned','DOWNLOADS',?)", mode == "automatic-name"); err != nil {
					t.Fatal(err)
				}
				syncRomMLabel(t, a, token, id, 409)
				var n int
				s.reader.QueryRow("SELECT count(*) FROM download_role").Scan(&n)
				if n != 0 {
					t.Fatal("role was adopted by name")
				}
				return
			}
			if mode == "capacity" {
				if _, err := s.writer.Exec(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<1000) INSERT INTO user_roles(id,name) SELECT 'full-'||x,'Label '||x FROM n`); err != nil {
					t.Fatal(err)
				}
				syncRomMLabel(t, a, token, id, 409)
				return
			}
			syncRomMLabel(t, a, token, id, 200)
			service, role, _, _ := rommLabelSource(t, s, id)
			switch mode {
			case "definition-drift":
				if _, err := s.writer.Exec("UPDATE user_roles SET is_auto_managed=0 WHERE id=?", role); err != nil {
					t.Fatal(err)
				}
				catalog := responseData(t, apiRequest(a, "GET", "/api/user-role-catalog", token, nil, nil))
				if row := catalogRole(t, catalog, role); row["is_auto_managed"] != true || row["can_update"] != false || row["can_delete"] != false {
					t.Fatal("registry ownership was ignored", row)
				}
				members := responseData(t, apiRequest(a, "GET", "/api/user-role-catalog/"+role+"/members", token, nil, nil))
				if members["mutations_available"] != false {
					t.Fatal("drift reopened member mutation")
				}
				owner, _ := s.Authenticate(t.Context(), token)
				target, err := s.CreateAccount(t.Context(), owner.UUID, "drift-target", "fixture-hash", false)
				if err != nil {
					t.Fatal(err)
				}
				human := responseData(t, apiRequest(a, "GET", "/api/users/"+target+"/user-roles", token, nil, nil))
				if w := apiRequest(a, "PUT", "/api/users/"+target+"/user-roles", token, humanRolesBody(human, []string{role}), nil); w.Code != 403 {
					t.Fatal("registry role was assigned as manual", w.Code)
				}
			case "untracked-member":
				if _, err := s.writer.Exec("DELETE FROM download_observations WHERE service_uuid=?", service); err != nil {
					t.Fatal(err)
				}
			case "missing-member":
				if _, err := s.writer.Exec("DELETE FROM identity_user_roles WHERE user_uuid=? AND role_id=?", service, role); err != nil {
					t.Fatal(err)
				}
			case "newer-source":
				if _, err := s.writer.Exec("UPDATE download_observations SET source_revision=source_revision+100 WHERE service_uuid=?", service); err != nil {
					t.Fatal(err)
				}
			default:
				server, err := a.loadServer(t.Context(), id)
				if err != nil {
					t.Fatal(err)
				}
				account := ProviderUser{ID: "2", Access: &ProviderUserAccess{DownloadsKnown: true, AllowDownloads: false}}
				if mode == "wrong-source" {
					server.ID++
				}
				if mode == "wrong-provider" {
					server.Type = "jellyfin"
				}
				if mode == "wrong-external" {
					account.ID = "02"
				}
				before := rommLabelState(t, s, id)
				err = s.write(t.Context(), func(tx *sql.Tx) error {
					_, err := reconcileDownloadLabel(t.Context(), tx, server, role, service, account, "2099-01-01T00:00:00Z")
					return err
				})
				if err == nil || rommLabelState(t, s, id) != before {
					t.Fatal("unbound source changed state", err)
				}
				return
			}
			before := rommLabelState(t, s, id)
			syncRomMLabel(t, a, token, id, 409)
			if rommLabelState(t, s, id) != before {
				t.Fatal("unowned state was repaired/adopted")
			}
		})
	}
}

func TestManualServerSyncRequiresOriginatingSessionBeforeProviderIO(t *testing.T) {
	a, s, token, id, _ := rommLabelFixture(t)
	owner, _ := s.Authenticate(t.Context(), token)
	server, err := a.loadServer(t.Context(), id)
	if err != nil {
		t.Fatal(err)
	}
	other, err := s.CreateAccount(t.Context(), owner.UUID, "other-origin", "fixture-hash", false)
	if err != nil {
		t.Fatal(err)
	}
	session, err := s.issueSession(t.Context(), other, false)
	if err != nil {
		t.Fatal(err)
	}
	var calls atomic.Int32
	a.ProviderHTTP = &http.Client{Transport: providerTransport(func(r *http.Request) (*http.Response, error) { calls.Add(1); return http.DefaultTransport.RoundTrip(r) })}
	for _, access := range []string{"", session.Access} {
		if _, err = a.syncServer(t.Context(), owner.UUID, access, server, true, true); err == nil {
			t.Fatal("unbound session authorized sync")
		}
	}
	if _, err = s.writer.Exec("DELETE FROM app_sessions WHERE user_uuid=?", owner.UUID); err != nil {
		t.Fatal(err)
	}
	if _, err = a.syncServer(t.Context(), owner.UUID, token, server, true, true); err == nil {
		t.Fatal("revoked session authorized sync")
	}
	if calls.Load() != 0 {
		t.Fatal("unauthorized preflight dispatched provider requests", calls.Load())
	}
}

func TestRomMDownloadLabelsDefinitionEpochAndAuditRollback(t *testing.T) {
	for _, mode := range []string{"epoch-cycle", "server-revision", "permission", "logout", "bootstrap-audit", "update-audit"} {
		t.Run(mode, func(t *testing.T) {
			a, s, token, id, f := rommLabelFixture(t)
			owner, _ := s.Authenticate(t.Context(), token)
			role := ""
			if mode != "bootstrap-audit" {
				syncRomMLabel(t, a, token, id, 200)
				_, role, _, _ = rommLabelSource(t, s, id)
			}
			before := rommLabelState(t, s, id)
			want := 409
			if mode == "bootstrap-audit" || mode == "update-audit" {
				if _, err := s.writer.Exec(`CREATE TRIGGER fail_label_audit BEFORE INSERT ON audit_events WHEN NEW.action='provider.labels.reconcile' BEGIN SELECT RAISE(ABORT,'fixture'); END`); err != nil {
					t.Fatal(err)
				}
				f.setVariant("deny")
				want = 502
			} else {
				f.mu.Lock()
				f.beforePolicy = func() {
					var err error
					switch mode {
					case "epoch-cycle":
						_, err = s.writer.Exec("UPDATE user_roles SET color='#123abc' WHERE id=?", role)
						if err == nil {
							_, err = s.writer.Exec("UPDATE user_roles SET color='#808080' WHERE id=?", role)
						}
					case "server-revision":
						_, err = s.writer.Exec("UPDATE media_servers SET revision=revision+1 WHERE id=?", id)
					case "logout":
						_, err = s.writer.Exec("DELETE FROM app_sessions WHERE user_uuid=?", owner.UUID)
					case "permission":
						_, err = s.writer.Exec("UPDATE user_accounts SET access_expires_at='2000-01-01T00:00:00Z' WHERE uuid=?", owner.UUID)
					}
					if err != nil {
						t.Error(err)
					}
				}
				f.mu.Unlock()
				if mode == "permission" || mode == "logout" {
					want = 403
				}
			}
			syncRomMLabel(t, a, token, id, want)
			if mode == "bootstrap-audit" || mode == "update-audit" {
				if rommLabelState(t, s, id) != before {
					t.Fatal("audit failure did not roll back entire sync")
				}
				if mode == "bootstrap-audit" {
					var n int
					s.reader.QueryRow("SELECT count(*) FROM download_role").Scan(&n)
					if n != 0 {
						t.Fatal("bootstrap ownership survived rollback")
					}
				}
			} else {
				var count int
				s.reader.QueryRow("SELECT count(*) FROM audit_events WHERE action='provider.labels.reconcile'").Scan(&count)
				if count != 1 {
					t.Fatal("stale operation emitted successful observation")
				}
			}
		})
	}
}

func TestRomMDownloadLabelsIsolateServersAndAdvertiseOnlyKnownProducer(t *testing.T) {
	a, s, token, first, f := rommLabelFixture(t)
	syncRomMLabel(t, a, token, first, 200)
	secondFixture := newRomMPermissionFixture(t, "deny")
	w := apiRequest(a, "POST", "/api/servers", token, map[string]any{"server_nickname": "second-romm", "service_type": "romm", "url": secondFixture.server.URL + "/proxy", "api_key": "fixture-secret", "is_active": true}, nil)
	second := int64(responseData(t, w)["id"].(float64))
	a.ProviderHTTP = secondFixture.server.Client()
	syncRomMLabel(t, a, token, second, 200)
	firstService, firstRole, firstAllowed, _ := rommLabelSource(t, s, first)
	secondService, secondRole, secondAllowed, _ := rommLabelSource(t, s, second)
	if firstService == secondService || firstRole != secondRole || !firstAllowed || secondAllowed {
		t.Fatal("cross-server facts conflated")
	}
	f.setVariant("deny")
	a.ProviderHTTP = f.server.Client()
	syncRomMLabel(t, a, token, first, 200)
	secondFixture.setVariant("grant")
	a.ProviderHTTP = secondFixture.server.Client()
	syncRomMLabel(t, a, token, second, 200)
	var source string
	if err := s.reader.QueryRow("SELECT user_uuid FROM identity_user_roles WHERE role_id=?", firstRole).Scan(&source); err != nil || source != secondService {
		t.Fatal("wrong service retained managed label", source, err)
	}
	response := apiRequest(a, "GET", "/api/providers", token, nil, nil)
	var data struct {
		Data []struct {
			ID           string   `json:"id"`
			Capabilities []string `json:"capabilities"`
		} `json:"data"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &data); err != nil {
		t.Fatal(err)
	}
	for _, provider := range data.Data {
		has := false
		for _, capability := range provider.Capabilities {
			has = has || capability == "labels.downloads.sync"
		}
		if has != supportsDownloadLabels(provider.ID) {
			t.Fatal(provider)
		}
	}
}
