package main

import (
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

func activityForUser(t *testing.T, user string) activitySnapshot {
	t.Helper()
	row := activityFixtureRow()
	row["UserId"] = user
	body, _ := json.Marshal([]any{row})
	snapshot, err := parseActivitySnapshot("jellyfin", body)
	if err != nil {
		t.Fatal(err)
	}
	return snapshot
}
func TestActivityHistoryCompleteObservationLifecycle(t *testing.T) {
	a, s := testApp(t)
	token, _ := bootstrapOwner(t, a)
	owner, _ := s.Authenticate(t.Context(), token)
	var payload atomic.Value
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/Sessions" || r.Header.Get("X-Emby-Token") != "fixture-secret" {
			t.Error("wrong activity request")
		}
		_, _ = w.Write(payload.Load().([]byte))
	}))
	defer upstream.Close()
	server := createManagedServer(t, a, token, "jellyfin", upstream.URL)
	service := seedService(t, s, server)
	user, err := s.CreateAccount(t.Context(), owner.UUID, "activity-owner", "fixture-hash", false)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.LinkServiceAccounts(t.Context(), owner.UUID, user, []string{service}); err != nil {
		t.Fatal(err)
	}
	row := activityFixtureRow()
	row["UserId"] = service
	set := func() { body, _ := json.Marshal([]any{row}); payload.Store(body) }
	set()
	capture := func() activityApplyResult {
		result, err := a.captureProviderActivity(t.Context(), owner.UUID, token, server)
		if err != nil {
			t.Fatal(err)
		}
		return result
	}
	if result := capture(); result.Started != 1 || result.Updated != 0 || result.Ended != 0 {
		t.Fatal(result)
	}
	row["PlayState"].(map[string]any)["IsPaused"] = true
	row["PlayState"].(map[string]any)["PositionTicks"] = 5000000
	set()
	if result := capture(); result.Updated != 1 || result.Started != 0 {
		t.Fatal(result)
	}
	row["NowPlayingItem"].(map[string]any)["Id"] = "next-item"
	set()
	if result := capture(); result.Started != 1 || result.Ended != 1 {
		t.Fatal(result)
	}
	other, err := s.CreateAccount(t.Context(), owner.UUID, "next-owner", "fixture-hash", false)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.UnlinkServiceAccount(t.Context(), owner.UUID, user, service); err != nil {
		t.Fatal(err)
	}
	if err := s.LinkServiceAccounts(t.Context(), owner.UUID, other, []string{service}); err != nil {
		t.Fatal(err)
	}
	if result := capture(); result.Started != 1 || result.Ended != 1 {
		t.Fatal(result)
	}
	payload.Store([]byte(`null`))
	if _, err := a.captureProviderActivity(t.Context(), owner.UUID, token, server); err == nil {
		t.Fatal("invalid read accepted")
	}
	var active int
	var status string
	s.reader.QueryRow("SELECT count(*) FROM media_activity_current WHERE server_id=?", server).Scan(&active)
	s.reader.QueryRow("SELECT last_result FROM media_activity_state WHERE server_id=?", server).Scan(&status)
	if active != 1 || status != "failed" {
		t.Fatal("failure erased prior activity", active, status)
	}
	payload.Store([]byte(`[]`))
	if result := capture(); result.Ended != 1 {
		t.Fatal(result)
	}
	var histories, oldOwners int
	s.reader.QueryRow("SELECT count(*) FROM media_activity_history WHERE server_id=?", server).Scan(&histories)
	s.reader.QueryRow("SELECT count(*) FROM media_activity_history WHERE server_id=? AND owner_uuid=?", server, user).Scan(&oldOwners)
	if histories != 3 || oldOwners != 2 {
		t.Fatal("ownership transfer rewrote history", histories, oldOwners)
	}
	var reason string
	s.reader.QueryRow("SELECT end_reason FROM media_activity_history WHERE owner_uuid=?", other).Scan(&reason)
	if reason != "not_observed" {
		t.Fatal(reason)
	}
}
func TestActivityGenerationSupersedesOlderReadAndRejectsReplay(t *testing.T) {
	a, s, token, _, _ := roleReadFixture(t)
	actor, _ := s.Authenticate(t.Context(), token)
	server := seedServer(t, s)
	service := seedService(t, s, server)
	first, err := s.beginActivityRead(t.Context(), actor.UUID, token, server)
	if err != nil {
		t.Fatal(err)
	}
	second, err := s.beginActivityRead(t.Context(), actor.UUID, token, server)
	if err != nil {
		t.Fatal(err)
	}
	snapshot := activityForUser(t, service)
	if _, err := s.applyActivitySnapshot(t.Context(), first, snapshot); !errors.Is(err, ErrConflict) {
		t.Fatal("older read won", err)
	}
	if _, err := s.applyActivitySnapshot(t.Context(), second, snapshot); err != nil {
		t.Fatal(err)
	}
	if err := s.failActivityRead(t.Context(), first); !errors.Is(err, ErrConflict) {
		t.Fatal("older failure altered current state", err)
	}
	if _, err := s.applyActivitySnapshot(t.Context(), second, snapshot); !errors.Is(err, ErrConflict) {
		t.Fatal("observation replayed", err)
	}
	if w := apiRequest(a, "GET", "/api/activity", token, nil, nil); w.Code != 404 {
		t.Fatal("private foundation enabled a public route")
	}
}
func TestActivityClaimIdentityAuthorityAndAtomicFailureGuards(t *testing.T) {
	for _, mode := range []string{"server-revision", "provider-disabled", "link", "service-aba", "expired", "logout", "revoked", "unknown-user", "duplicate", "provider", "early-time", "future-time", "backward-time", "rollback"} {
		t.Run(mode, func(t *testing.T) {
			_, s, ownerToken, token, actor := roleReadFixture(t)
			owner, _ := s.Authenticate(t.Context(), ownerToken)
			server := seedServer(t, s)
			service := seedService(t, s, server)
			claim, err := s.beginActivityRead(t.Context(), actor, token, server)
			if err != nil {
				t.Fatal(err)
			}
			snapshot := activityForUser(t, service)
			switch mode {
			case "server-revision":
				s.writer.Exec("UPDATE media_servers SET revision=revision+1 WHERE id=?", server)
			case "provider-disabled":
				s.writer.Exec("UPDATE provider_settings SET enabled=0 WHERE provider_id='jellyfin'")
			case "link":
				s.LinkServiceAccounts(t.Context(), owner.UUID, actor, []string{service})
			case "service-aba":
				s.writer.Exec("UPDATE service_accounts SET is_active=0 WHERE uuid=?", service)
				s.writer.Exec("UPDATE service_accounts SET is_active=1 WHERE uuid=?", service)
			case "expired":
				s.writer.Exec("UPDATE media_activity_state SET pending_until='2000-01-01T00:00:00Z' WHERE server_id=?", server)
			case "logout":
				s.writer.Exec("DELETE FROM app_sessions WHERE user_uuid=?", actor)
			case "revoked":
				s.writer.Exec("DELETE FROM admin_privileges WHERE user_uuid=?", actor)
			case "unknown-user":
				bad := snapshot.Sessions[0]
				bad.Session = "other"
				bad.User = "unmapped-name-is-not-identity"
				snapshot.Sessions = append(snapshot.Sessions, bad)
			case "duplicate":
				snapshot.Sessions = append(snapshot.Sessions, snapshot.Sessions[0])
			case "provider":
				snapshot.Provider = "emby"
			case "early-time":
				snapshot.ObservedAt = claim.Started.Add(-time.Second)
			case "future-time":
				snapshot.ObservedAt = time.Now().Add(time.Hour)
			case "backward-time":
				s.writer.Exec("UPDATE media_activity_state SET observed_at=? WHERE server_id=?", utcTimestamp(time.Now().Add(time.Hour)), server)
			}
			if mode == "rollback" {
				rollback := errors.New("rollback complete history and audit")
				err = s.write(t.Context(), func(tx *sql.Tx) error {
					if _, err := commitActivitySnapshot(t.Context(), tx, claim, snapshot); err != nil {
						return err
					}
					return rollback
				})
				if !errors.Is(err, rollback) {
					t.Fatal(err)
				}
			} else {
				if _, err := s.applyActivitySnapshot(t.Context(), claim, snapshot); err == nil {
					t.Fatal("stale/invalid snapshot committed", mode)
				}
			}
			var histories, current, audits int
			s.reader.QueryRow("SELECT count(*) FROM media_activity_history").Scan(&histories)
			s.reader.QueryRow("SELECT count(*) FROM media_activity_current").Scan(&current)
			s.reader.QueryRow("SELECT count(*) FROM audit_events WHERE action='activity.snapshot'").Scan(&audits)
			if histories != 0 || current != 0 || audits != 0 {
				t.Fatal("partial snapshot committed", histories, current, audits)
			}
			if mode == "rollback" {
				if _, err := s.applyActivitySnapshot(t.Context(), claim, snapshot); err != nil {
					t.Fatal(err)
				}
			}
		})
	}
}
