package main

import (
	"context"
	"database/sql"
)

// A catalogue item's play summary for its Overview: every play on its server,
// from MUM's recordings and the server's imported history, as the server's
// Libraries page counts a library's plays. A movie counts its own plays, a
// show its episodes' and an album its tracks' (attributed as the item's
// stream count is); an episode counts its own. Imported plays are matched by
// the played item, so a show's imported plays need its episodes catalogued.
// Watch time comes only from MUM's recordings; imported history has none.
// People are counted once across both kinds of play.

type catalogueItemPlays struct {
	Plays        int64   `json:"plays"`
	Recorded     int64   `json:"recorded_plays"`
	Imported     int64   `json:"imported_plays"`
	WatchSeconds int64   `json:"watch_seconds"`
	Viewers      int64   `json:"viewers"`
	LastPlayedAt *string `json:"last_played_at"`
	LastTitle    *string `json:"last_played_title"`
	LastViewer   *string `json:"last_viewer"`
}

// readCatalogueItemPlays summarises the plays of a top-level item (episode
// false) or of one episode (episode true). library is the item's library ID,
// used to find a top-level item's catalogued children.
func readCatalogueItemPlays(ctx context.Context, tx *sql.Tx, server, library int64, external string, episode bool) (catalogueItemPlays, error) {
	mumWhere := `h.server_id=? AND (h.parent_item_id=? OR (h.parent_item_id IS NULL AND h.item_id=?))`
	importedWhere := `i.server_id=? AND (i.item_id=? OR i.item_id IN (SELECT c.external_id FROM media_items c WHERE c.library_id=? AND c.parent_id=?))`
	mumArgs := []any{server, external, external}
	importedArgs := []any{server, external, library, external}
	if episode {
		mumWhere, mumArgs = `h.server_id=? AND h.item_id=?`, []any{server, external}
		importedWhere, importedArgs = `i.server_id=? AND i.item_id=?`, []any{server, external}
	}
	plays := `SELECT 'mum' AS source,coalesce(h.owner_uuid,h.service_uuid) AS person,h.first_seen_at AS at,` + mumWatchedSeconds + ` AS secs,h.title AS title
	 FROM media_activity_history h WHERE ` + mumWhere + `
	 UNION ALL
	 SELECT 'imported',` + timelineImportedPerson + `,i.viewed_at,0,coalesce(i.title,'')
	 FROM history_imports i LEFT JOIN service_accounts s ON s.server_id=i.server_id AND s.external_user_id=i.account_id WHERE ` + importedWhere
	args := append(append([]any{}, mumArgs...), importedArgs...)

	var out catalogueItemPlays
	if err := tx.QueryRowContext(ctx, `SELECT count(*),coalesce(sum(source='mum'),0),coalesce(sum(source='imported'),0),coalesce(sum(secs),0),count(DISTINCT person) FROM (`+plays+`)`, args...).
		Scan(&out.Plays, &out.Recorded, &out.Imported, &out.WatchSeconds, &out.Viewers); err != nil {
		return out, err
	}
	if out.Plays == 0 {
		return out, nil
	}
	var at, title string
	var person sql.NullString
	err := tx.QueryRowContext(ctx, `SELECT p.at,p.title,`+timelinePersonName("p.person")+` FROM (`+plays+`) p ORDER BY julianday(p.at) DESC,p.source='mum' DESC LIMIT 1`, args...).Scan(&at, &title, &person)
	if err != nil {
		return out, err
	}
	out.LastPlayedAt = &at
	if title != "" {
		out.LastTitle = &title
	}
	if person.Valid && person.String != "" && person.String != "Unknown" {
		out.LastViewer = &person.String
	}
	return out, nil
}
