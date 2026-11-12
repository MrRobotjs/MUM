package main

import (
	"context"
	"database/sql"
	"fmt"
)

// userLibraryName is one of a server's libraries as stored by the last sync.
// Grants name libraries by the provider's external ID; internal_id is an
// older unique key that is accepted as a fallback.
type userLibraryName struct {
	ExternalID string
	InternalID string
	Name       string
}

// readUserLibraryNames lists a server's libraries in name order.
func readUserLibraryNames(ctx context.Context, tx *sql.Tx, server int64) ([]userLibraryName, error) {
	rows, err := tx.QueryContext(ctx, `SELECT external_id,coalesce(internal_id,''),name FROM media_libraries WHERE server_id=? ORDER BY name COLLATE NOCASE,id`, server)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	list := []userLibraryName{}
	for rows.Next() {
		var library userLibraryName
		if err := rows.Scan(&library.ExternalID, &library.InternalID, &library.Name); err != nil {
			return nil, err
		}
		list = append(list, library)
	}
	return list, rows.Err()
}

// userLibraryDisplayNames turns an account's library grant into display
// names from its own server only. An all-libraries grant shows every library;
// a granted ID with no stored library keeps a visible placeholder instead of
// being dropped or shown as a bare number.
func userLibraryDisplayNames(libraries []userLibraryName, ids []string, all bool) []string {
	names := []string{}
	if all {
		for _, library := range libraries {
			names = append(names, library.Name)
		}
		return names
	}
	for _, id := range ids {
		name := ""
		for _, library := range libraries {
			if library.ExternalID == id {
				name = library.Name
				break
			}
		}
		if name == "" {
			for _, library := range libraries {
				if library.InternalID != "" && library.InternalID == id {
					name = library.Name
					break
				}
			}
		}
		if name == "" {
			name = fmt.Sprintf("Library %s (name unavailable)", id)
		}
		names = append(names, name)
	}
	return names
}
