package main

import (
	"strings"
	"testing"
	"time"
)

func targetURL(target, view, query string) string {
	return "/api/activity/identities/" + target + "/" + view + query
}
func TestActivityTargetsHumanServiceAndDefaultIsolation(t *testing.T) {
	f := activityReadFixture(t)
	seedSummaryHistory(t, f)
	owner, _ := f.store.Authenticate(t.Context(), f.ownerToken)
	activityExec(t, f.store, "DELETE FROM admin_privileges WHERE user_uuid=?", f.user)
	for _, target := range []string{f.user, f.service} {
		for _, view := range []string{"history", "current", "summary"} {
			w := apiRequest(f.app, "GET", targetURL(target, view, ""), f.token, nil, nil)
			if w.Code != 200 {
				t.Fatal(target, view, w.Code, w.Body.String())
			}
			p := responseData(t, w)
			if p["target_uuid"] != target || p["scope"] != "own" || p["actor_uuid"] != f.user {
				t.Fatal(p)
			}
			if view == "summary" {
				if p["recorded_observations"] != "121" {
					t.Fatal(p)
				}
			} else if view == "history" {
				if len(p["items"].([]any)) != 100 || p["next_before"] == nil {
					t.Fatal(p)
				}
			} else if len(p["items"].([]any)) != 1 {
				t.Fatal(p)
			}
			if strings.Contains(w.Body.String(), "owner_uuid") {
				t.Fatal("own target exposed owner field")
			}
			if w.Header().Get("Cache-Control") != "no-store" {
				t.Fatal("cacheable target")
			}
		}
	}
	for _, view := range []string{"history", "current", "summary"} {
		if w := apiRequest(f.app, "GET", targetURL(owner.UUID, view, ""), f.token, nil, nil); w.Code != 403 {
			t.Fatal("other human admitted", w.Code)
		}
		if w := apiRequest(f.app, "GET", targetURL(f.service, view, "?scope=all"), f.token, nil, nil); w.Code != 403 {
			t.Fatal("ordinary all target admitted", w.Code)
		}
		if w := apiRequest(f.app, "GET", targetURL(f.user, view, ""), "", nil, nil); w.Code != 401 {
			t.Fatal("anonymous target", w.Code)
		}
	}
	for _, target := range []string{f.user, f.service} {
		w := apiRequest(f.app, "GET", targetURL(target, "summary", "?scope=all"), f.ownerToken, nil, nil)
		p := responseData(t, w)
		want := "121"
		if target == f.service {
			want = "128"
		}
		if w.Code != 200 || p["target_uuid"] != target || p["recorded_observations"] != want {
			t.Fatal(w.Code, p)
		}
	}
	if w := apiRequest(f.app, "GET", "/api/activity/history?target="+f.service, f.token, nil, nil); w.Code != 400 {
		t.Fatal("query target alias admitted")
	}
}
func TestActivityTargetsFrozenAttributionAcrossOwnershipChange(t *testing.T) {
	for _, mode := range []string{"transfer", "delegate", "unlink"} {
		t.Run(mode, func(t *testing.T) {
			f := activityReadFixture(t)
			seedSummaryHistory(t, f)
			owner, _ := f.store.Authenticate(t.Context(), f.ownerToken)
			switch mode {
			case "transfer":
				activityExec(t, f.store, "UPDATE service_links SET user_uuid=? WHERE service_uuid=?", owner.UUID, f.service)
			case "delegate":
				activityExec(t, f.store, "UPDATE service_links SET link_kind='delegate' WHERE service_uuid=?", f.service)
			case "unlink":
				activityExec(t, f.store, "DELETE FROM service_links WHERE service_uuid=?", f.service)
			}
			for _, view := range []string{"history", "current", "summary"} {
				if w := apiRequest(f.app, "GET", targetURL(f.service, view, ""), f.token, nil, nil); w.Code != 403 {
					t.Fatal("former/delegate service authority persisted", view, w.Code)
				}
			}
			human := responseData(t, apiRequest(f.app, "GET", targetURL(f.user, "summary", "?scope=all"), f.ownerToken, nil, nil))
			if human["recorded_observations"] != "121" || human["fresh_current_observations"] != "0" {
				t.Fatal("admin frozen human attribution lost", human)
			}
			service := responseData(t, apiRequest(f.app, "GET", targetURL(f.service, "summary", "?scope=all"), f.ownerToken, nil, nil))
			if service["recorded_observations"] != "128" {
				t.Fatal(service)
			}
			own := responseData(t, apiRequest(f.app, "GET", targetURL(f.user, "summary", ""), f.token, nil, nil))
			if own["recorded_observations"] != "0" {
				t.Fatal("own target bypassed current link privacy", own)
			}
			newOwner := responseData(t, apiRequest(f.app, "GET", targetURL(owner.UUID, "summary", "?scope=all"), f.ownerToken, nil, nil))
			if newOwner["recorded_observations"] != "0" {
				t.Fatal("new owner inherited prior attribution", newOwner)
			}
		})
	}
}
func TestActivityTargetsServiceFilterAndLiveDelivery(t *testing.T) {
	for _, mode := range []string{"service-filter", "link-aba", "role", "deleted", "session"} {
		t.Run(mode, func(t *testing.T) {
			f := activityReadFixture(t)
			seedSummaryHistory(t, f)
			q := activityReadQuery{All: mode == "role" || mode == "deleted", Target: f.service}
			if mode == "deleted" {
				q.Target = seedService(t, f.store, f.server)
			}
			tx, err := f.store.beginActivityView(t.Context(), f.user, f.token, q.All)
			if err != nil {
				t.Fatal(err)
			}
			_, fences, err := readActivityStatuses(t.Context(), tx, f.user, q, time.Now())
			if err != nil {
				t.Fatal(err)
			}
			if err := tx.Commit(); err != nil {
				t.Fatal(err)
			}
			switch mode {
			case "service-filter":
				other := seedService(t, f.store, f.server)
				activityExec(t, f.store, `INSERT INTO media_activity_history(server_id,external_session_id,service_uuid,item_id,media_type,title,first_seen_at,last_seen_at,paused) VALUES(?,'other-target',?,'item','Movie','Other private title',?,?,0)`, f.server, other, utcTimestamp(time.Now()), utcTimestamp(time.Now()))
				p := responseData(t, apiRequest(f.app, "GET", targetURL(f.service, "summary", "?scope=all"), f.ownerToken, nil, nil))
				if p["recorded_observations"] != "128" {
					t.Fatal("other service counted", p)
				}
				return
			case "link-aba":
				activityExec(t, f.store, "UPDATE service_links SET link_kind='delegate' WHERE service_uuid=?", f.service)
				activityExec(t, f.store, "UPDATE service_links SET link_kind='owner' WHERE service_uuid=?", f.service)
			case "role":
				activityExec(t, f.store, "DELETE FROM admin_privileges WHERE user_uuid=?", f.user)
			case "deleted":
				activityExec(t, f.store, "DELETE FROM service_accounts WHERE uuid=?", q.Target)
				activityExec(t, f.store, "DELETE FROM identities WHERE uuid=?", q.Target)
			case "session":
				activityExec(t, f.store, "DELETE FROM app_sessions WHERE user_uuid=?", f.user)
			}
			if err := f.store.checkActivityDelivery(t.Context(), f.user, f.token, q, fences); err == nil {
				t.Fatal("stale target response delivered", mode)
			}
		})
	}
}
func TestActivityTargetsStrictRouteAndQuery(t *testing.T) {
	f := activityReadFixture(t)
	for _, view := range []string{"current", "history", "summary"} {
		if w := apiRequest(f.app, "GET", targetURL("not-a-uuid", view, ""), f.ownerToken, nil, nil); w.Code != 400 {
			t.Fatal(w.Code, w.Body.String())
		}
		if w := apiRequest(f.app, "GET", targetURL("00000000-0000-0000-0000-000000000000", view, "?scope=all"), f.ownerToken, nil, nil); w.Code != 404 {
			t.Fatal(w.Code, w.Body.String())
		}
		if w := apiRequest(f.app, "GET", targetURL("00000000-0000-0000-0000-000000000000", view, ""), f.token, nil, nil); w.Code != 403 {
			t.Fatal(w.Code, w.Body.String())
		}
		for _, query := range []string{"?scope=all&scope=own", "?server=01", "?target=" + f.user} {
			if w := apiRequest(f.app, "GET", targetURL(f.user, view, query), f.ownerToken, nil, nil); w.Code != 400 {
				t.Fatal(view, query, w.Code)
			}
		}
	}
}
