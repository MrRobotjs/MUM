package main

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestTofaAutomaticMonitoringRecordsSession(t *testing.T) {
	a, s := testApp(t)
	token, _ := bootstrapOwner(t, a)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer fixture-secret" {
			w.WriteHeader(401)
			return
		}
		switch r.URL.Path {
		case "/api/v1/users":
			fmt.Fprint(w, `[{"id":"11234567-89ab-4cde-8fab-0123456789ab","username":"Viewer","disabled":false,"preferences":{}}]`)
		case "/api/v1/system/playback/sessions":
			fmt.Fprint(w, `[{"session_id":"01234567-89ab-4cde-8fab-0123456789ab","user_id":"11234567-89ab-4cde-8fab-0123456789ab","media_id":"21234567-89ab-4cde-8fab-0123456789ab","media_file_id":"31234567-89ab-4cde-8fab-0123456789ab","media_title":"Movie","username":"Viewer","play_method":"DirectPlay","position_ms":3000,"duration_ms":9000,"is_paused":false}]`)
		case "/api/v1/media/21234567-89ab-4cde-8fab-0123456789ab":
			fmt.Fprint(w, `{"id":"21234567-89ab-4cde-8fab-0123456789ab","media_type":"movie","title":"Movie","poster_path":"present"}`)
		default:
			http.NotFound(w, r)
		}
	}))
	defer upstream.Close()
	id := createManagedServer(t, a, token, "tofa", upstream.URL)
	activityExec(t, s, "UPDATE activity_monitor_schedules SET next_run_at='2000-01-01T00:00:00Z' WHERE server_id=?", id)
	if err := a.runOneActivityMonitor(t.Context()); err != nil {
		t.Fatal(err)
	}
	w := apiRequest(a, "GET", "/api/activity/current?scope=all", token, nil, nil)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	v := responseData(t, w)
	if len(v["items"].([]any)) != 1 {
		t.Fatal("expected one recorded session", v)
	}
	row := v["items"].([]any)[0].(map[string]any)
	display, ok := row["display"].(map[string]any)
	if !ok || display["thumb_url"] == nil || display["stream_detail"] != "Direct Play" {
		t.Fatal("missing signed poster or playback details", row)
	}
	var linked int
	if err := s.reader.QueryRow(`SELECT count(*) FROM service_links WHERE service_uuid=?`, row["service_uuid"]).Scan(&linked); err != nil || linked != 0 {
		t.Fatal("observed identity acquired an inferred owner", linked, err)
	}
}
