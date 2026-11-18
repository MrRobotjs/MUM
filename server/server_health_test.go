package main

import (
	"database/sql"
	"testing"
	"time"
)

type healthRow struct {
	status  sql.NullBool
	checked sql.NullString
}

func readHealth(t *testing.T, s *Store, id int64) healthRow {
	t.Helper()
	var r healthRow
	if err := s.reader.QueryRow("SELECT last_status,last_status_check FROM media_servers WHERE id=?", id).Scan(&r.status, &r.checked); err != nil {
		t.Fatal(err)
	}
	return r
}

// The health monitor checks each active server that wasn't checked recently,
// a few at a time, records online or offline, and leaves disabled servers
// and recently checked ones alone.
func TestServerHealthSweep(t *testing.T) {
	a, s := testApp(t)
	token, _ := bootstrapOwner(t, a)
	upUpstream, _ := providerFixture(t, "jellyfin")
	downUpstream, downMode := providerFixture(t, "emby")
	up := createManagedServer(t, a, token, "jellyfin", upUpstream.URL)
	down := createManagedServer(t, a, token, "emby", downUpstream.URL)
	activityExec(t, s, `INSERT INTO media_servers(server_nickname,service_type,url,api_key,is_active) VALUES('Off','jellyfin','http://off.invalid','k',0)`)
	var off int64
	_ = s.reader.QueryRow("SELECT id FROM media_servers WHERE server_nickname='Off'").Scan(&off)
	downMode.Store(4)
	activityExec(t, s, "UPDATE media_servers SET last_status=NULL,last_status_check=NULL")

	checked, err := a.sweepServerHealth(t.Context())
	if err != nil || checked != 2 {
		t.Fatal("first sweep", checked, err)
	}
	if r := readHealth(t, s, up); !r.status.Valid || !r.status.Bool || !r.checked.Valid {
		t.Fatalf("up %+v", r)
	}
	if r := readHealth(t, s, down); !r.status.Valid || r.status.Bool || !r.checked.Valid {
		t.Fatalf("down %+v", r)
	}
	if r := readHealth(t, s, off); r.status.Valid || r.checked.Valid {
		t.Fatalf("a disabled server was checked %+v", r)
	}
	// Just checked: nothing to do until the interval passes.
	if checked, err := a.sweepServerHealth(t.Context()); err != nil || checked != 0 {
		t.Fatal("second sweep", checked, err)
	}
	// The server comes back; once its check is old enough it is checked again.
	downMode.Store(0)
	activityExec(t, s, "UPDATE media_servers SET last_status_check=? WHERE id=?", utcTimestamp(time.Now().Add(-2*serverHealthInterval)), down)
	if checked, err := a.sweepServerHealth(t.Context()); err != nil || checked != 1 {
		t.Fatal("third sweep", checked, err)
	}
	if r := readHealth(t, s, down); !r.status.Bool {
		t.Fatalf("recovered %+v", r)
	}
}

// A successful activity read proves the server is reachable, so it counts as
// a health check; a disabled server is never marked online.
func TestActivityReadMarksServerOnline(t *testing.T) {
	a, s := testApp(t)
	token, _ := bootstrapOwner(t, a)
	upstream, _ := providerFixture(t, "jellyfin")
	id := createManagedServer(t, a, token, "jellyfin", upstream.URL)
	activityExec(t, s, "UPDATE media_servers SET last_status=0,last_status_check=NULL WHERE id=?", id)
	if changed, err := a.markServerReachable(t.Context(), id); err != nil || !changed {
		t.Fatal("first mark", changed, err)
	}
	if r := readHealth(t, s, id); !r.status.Bool || !r.checked.Valid {
		t.Fatalf("marked %+v", r)
	}
	if changed, err := a.markServerReachable(t.Context(), id); err != nil || changed {
		t.Fatal("already online counts as a change", changed, err)
	}
	activityExec(t, s, "UPDATE media_servers SET is_active=0,last_status=0 WHERE id=?", id)
	if changed, err := a.markServerReachable(t.Context(), id); err != nil || changed {
		t.Fatal("a disabled server was marked", changed, err)
	}
	if r := readHealth(t, s, id); r.status.Bool {
		t.Fatalf("disabled marked online %+v", r)
	}
}

// Health changes go to administrators only.
func TestServerHealthChannelIsForAdministrators(t *testing.T) {
	a, s := testApp(t)
	token, _ := bootstrapOwner(t, a)
	owner, _ := s.Authenticate(t.Context(), token)
	hash, _ := hashPassword("a-strong-member-password")
	if _, err := s.CreateAccount(t.Context(), owner.UUID, "viewer", hash, false); err != nil {
		t.Fatal(err)
	}
	w := apiRequest(a, "POST", "/api/auth/login", "", map[string]any{"username": "viewer", "password": "a-strong-member-password"}, nil)
	viewer, err := s.Authenticate(t.Context(), responseData(t, w)["access_token"].(string))
	if err != nil {
		t.Fatal(err)
	}
	if !a.hub.canSubscribe(t.Context(), owner, serverHealthChannel) || a.hub.canSubscribe(t.Context(), viewer, serverHealthChannel) {
		t.Fatal("wrong health channel scope")
	}
}
