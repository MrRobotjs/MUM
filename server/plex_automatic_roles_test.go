package main

import (
	"fmt"
	"io"
	"net/http"
	"slices"
	"strings"
	"testing"
)

// A fresh database has the Flask version's automatic roles, owned by MUM and
// shown in User Roles settings.
func TestAutomaticRolesExistFromTheStart(t *testing.T) {
	_, s := testApp(t)
	rows, err := s.reader.Query(`SELECT r.name,r.color,r.icon,r.is_auto_managed,
	 coalesce((SELECT 'downloads' FROM download_role d WHERE d.role_id=r.id),(SELECT k.kind FROM relationship_roles k WHERE k.role_id=r.id),'')
	 FROM user_roles r ORDER BY r.position`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var got []string
	for rows.Next() {
		var name, color, icon, kind string
		var automatic bool
		if err := rows.Scan(&name, &color, &icon, &automatic, &kind); err != nil {
			t.Fatal(err)
		}
		got = append(got, fmt.Sprintf("%s|%s|%s|%t|%s", name, color, icon, automatic, kind))
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	want := []string{
		"Downloads|#3b82f6|fa-solid fa-download|true|downloads",
		"Home User|#a855f7|fa-solid fa-house|true|home_user",
		"Shares Back|#22c55e|fa-solid fa-share|true|shares_back",
		"Owner|#f59e0b|fa-solid fa-crown|true|",
	}
	if !slices.Equal(got, want) {
		t.Fatalf("automatic roles %v, want %v", got, want)
	}
}

// The Plex user sync gives each account the roles Plex reports and preserves
// those roles when Plex does not report them.
func TestPlexSyncKeepsAutomaticRolesInStep(t *testing.T) {
	upstream, client, _ := extendedProviderFixture(t, "plex")
	base := client.Transport
	// The friend's attributes and server entries for the next sync.
	friend := `home="1" allowSync="1"`
	servers := `<Server machineIdentifier="fixture-machine" pending="0" owned="1"/><Server machineIdentifier="friend-machine" owned="0"/>`
	client.Transport = providerTransport(func(r *http.Request) (*http.Response, error) {
		response, err := base.RoundTrip(r)
		if err != nil || r.URL.Path != "/api/users/" {
			return response, err
		}
		body, err := io.ReadAll(response.Body)
		response.Body.Close()
		if err != nil {
			return nil, err
		}
		value := strings.Replace(string(body), `<User id="2" username="Reader" email="reader@example.invalid"><Server machineIdentifier="fixture-machine" pending="0"/>`,
			`<User id="2" username="Reader" email="reader@example.invalid" `+friend+`>`+servers, 1)
		response.Body = io.NopCloser(strings.NewReader(value))
		response.ContentLength = int64(len(value))
		return response, nil
	})
	a, s := testApp(t)
	a.ProviderHTTP = client
	token, _ := bootstrapOwner(t, a)
	id := createManagedServer(t, a, token, "plex", upstream.URL+"/proxy")
	labels := func(external string) string {
		t.Helper()
		var names string
		if err := s.reader.QueryRow(`SELECT coalesce(group_concat(name,','),'') FROM (SELECT r.name FROM service_accounts a JOIN identity_user_roles m ON m.user_uuid=a.uuid JOIN user_roles r ON r.id=m.role_id WHERE a.server_id=? AND a.external_user_id=? ORDER BY r.name)`, id, external).Scan(&names); err != nil {
			t.Fatal(err)
		}
		return names
	}
	sync := func() {
		t.Helper()
		if w := apiRequest(a, "POST", fmt.Sprintf("/api/servers/%d/sync", id), token, nil, nil); w.Code != 200 {
			t.Fatal(w.Code, w.Body.String())
		}
	}

	// Automatic roles can be renamed and restyled like in Flask; the sync finds
	// them by their registry entry, so renamed roles keep working. They can
	// never be deleted.
	rename := func(id, name string) {
		t.Helper()
		base := responseData(t, apiRequest(a, "GET", "/api/user-role-catalog", token, nil, nil))
		body := catalogChangeBody(base, "update", id)
		body["role"] = map[string]any{"name": name, "description": nil, "color": "#123abc", "icon": "fa-solid fa-star", "badge_style": "fill"}
		if w := apiRequest(a, "POST", "/api/user-role-catalog/changes", token, body, nil); w.Code != 200 {
			t.Fatal("rename", name, w.Code, w.Body.String())
		}
	}
	var downloads, home, sharesBack string
	if err := s.reader.QueryRow("SELECT (SELECT role_id FROM download_role),(SELECT role_id FROM relationship_roles WHERE kind='home_user'),(SELECT role_id FROM relationship_roles WHERE kind='shares_back')").Scan(&downloads, &home, &sharesBack); err != nil {
		t.Fatal(err)
	}
	rename(downloads, "Can Download")
	rename(home, "Family Home")
	rename(sharesBack, "Sharing With Me")
	current := responseData(t, apiRequest(a, "GET", "/api/user-role-catalog", token, nil, nil))
	if w := apiRequest(a, "POST", "/api/user-role-catalog/changes", token, catalogChangeBody(current, "delete", home), nil); w.Code != 403 {
		t.Fatal("automatic role deleted", w.Code, w.Body.String())
	}

	sync()
	if got := labels("2"); got != "Can Download,Family Home,Sharing With Me" {
		t.Fatalf("friend labels %q", got)
	}
	// The owner can always download; Home status is unknown in this fixture.
	if got := labels("1"); got != "Can Download,Owner" {
		t.Fatalf("owner labels %q", got)
	}

	friend = `home="0" allowSync="0"`
	servers = `<Server machineIdentifier="fixture-machine" pending="0" owned="1"/>`
	sync()
	if got := labels("2"); got != "" {
		t.Fatalf("labels kept after plex.tv stopped reporting them: %q", got)
	}

	friend = `home="1" allowSync="1"`
	servers = `<Server machineIdentifier="fixture-machine" pending="0" owned="1"/><Server machineIdentifier="friend-machine" owned="0"/>`
	sync()
	// Without an explicit home flag the relationship is unknown: Home User and
	// Shares Back stay as they were, while Downloads still follows allowSync.
	friend = `allowSync="0"`
	sync()
	if got := labels("2"); got != "Family Home,Sharing With Me" {
		t.Fatalf("unknown relationship changed labels: %q", got)
	}
	var audits int
	if err := s.reader.QueryRow("SELECT count(*) FROM audit_events WHERE action='provider.relationship_labels.reconcile'").Scan(&audits); err != nil || audits != 3 {
		t.Fatal("relationship label changes not audited once per changing sync", audits, err)
	}
}
