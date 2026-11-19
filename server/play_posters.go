package main

import (
	"context"
	"database/sql"
	"errors"
	"time"
)

// The one poster link for a play, used wherever plays are shown (activity
// statistics, history tables, recent and last plays). The title's poster from
// the library catalogue comes first: it is the one the library pages show and
// stays current when the server replaces its artwork or the item. A title not
// catalogued yet, or catalogued without a poster, falls back to the poster
// reference stored with the play; with neither there is no poster. Every link
// is signed for the session and rechecked by its image route on each fetch.

// playPoster is what a play knows about its poster.
type playPoster struct {
	server       int64
	item, parent string // the played item and its show or album (server IDs)
	art          string // the item the play's stored poster came from
	row          int64  // the play's row, for its stored poster
	imported     bool   // the row is an imported play rather than MUM's
	stored       bool   // the play kept a poster reference
}

func (a *App) playPosterURL(ctx context.Context, tx *sql.Tx, session string, p playPoster, now time.Time) (string, error) {
	if p.server != 0 {
		link, err := readServerPlayLink(ctx, tx, p.server, &serverAccountPlay{item: p.item, parent: p.parent, poster: p.art})
		if err != nil {
			return "", err
		}
		if link != nil {
			var thumb bool
			err := tx.QueryRowContext(ctx, `SELECT coalesce(thumb_path,'')<>'' FROM media_items WHERE id=?`, link.Media).Scan(&thumb)
			if err != nil && !errors.Is(err, sql.ErrNoRows) {
				return "", err
			}
			if thumb {
				return a.catalogueImageURL(session, link.Media, now), nil
			}
		}
	}
	switch {
	case !p.stored:
		return "", nil
	case p.imported:
		return a.signedImageURL(importedHistoryPosterPurpose, "/api/activity/imported-history-images", session, p.row, now), nil
	default:
		return a.signedImageURL(activityHistoryPosterPurpose, "/api/activity/history-images", session, p.row, now), nil
	}
}
