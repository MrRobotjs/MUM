package main

import (
	"database/sql"
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
