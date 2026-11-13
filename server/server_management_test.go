package main

import (
	"database/sql"
	"encoding/json"
	"slices"
	"testing"
)

// A user sync rewrites an account only when a stored detail really differs,
// and names those details (never their values) in its log.
func TestSyncAccountChangedFields(t *testing.T) {
	text := func(v string) sql.NullString { return sql.NullString{String: v, Valid: true} }
	stored := storedSyncAccount{Active: true, Downloads: true, Name: text("Reader"), Email: text("reader@example.invalid"), Libraries: text(`["1"]`), Settings: text(`{"all_libraries":false}`), Avatar: text("/avatar"), Joined: text("2026-01-01T00:00:00Z")}
	same := syncedAccount{Name: "Reader", Email: "reader@example.invalid", Libraries: `["1"]`, Settings: `{"all_libraries":false}`, Active: true, DownloadsKnown: true, Downloads: true, Avatar: "/avatar", Joined: "2026-01-01T00:00:00Z"}
	for _, c := range []struct {
		name   string
		edit   func(*storedSyncAccount, *syncedAccount)
		fields []string
	}{
		{"unchanged", func(*storedSyncAccount, *syncedAccount) {}, nil},
		// Details the provider did not report keep their stored values.
		{"unreported details", func(_ *storedSyncAccount, in *syncedAccount) {
			in.Avatar, in.Joined, in.DownloadsKnown, in.Downloads = "", "", false, false
		}, nil},
		{"renamed", func(_ *storedSyncAccount, in *syncedAccount) { in.Name = "Reader 2" }, []string{"external_username"}},
		{"libraries and access", func(_ *storedSyncAccount, in *syncedAccount) {
			in.Libraries, in.Active = `["1","2"]`, false
		}, []string{"allowed_library_ids", "is_active"}},
		{"downloads reported", func(_ *storedSyncAccount, in *syncedAccount) { in.Downloads = false }, []string{"allow_downloads"}},
		{"restored after removal", func(st *storedSyncAccount, _ *syncedAccount) { st.Removed = true }, []string{"removed_at"}},
		// A missing stored value is written once, then matches.
		{"email never stored", func(st *storedSyncAccount, _ *syncedAccount) { st.Email = sql.NullString{} }, []string{"external_email"}},
		{"new avatar", func(_ *storedSyncAccount, in *syncedAccount) { in.Avatar = "/new" }, []string{"external_avatar_url"}},
	} {
		t.Run(c.name, func(t *testing.T) {
			st, in := stored, same
			c.edit(&st, &in)
			if got := st.changedFields(in); !slices.Equal(got, c.fields) {
				t.Fatalf("changed fields %v, want %v", got, c.fields)
			}
		})
	}
}

// Users and profiles carry each admin role's saved colour, icon and style, so
// admin role badges look the same as in the Admin Roles settings.
func TestUserReadsCarryAdminRoleVisuals(t *testing.T) {
	a, s := testApp(t)
	token, _ := bootstrapOwner(t, a)
	owner, err := s.Authenticate(t.Context(), token)
	if err != nil {
		t.Fatal(err)
	}
	target, err := s.CreateAccount(t.Context(), owner.UUID, "visual-admin", "fixture-hash", false)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.writer.Exec(`INSERT INTO admin_roles(id,name,description,position,color,icon,badge_style) VALUES('second','Second','Later',20,'#00ff00',NULL,'default'),('first','First','Shown first',10,'#123abc','fa-solid fa-star','outline');
		INSERT INTO admin_privileges VALUES(?,'second'),(?,'first')`, target, target); err != nil {
		t.Fatal(err)
	}
	w := apiRequest(a, "GET", "/api/users/"+target, token, nil, nil)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	var body struct {
		Data struct {
			Names   []string `json:"admin_roles"`
			Details []struct {
				Name, Color, Badge string
				Icon, Description  *string
			} `json:"admin_roles_detail"`
		}
	}
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	got := body.Data
	if len(got.Names) != 2 || got.Names[0] != "First" || got.Names[1] != "Second" || len(got.Details) != 2 {
		t.Fatalf("admin roles %s", w.Body.String())
	}
	first, second := got.Details[0], got.Details[1]
	if first.Name != "First" || first.Color != "#123abc" || first.Icon == nil || *first.Icon != "fa-solid fa-star" || first.Description == nil || *first.Description != "Shown first" || second.Name != "Second" || second.Icon != nil {
		t.Fatalf("admin role visuals %s", w.Body.String())
	}
}
