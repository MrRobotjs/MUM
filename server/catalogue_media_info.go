package main

import (
	"context"
	"database/sql"
	"encoding/json"

	"app/server/providers/provider"
)

// readItemMediaInfo returns the file details the last library sync saved for
// an item, or nil when there are none. A stored record is cleaned again so the
// page only ever receives the labels and numbers a sync could have written.
func readItemMediaInfo(ctx context.Context, tx *sql.Tx, item int64) (*provider.CatalogueMedia, error) {
	var raw sql.NullString
	if err := tx.QueryRowContext(ctx, "SELECT media_info FROM media_items WHERE id=?", item).Scan(&raw); err != nil {
		return nil, err
	}
	if !raw.Valid {
		return nil, nil
	}
	var media provider.CatalogueMedia
	if err := json.Unmarshal([]byte(raw.String), &media); err != nil {
		return nil, ErrConflict
	}
	return media.Clean(), nil
}
