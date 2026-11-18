package provider

import "time"

// HistoryEntry is one play read from a server's own history, in the form MUM
// imports from every service (HISTORY_IMPORT_DESIGN.md). Key is unique on its
// server and is what makes a repeat import skip the play. Descriptive fields
// may be empty, for example when the item was deleted.
type HistoryEntry struct {
	Key       string
	AccountID string
	ViewedAt  time.Time
	Type      string
	ItemID    string
	Section   string

	Title            string
	ParentTitle      string
	GrandparentTitle string

	// The poster's item and reference: a Plex thumbnail path, a Jellyfin or
	// Emby image tag, or "cover" for an Audiobookshelf item. Both empty when
	// there is none.
	PosterItem string
	PosterPath string

	// How far and how long, in seconds; only Audiobookshelf reports them.
	PositionSeconds *int64
	DurationSeconds *int64
	// How long the session was listened to, in seconds (Audiobookshelf).
	ListenedSeconds *int64
}

// HistoryPage is one page of a server's history. Read is how many records the
// server returned, which can exceed len(Entries) when the page holds records
// that are not plays; the importer advances by Read.
type HistoryPage struct {
	Entries []HistoryEntry
	Offset  int
	Read    int
	Total   int
}
