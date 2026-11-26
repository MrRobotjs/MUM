package main

import "testing"

// A stream card title links to MUM's content page only for administrators and
// only when the played item matches one synced item.
func TestCurrentStreamsLinkUniqueCataloguedItems(t *testing.T) {
	f := activityReadFixture(t)
	read := func(token, scope string) map[string]any {
		t.Helper()
		w := apiRequest(f.app, "GET", "/api/activity/current?scope="+scope, token, nil, nil)
		if w.Code != 200 {
			t.Fatal(w.Code, w.Body.String())
		}
		return responseData(t, w)["items"].([]any)[0].(map[string]any)
	}
	row := read(f.ownerToken, "all")
	if row["link"] != nil {
		t.Fatal("unsynced item received a link", row)
	}
	item := row["item_id"].(string)
	activityExec(t, f.store, "INSERT INTO media_libraries(server_id,external_id,name) VALUES(?,'lib','Movies')", f.server)
	activityExec(t, f.store, "INSERT INTO media_items(library_id,server_id,external_id,title,item_type) SELECT id,?,?,'Film','movie' FROM media_libraries WHERE server_id=? AND external_id='lib'", f.server, item, f.server)
	link, ok := read(f.ownerToken, "all")["link"].(map[string]any)
	if !ok || link["media_id"] == nil || link["episode_id"] != nil {
		t.Fatal("matched item has no link", link)
	}
	if own := read(f.token, "own"); own["link"] != nil {
		t.Fatal("member received an administrator content link", own)
	}
	activityExec(t, f.store, "INSERT INTO media_libraries(server_id,external_id,name) VALUES(?,'lib2','Other')", f.server)
	activityExec(t, f.store, "INSERT INTO media_items(library_id,server_id,external_id,title,item_type) SELECT id,?,?,'Other','movie' FROM media_libraries WHERE server_id=? AND external_id='lib2'", f.server, item, f.server)
	if row := read(f.ownerToken, "all"); row["link"] != nil {
		t.Fatal("ambiguous item received a link", row)
	}
}
