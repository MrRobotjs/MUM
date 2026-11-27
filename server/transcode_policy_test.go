package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"app/server/providers/mediabrowser"
	"app/server/providers/provider"
)

func TestIs4K(t *testing.T) {
	for _, c := range []struct {
		width, height int64
		want          bool
	}{{3840, 2160, true}, {4096, 1716, true}, {3840, 1600, true}, {0, 2160, true}, {3440, 1440, false}, {2560, 1440, false}, {1920, 1080, false}, {0, 0, false}} {
		if provider.Is4K(c.width, c.height) != c.want {
			t.Fatal(c)
		}
	}
}

// Jellyfin and Emby report a 4K transcode only when TranscodingInfo says the
// video is not direct and the playing item is 4K; anything unknown is not.
func TestMediaBrowserSessionsReport4KTranscode(t *testing.T) {
	stream := func(width, height int) []any {
		return []any{map[string]any{"Type": "Audio"}, map[string]any{"Type": "Video", "Width": width, "Height": height}}
	}
	for _, c := range []struct {
		name string
		edit func(row, item map[string]any)
		want bool
	}{
		{"4K stream transcoded", func(row, item map[string]any) {
			row["TranscodingInfo"] = map[string]any{"IsVideoDirect": false}
			item["MediaStreams"] = stream(3840, 2160)
		}, true},
		{"item size when no streams", func(row, item map[string]any) {
			row["TranscodingInfo"] = map[string]any{"IsVideoDirect": false}
			item["Width"], item["Height"] = 3840, 1600
		}, true},
		{"video copied, audio transcoded", func(row, item map[string]any) {
			row["TranscodingInfo"] = map[string]any{"IsVideoDirect": true, "IsAudioDirect": false}
			item["MediaStreams"] = stream(3840, 2160)
		}, false},
		{"1080p transcoded", func(row, item map[string]any) {
			row["TranscodingInfo"] = map[string]any{"IsVideoDirect": false}
			item["MediaStreams"] = stream(1920, 1080)
		}, false},
		{"direct play", func(row, item map[string]any) { item["MediaStreams"] = stream(3840, 2160) }, false},
		{"unknown video decision", func(row, item map[string]any) {
			row["TranscodingInfo"] = map[string]any{"VideoCodec": "h264"}
			item["MediaStreams"] = stream(3840, 2160)
		}, false},
		{"malformed details are unknown, not a failed read", func(row, item map[string]any) {
			row["TranscodingInfo"] = map[string]any{"IsVideoDirect": "no"}
			item["MediaStreams"] = "bad"
		}, false},
	} {
		for _, kind := range []string{"jellyfin", "emby"} {
			row := activityFixtureRow()
			c.edit(row, row["NowPlayingItem"].(map[string]any))
			body, _ := json.Marshal([]any{row})
			snapshot, err := mediabrowser.ParseSessions(kind, body)
			if err != nil || len(snapshot.Sessions) != 1 || snapshot.Sessions[0].Transcode4K != c.want {
				t.Fatal(kind, c.name, err, snapshot.Sessions)
			}
		}
	}
}

// Plex: the source comes from the item's library metadata, the decision from
// the TranscodeSession. Without readable metadata the source is unknown.
func TestPlexSessionsReport4KTranscode(t *testing.T) {
	source4K := strings.Replace(plexOriginalSource, `videoResolution="1080" height="804"`, `videoResolution="4k" width="3840" height="2160"`, 1)
	for _, c := range []struct {
		name, decision, metadata string
		want                     bool
	}{
		{"4K source transcoded", "transcode", source4K, true},
		{"4K source copied", "copy", source4K, false},
		{"1080p source transcoded", "transcode", plexOriginalSource, false},
		{"metadata unavailable", "transcode", "", false},
	} {
		body := strings.Replace(plexOutputPlaying(), `videoDecision="copy"`, `videoDecision="`+c.decision+`"`, 1)
		if !strings.Contains(body, `videoDecision="`+c.decision+`"`) {
			t.Fatal("fixture has no video decision")
		}
		upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			switch {
			case r.URL.Path == "/status/sessions":
				fmt.Fprint(w, body)
			case c.metadata == "":
				w.WriteHeader(503)
			default:
				fmt.Fprint(w, c.metadata)
			}
		}))
		p, _ := newServerConnection(ProviderConfig{"plex", upstream.URL, "fixture-secret"}, nil)
		snapshot, err := p.readActivitySnapshot(t.Context())
		upstream.Close()
		if err != nil || len(snapshot.Sessions) != 1 || snapshot.Sessions[0].Transcode4K != c.want {
			t.Fatal(c.name, err, snapshot.Sessions)
		}
	}
}

// policyUpstream is a Jellyfin server playing one stream for the given
// account, recording the stop commands it receives.
type policyUpstream struct {
	server   *httptest.Server
	mu       sync.Mutex
	sessions []byte
	stops    []string
	status   int
}

func newPolicyUpstream(t *testing.T) *policyUpstream {
	t.Helper()
	up := &policyUpstream{status: http.StatusNoContent}
	up.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		up.mu.Lock()
		defer up.mu.Unlock()
		if r.URL.Path == "/Sessions" {
			_, _ = w.Write(up.sessions)
			return
		}
		up.stops = append(up.stops, r.Method+" "+r.URL.Path)
		w.WriteHeader(up.status)
	}))
	t.Cleanup(up.server.Close)
	return up
}

func (up *policyUpstream) play(account string, transcoded bool, width int) {
	row := activityFixtureRow()
	row["UserId"] = account
	row["TranscodingInfo"] = map[string]any{"IsVideoDirect": !transcoded}
	row["NowPlayingItem"].(map[string]any)["MediaStreams"] = []any{map[string]any{"Type": "Video", "Width": width, "Height": width * 9 / 16}}
	body, _ := json.Marshal([]any{row})
	up.mu.Lock()
	up.sessions, up.stops = body, nil
	up.mu.Unlock()
}

func (up *policyUpstream) seen() []string {
	up.mu.Lock()
	defer up.mu.Unlock()
	return append([]string{}, up.stops...)
}

// A server account with 4K transcoding off has a 4K transcode stopped once,
// with a message; direct play, 1080p and allowed accounts are left alone,
// and a failed stop is recorded and never repeated.
func TestTranscodePolicyStopsBlocked4KTranscodes(t *testing.T) {
	a, s := testApp(t)
	token, _ := bootstrapOwner(t, a)
	owner, _ := s.Authenticate(t.Context(), token)
	up := newPolicyUpstream(t)
	server := createManagedServer(t, a, token, "jellyfin", up.server.URL)
	account := seedService(t, s, server)
	capture := func() {
		t.Helper()
		if _, err := a.captureProviderActivity(t.Context(), owner.UUID, token, server); err != nil {
			t.Fatal(err)
		}
	}
	outcomes := func() string {
		t.Helper()
		rows, err := s.reader.Query("SELECT json_extract(details,'$.outcome') FROM audit_events WHERE action='stream.policy_stop' ORDER BY id")
		if err != nil {
			t.Fatal(err)
		}
		defer rows.Close()
		var out []string
		for rows.Next() {
			var outcome string
			if err := rows.Scan(&outcome); err != nil {
				t.Fatal(err)
			}
			out = append(out, outcome)
		}
		if err := rows.Err(); err != nil {
			t.Fatal(err)
		}
		return strings.Join(out, ",")
	}

	// Allowed (the default): nothing is stopped.
	up.play(account, true, 3840)
	capture()
	if stops := up.seen(); len(stops) != 0 {
		t.Fatal("allowed account stopped", stops)
	}
	activityExec(t, s, "UPDATE service_accounts SET allow_4k_transcode=0 WHERE uuid=?", account)
	for _, c := range []struct {
		transcoded bool
		width      int
	}{{false, 3840}, {true, 1920}} {
		up.play(account, c.transcoded, c.width)
		capture()
		if stops := up.seen(); len(stops) != 0 {
			t.Fatal("stopped a stream that is not a 4K transcode", c, stops)
		}
	}
	// A 4K transcode is stopped with a message, once.
	up.play(account, true, 3840)
	capture()
	if stops := strings.Join(up.seen(), ","); stops != "POST /Sessions/session/Message,POST /Sessions/session/Playing/Stop" {
		t.Fatal("stop commands", stops)
	}
	up.mu.Lock()
	up.stops = nil
	up.mu.Unlock()
	capture()
	if stops := up.seen(); len(stops) != 0 {
		t.Fatal("the same playback was stopped twice", stops)
	}
	if got := outcomes(); got != "terminated" {
		t.Fatal("audit", got)
	}
	// A new playback that the server fails to stop is recorded and not retried.
	up.play(account, true, 3840)
	up.mu.Lock()
	up.sessions = []byte(strings.Replace(string(up.sessions), `"Id":"item"`, `"Id":"next-item"`, 1))
	up.status = http.StatusInternalServerError
	up.mu.Unlock()
	capture()
	capture()
	if stops := up.seen(); len(stops) != 1 {
		t.Fatal("failed stop retried or not tried", stops)
	}
	if got := outcomes(); got != "terminated,failed" {
		t.Fatal("audit", got)
	}
	var pending int
	if err := s.reader.QueryRow("SELECT count(*) FROM transcode_policy_stops WHERE outcome='pending'").Scan(&pending); err != nil || pending != 0 {
		t.Fatal("unrecorded outcome", pending, err)
	}
}

// Edit sets 4K transcoding on Plex, Jellyfin and Emby server accounts only,
// and leaves the owner's and administrators' accounts to the owner's rules.
func TestEditSets4KTranscoding(t *testing.T) {
	a, s := testApp(t)
	token, _ := bootstrapOwner(t, a)
	owner, _ := s.Authenticate(t.Context(), token)
	jellyfin := seedServer(t, s)
	activityExec(t, s, "INSERT INTO media_servers(server_nickname,service_type,url) VALUES('books','kavita','http://example.invalid')")
	var kavita int64
	if err := s.reader.QueryRow("SELECT id FROM media_servers WHERE service_type='kavita'").Scan(&kavita); err != nil {
		t.Fatal(err)
	}
	viewer, mine, books := seedService(t, s, jellyfin), seedService(t, s, jellyfin), seedService(t, s, kavita)
	if err := s.LinkServiceAccounts(t.Context(), owner.UUID, owner.UUID, []string{mine}); err != nil {
		t.Fatal(err)
	}
	local, err := s.CreateAccount(t.Context(), owner.UUID, "local-viewer", "fixture-hash", false)
	if err != nil {
		t.Fatal(err)
	}
	for _, bad := range []map[string]any{{"action": "set_4k_transcode"}, {"action": "clear_expiration", "allow_4k_transcode": false}} {
		if w := apiRequest(a, "POST", "/api/users/edit/prepare", token, map[string]any{"request_id": newUUID(), "user_uuids": []string{viewer}, "operation": bad}, nil); w.Code != 400 {
			t.Fatal("invalid operation accepted", bad, w.Code, w.Body.String())
		}
	}
	w := apiRequest(a, "POST", "/api/users/edit/prepare", token, map[string]any{"request_id": newUUID(), "user_uuids": []string{viewer, mine, books, local}, "operation": map[string]any{"action": "set_4k_transcode", "allow_4k_transcode": false}}, nil)
	var prepared struct{ Data editReceipt }
	if err := json.Unmarshal(w.Body.Bytes(), &prepared); err != nil || w.Code != 201 {
		t.Fatalf("prepare %d %s", w.Code, w.Body.String())
	}
	reasons := map[string]string{}
	for _, result := range prepared.Data.Results {
		reasons[result.UUID] = result.Outcome + "/" + result.Reason
	}
	if reasons[mine] != "skipped/protected_account" || reasons[books] != "skipped/not_supported" || reasons[local] != "skipped/service_account_required" || reasons[viewer] != "pending/" {
		t.Fatal(reasons)
	}
	if w := apiRequest(a, "POST", "/api/edit-operations/"+prepared.Data.ID+"/execute", token, map[string]any{"revision": prepared.Data.Revision, "acknowledge_effects": true}, nil); w.Code != 202 {
		t.Fatalf("execute %d %s", w.Code, w.Body.String())
	}
	if receipt := waitEdit(t, a, token, prepared.Data.ID); receipt.Summary["updated"] != 1 {
		t.Fatal(receipt)
	}
	var blocked, ownAllowed bool
	if err := s.reader.QueryRow("SELECT (SELECT allow_4k_transcode=0 FROM service_accounts WHERE uuid=?),(SELECT allow_4k_transcode=1 FROM service_accounts WHERE uuid=?)", viewer, mine).Scan(&blocked, &ownAllowed); err != nil || !blocked || !ownAllowed {
		t.Fatal(blocked, ownAllowed, err)
	}
	// The Users list shows the setting for supported server accounts only.
	for id, want := range map[string]any{viewer: false, books: nil, local: nil} {
		if got := responseData(t, apiRequest(a, "GET", "/api/users/"+id, token, nil, nil))["allow_4k_transcode"]; got != want {
			t.Fatal(id, got, want)
		}
	}
}

// An invitation's 4K choice is saved per server, read back and given to the
// server accounts it creates.
func TestInvitation4KTranscodingReachesCreatedAccounts(t *testing.T) {
	a, s := testApp(t)
	admin, _ := bootstrapOwner(t, a)
	first, second := newProvisioningFixture(t, ""), newProvisioningFixture(t, "")
	_, _, servers := prepareInvitation(t, a, admin, first, second)
	blocked := false
	grants := []InvitationGrant{{ServerID: servers[0], LibraryIDs: []string{"movies"}, Allow4KTranscode: &blocked}, {ServerID: servers[1], LibraryIDs: []string{"movies"}}}
	w := apiRequest(a, "POST", "/api/invitations", admin, map[string]any{"expires_at": time.Now().Add(time.Hour).UTC().Format(time.RFC3339Nano), "max_uses": 1, "grants": grants}, nil)
	if w.Code != 201 {
		t.Fatal(w.Code, w.Body.String())
	}
	created := responseData(t, w)
	invite, token := int64(created["id"].(float64)), created["token"].(string)
	saved := map[float64]any{}
	for _, raw := range responseData(t, apiRequest(a, "GET", fmt.Sprintf("/api/invitations/%d", invite), admin, nil, nil))["grants"].([]any) {
		grant := raw.(map[string]any)
		saved[grant["server_id"].(float64)] = grant["allow_4k_transcode"]
	}
	if saved[float64(servers[0])] != false || saved[float64(servers[1])] != true {
		t.Fatal("saved grants", saved)
	}
	if w := apiRequest(a, "POST", "/api/public/invitations/"+token+"/redeem", "", redeemBody("Fourk Viewer", newUUID()), nil); w.Code != 201 || responseData(t, w)["status"] != "completed" {
		t.Fatal(w.Code, w.Body.String())
	}
	for i, want := range []bool{false, true} {
		var allowed bool
		if err := s.reader.QueryRow("SELECT allow_4k_transcode FROM service_accounts WHERE server_id=? AND used_invite_id=?", servers[i], invite).Scan(&allowed); err != nil || allowed != want {
			t.Fatal(i, allowed, err)
		}
	}
}
