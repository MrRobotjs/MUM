package main

import (
	"context"
	"database/sql"
)

// catalogueExternalIDs is an item's TMDB, TVDB and IMDb IDs as the item pages
// receive them: null when the server did not report one.
type catalogueExternalIDs struct {
	TMDB *int64  `json:"tmdb"`
	TVDB *int64  `json:"tvdb"`
	IMDb *string `json:"imdb"`
}

// readItemExternalIDs returns the IDs the last library sync saved for an item.
func readItemExternalIDs(ctx context.Context, tx *sql.Tx, item int64) (catalogueExternalIDs, error) {
	var tmdb, tvdb sql.NullInt64
	var imdb sql.NullString
	if err := tx.QueryRowContext(ctx, "SELECT tmdb_id,tvdb_id,imdb_id FROM media_items WHERE id=?", item).Scan(&tmdb, &tvdb, &imdb); err != nil {
		return catalogueExternalIDs{}, err
	}
	var ids catalogueExternalIDs
	if tmdb.Valid {
		ids.TMDB = &tmdb.Int64
	}
	if tvdb.Valid {
		ids.TVDB = &tvdb.Int64
	}
	if imdb.Valid {
		ids.IMDb = &imdb.String
	}
	return ids, nil
}
