package main

import (
	"encoding/json"
	"slices"
	"testing"
)

// Every media service lists every feature key in order, with what its module
// supports; the Media Servers cards compare services from this list.
func TestMediaServiceFeatures(t *testing.T) {
	a, _ := testApp(t)
	token, _ := bootstrapOwner(t, a)
	w := apiRequest(a, "GET", "/api/providers", token, nil, nil)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	var out struct {
		Data []struct {
			ID       string                `json:"id"`
			Features []mediaServiceFeature `json:"features"`
		} `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	supported := map[string]map[string]bool{}
	for _, service := range out.Data {
		keys := make([]string, 0, len(service.Features))
		supported[service.ID] = map[string]bool{}
		for _, f := range service.Features {
			keys = append(keys, f.Key)
			supported[service.ID][f.Key] = f.Supported
		}
		if !slices.Equal(keys, mediaServiceFeatureKeys) {
			t.Fatalf("%s lists %v", service.ID, keys)
		}
	}
	want := map[string]map[string]bool{
		// Plex: everything MUM does, including Overseerr and the server's resource graphs.
		"plex": {"users.sync": true, "users.invites": true, "users.library_access": true, "libraries.titles": true, "libraries.collections": true,
			"activity.live": true, "activity.stop": true, "activity.history_import": true, "extras.overseerr": true, "extras.resources": true},
		"jellyfin": {"users.sync": true, "activity.live": true, "activity.stop": true, "activity.history_import": true, "extras.overseerr": false, "extras.resources": false},
		// Audiobookshelf can't be watched live, but its listening history can be imported.
		"audiobookshelf": {"activity.live": false, "activity.stop": false, "activity.history_import": true},
		"kavita":         {"activity.live": false, "activity.history_import": false, "extras.overseerr": false},
	}
	for id, features := range want {
		if supported[id] == nil {
			t.Fatalf("%s missing", id)
		}
		for key, value := range features {
			if supported[id][key] != value {
				t.Errorf("%s %s = %v, want %v", id, key, supported[id][key], value)
			}
		}
	}
}
