package main

import (
	"context"
	"database/sql"
	"errors"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"time"
)

// The dashboard's Activity card and a server's Overview: statistics across
// every server type, or on
// one chosen server. Each server has one source, so nothing is counted twice:
// MUM's recordings for the servers it monitors (Plex, Jellyfin, Emby), the
// imported history for servers it can only import from (Audiobookshelf), and
// nothing for servers that report no activity (Kavita, Komga, RomM), which are
// named so the card can say so. Every title names its server, and the reply
// lists the servers that report, for the card's server picker.
//
// Cards: most watched and most popular (by people) movies and shows, most
// played and most popular albums, most listened audiobooks, recently played,
// most active users and most active libraries, ranked by plays or by time.

// monitoredActivity are the server types MUM records itself.
var monitoredActivity = []string{"plex", "jellyfin", "emby", "tofa"}

// importedActivity are the server types whose activity comes from imported history.
func importedActivity() []string {
	var kinds []string
	for _, kind := range importableHistory {
		if !slices.Contains(monitoredActivity, kind) {
			kinds = append(kinds, kind)
		}
	}
	return kinds
}

// sqlList quotes fixed server type names for an IN list.
func sqlList(kinds []string) string {
	if len(kinds) == 0 {
		return "''"
	}
	quoted := make([]string, len(kinds))
	for i, kind := range kinds {
		quoted[i] = "'" + strings.ReplaceAll(kind, "'", "''") + "'"
	}
	return strings.Join(quoted, ",")
}

// maxActivityDays is the longest period the cards can be asked for.
const maxActivityDays = 3650

type activityTitle struct {
	Server       int64   `json:"server_id"` // 0 for a user, who may play on several servers
	Title        string  `json:"title"`
	Subtitle     *string `json:"subtitle"`
	Plays        int64   `json:"plays"`
	Seconds      int64   `json:"seconds"`
	People       int64   `json:"people"`
	PosterURL    *string `json:"poster_url"`
	NotInLibrary bool    `json:"not_in_library"`
	PlayedAt     *string `json:"played_at"`    // recently played: when; users: their latest play
	UserUUID     *string `json:"user_uuid"`    // users: their profile, when known
	LibraryID    *int64  `json:"library_id"`   // libraries
	LibraryType  *string `json:"library_type"` // libraries
	AvatarURL    *string `json:"avatar_url"`   // users: a picture from their server account
	UserName     *string `json:"user_name"`    // recently played: who played it
	// Titles: the page in the library catalogue, when the item has been
	// catalogued (a sync has run). Users: the servers they played on, most
	// first, for the card's server badge.
	Link     *serverAccountLink `json:"link"`
	Servers  []int64            `json:"server_ids"`
	poster   sql.NullInt64
	imported bool
	item     string // the played item, or for users the person
	parent   string // the show or album
	art      string // the item the poster was taken from
}

type activitySection struct {
	Kind  string          `json:"kind"`
	Items []activityTitle `json:"items"`
}

func (a *App) activityStatistics(w http.ResponseWriter, r *http.Request) {
	p, ok := a.principal(w, r, true)
	if !ok {
		return
	}
	// days=0 is all time; up to about ten years can be asked for. imported=1
	// adds a monitored server's imported history from before MUM's first
	// recording on it.
	days, server, order, withImported := 7, int64(0), "plays", false
	for key, values := range r.URL.Query() {
		valid := len(values) == 1
		if key == "order" {
			valid = valid && (values[0] == "plays" || values[0] == "duration")
			order = values[0]
		} else if key == "imported" {
			valid = valid && (values[0] == "0" || values[0] == "1")
			withImported = values[0] == "1"
		} else {
			value, err := strconv.ParseInt(values[0], 10, 64)
			valid = valid && err == nil
			switch key {
			case "days":
				valid = valid && value >= 0 && value <= maxActivityDays
				days = int(value)
			case "server":
				valid = valid && value >= 1
				server = value
			default:
				valid = false
			}
		}
		if !valid {
			fail(w, 400, "INVALID_STATISTICS_QUERY", "Use days=0 (all time) or 1â€“3650, optionally server=<a server that reports activity>, order=plays or duration and imported=0 or 1")
			return
		}
	}
	ctx := r.Context()
	tx, err := a.store.beginActivityView(ctx, p.UUID, bearer(r), true)
	if err != nil {
		domainError(w, err)
		return
	}
	defer tx.Rollback()
	imported := sqlList(importedActivity())
	monitored := sqlList(monitoredActivity)
	if server != 0 {
		var kind string
		err := tx.QueryRowContext(ctx, "SELECT service_type FROM media_servers WHERE id=?", server).Scan(&kind)
		if errors.Is(err, sql.ErrNoRows) {
			domainError(w, ErrNotFound)
			return
		} else if err != nil {
			domainError(w, err)
			return
		}
		if !slices.Contains(monitoredActivity, kind) && !slices.Contains(importedActivity(), kind) {
			fail(w, 400, "INVALID_STATISTICS_QUERY", "This server doesn't report activity")
			return
		}
	}
	since := ""
	if days > 0 {
		since = utcTimestamp(time.Now().AddDate(0, 0, -days))
	}
	// The plays the cards count for monitored servers: MUM's recordings, and
	// with imported history each server's imported plays from before MUM first
	// recorded on it, so no play is counted twice. Imported plays fill the same
	// columns: an episode under its show, no length (first and last seen are
	// the same moment), no platform, and a negative ID so its poster is signed
	// as an imported one.
	history := "media_activity_history"
	if withImported {
		history = `(SELECT id,server_id,item_id,media_type,title,parent_title,parent_item_id,poster_path,poster_item,owner_uuid,service_uuid,
		  first_seen_at,last_seen_at,paused_seconds,duration_ticks,platform,library_name FROM media_activity_history
		 UNION ALL SELECT -im.rowid,im.server_id,coalesce(im.item_id,''),coalesce(im.media_type,''),coalesce(im.title,''),
		  CASE WHEN lower(im.media_type)='episode' THEN coalesce(im.grandparent_title,im.parent_title) ELSE im.parent_title END,NULL,im.poster_path,im.poster_item,
		  (SELECT l.user_uuid FROM service_links l WHERE l.service_uuid=sa.uuid AND l.link_kind='owner'),coalesce(sa.uuid,'import:'||im.server_id||':'||im.account_id),
		  im.viewed_at,im.viewed_at,0,NULL,NULL,(SELECT l.name FROM media_libraries l WHERE l.server_id=im.server_id AND l.external_id=im.library_id)
		  FROM history_imports im JOIN media_servers s ON s.id=im.server_id LEFT JOIN service_accounts sa ON sa.server_id=im.server_id AND sa.external_user_id=im.account_id
		  WHERE s.service_type IN (` + monitored + `) AND im.viewed_at<coalesce((SELECT min(h0.first_seen_at) FROM media_activity_history h0 WHERE h0.server_id=im.server_id),'9999'))`
	}
	// Each filter takes the window start and the server (0 for every server) twice.
	recordedWhere := ` h.first_seen_at>=? AND (?=0 OR h.server_id=?)`
	importedFrom := ` FROM history_imports im JOIN media_servers s ON s.id=im.server_id WHERE im.viewed_at>=? AND (?=0 OR im.server_id=?) AND s.service_type IN (` + imported + `)`
	window := []any{since, server, server}
	args := func(sets int) []any {
		out := []any{}
		for range sets {
			out = append(out, window...)
		}
		return out
	}
	// The person behind an imported play: the linked MUM account, else the
	// server account, else the server's account ID.
	importedPerson := `coalesce((SELECT l.user_uuid FROM service_links l WHERE l.service_uuid=sa.uuid AND l.link_kind='owner'),sa.uuid,'import:'||im.server_id||':'||im.account_id)`
	// A person's name: their MUM account, else their server account.
	personName := func(person, fallback string) string {
		return `coalesce((SELECT u.local_username FROM user_accounts u WHERE u.uuid=` + person + `),(SELECT a.external_username FROM service_accounts a WHERE a.uuid=` + person + `),` + fallback + `)`
	}
	importedPeople := ` FROM history_imports im JOIN media_servers s ON s.id=im.server_id LEFT JOIN service_accounts sa ON sa.server_id=im.server_id AND sa.external_user_id=im.account_id
	 WHERE im.viewed_at>=? AND (?=0 OR im.server_id=?) AND s.service_type IN (` + imported + `)`

	var totals struct{ plays, seconds, people, titles int64 }
	err = tx.QueryRowContext(ctx, `SELECT
	 (SELECT count(*) FROM `+history+` h WHERE`+recordedWhere+`)+(SELECT count(*)`+importedFrom+`),
	 (SELECT coalesce(sum(`+mumWatchedSeconds+`),0) FROM `+history+` h WHERE`+recordedWhere+`)+(SELECT coalesce(sum(im.listened_seconds),0)`+importedFrom+`),
	 (SELECT count(DISTINCT h.server_id||':'||h.item_id) FROM `+history+` h WHERE`+recordedWhere+`)+(SELECT count(DISTINCT im.server_id||':'||coalesce(im.item_id,im.title))`+importedFrom+`),
	 (SELECT count(DISTINCT person) FROM (
	  SELECT coalesce(h.owner_uuid,h.service_uuid) AS person FROM `+history+` h WHERE`+recordedWhere+`
	  UNION SELECT `+importedPerson+importedPeople+`))`,
		args(8)...).Scan(&totals.plays, &totals.seconds, &totals.titles, &totals.people)
	if err != nil {
		domainError(w, err)
		return
	}

	// Every card query returns the same columns: server, title, subtitle,
	// plays, seconds, people, poster row, time, user, library, library type,
	// whether the poster row is an imported one, the played item, its show or
	// album, the item its poster came from, and who played it.
	rank := map[string]string{"plays": "plays DESC,secs DESC", "duration": "secs DESC,plays DESC"}[order]
	recorded := func(where, key, title, item, parent string, popular bool) string {
		ranking := rank
		if popular {
			ranking = "people DESC,plays DESC"
		}
		return `SELECT h.server_id,` + title + `,NULL,count(*) AS plays,coalesce(sum(` + mumWatchedSeconds + `),0) AS secs,count(DISTINCT coalesce(h.owner_uuid,h.service_uuid)) AS people,
		 coalesce(max(CASE WHEN h.poster_path IS NOT NULL THEN h.id END),max(h.id)),NULL,NULL,NULL,NULL,0,` + item + `,` + parent + `,coalesce(max(h.poster_item),''),NULL
		 FROM ` + history + ` h WHERE` + recordedWhere + ` AND ` + where + ` GROUP BY h.server_id,` + key + `
		 ORDER BY ` + ranking + `,2 LIMIT 10`
	}
	// Every play with its person and server, from both sources.
	people := `SELECT coalesce(h.owner_uuid,h.service_uuid) AS person,h.server_id AS server,NULL AS fallback,` + mumWatchedSeconds + ` AS secs,h.first_seen_at AS at FROM ` + history + ` h WHERE` + recordedWhere + `
	  UNION ALL SELECT ` + importedPerson + `,im.server_id,im.account_id,coalesce(im.listened_seconds,0),im.viewed_at` + importedPeople
	movies, episodes, tracks := `lower(h.media_type)='movie'`, `lower(h.media_type)='episode'`, `lower(h.media_type) IN ('track','audio')`
	series, album := `coalesce(max(h.parent_title),min(h.title))`, `coalesce(h.parent_item_id,h.item_id)`
	if withImported {
		album = `lower(coalesce(h.parent_title,h.title))`
	}
	// A show's or album's page comes from its recorded ID.
	albumPage := `coalesce(max(h.parent_item_id),'')`
	queries := []struct {
		kind, query string
		sets        int
	}{
		{"movies", recorded(movies, `h.item_id`, `min(h.title)`, `h.item_id`, `''`, false), 1},
		{"popular_movies", recorded(movies, `h.item_id`, `min(h.title)`, `h.item_id`, `''`, true), 1},
		{"shows", recorded(episodes, album, series, `''`, albumPage, false), 1},
		{"popular_shows", recorded(episodes, album, series, `''`, albumPage, true), 1},
		{"music", recorded(tracks, album, series, `''`, albumPage, false), 1},
		{"popular_music", recorded(tracks, album, series, `''`, albumPage, true), 1},
		{"audiobooks", `SELECT im.server_id,min(coalesce(im.title,'')),max(coalesce(im.grandparent_title,im.parent_title)),count(*) AS plays,coalesce(sum(im.listened_seconds),0) AS secs,count(DISTINCT im.account_id) AS people,
		 coalesce(max(CASE WHEN im.poster_path IS NOT NULL THEN im.rowid END),max(im.rowid)),NULL,NULL,NULL,NULL,1,coalesce(max(im.item_id),''),'',coalesce(max(im.poster_item),''),NULL` +
			importedFrom + ` GROUP BY im.server_id,coalesce(im.item_id,im.title) ORDER BY ` + rank + `,2 LIMIT 10`, 1},
		// The latest plays: an episode shows its series with the episode beneath.
		{"recent", `SELECT * FROM (
		 SELECT h.server_id,CASE WHEN lower(h.media_type)='episode' AND h.parent_title IS NOT NULL THEN h.parent_title ELSE h.title END,
		  CASE WHEN lower(h.media_type)='episode' AND h.parent_title IS NOT NULL THEN h.title END,1,` + mumWatchedSeconds + `,1,h.id,h.first_seen_at,NULL,NULL,NULL,0,
		  h.item_id,coalesce(h.parent_item_id,''),coalesce(h.poster_item,''),` + personName(`coalesce(h.owner_uuid,h.service_uuid)`, `NULL`) + `
		  FROM ` + history + ` h WHERE` + recordedWhere + `
		 UNION ALL SELECT im.server_id,coalesce(im.title,''),coalesce(im.grandparent_title,im.parent_title),1,coalesce(im.listened_seconds,0),1,im.rowid,im.viewed_at,NULL,NULL,NULL,1,
		  coalesce(im.item_id,''),'',coalesce(im.poster_item,''),` + personName(importedPerson, `im.account_id`) + importedPeople + `)
		 ORDER BY 8 DESC LIMIT 10`, 2},
		// A person once across both sources, named by their MUM or server account.
		{"users", `SELECT 0,` + personName(`x.person`, `coalesce(max(x.fallback),'Unknown')`) + `,
		 NULL,count(*) AS plays,coalesce(sum(x.secs),0) AS secs,1,NULL,max(x.at),CASE WHEN x.person NOT LIKE 'import:%' THEN x.person END,NULL,NULL,0,x.person,'','',NULL
		 FROM (` + people + `) x GROUP BY x.person ORDER BY ` + rank + `,2 LIMIT 10`, 2},
		// A recorded play belongs to the library whose catalogue holds its item or
		// series, else the uniquely named library it recorded; an imported play
		// to its server library ID.
		{"libraries", `SELECT l.server_id,l.name,(SELECT s2.server_nickname FROM media_servers s2 WHERE s2.id=l.server_id),count(*) AS plays,coalesce(sum(x.secs),0) AS secs,1,NULL,NULL,NULL,l.id,l.library_type,0,'','','',NULL
		 FROM (SELECT ` + mumWatchedSeconds + ` AS secs,coalesce(
		   (SELECT i.library_id FROM media_items i WHERE i.server_id=h.server_id AND i.parent_id IS NULL AND i.external_id=coalesce(h.parent_item_id,h.item_id) ORDER BY i.id LIMIT 1),
		   (SELECT min(l2.id) FROM media_libraries l2 WHERE l2.server_id=h.server_id AND l2.name=h.library_name HAVING count(*)=1)) AS lib
		   FROM ` + history + ` h WHERE` + recordedWhere + `
		  UNION ALL SELECT coalesce(im.listened_seconds,0),(SELECT l3.id FROM media_libraries l3 WHERE l3.server_id=im.server_id AND l3.external_id=im.library_id)` + importedFrom + `) x
		 JOIN media_libraries l ON l.id=x.lib GROUP BY l.id ORDER BY ` + rank + `,2 LIMIT 10`, 2},
	}
	sections := []activitySection{}
	for _, q := range queries {
		items, err := readActivityTitles(ctx, tx, q.query, args(q.sets))
		if err != nil {
			domainError(w, err)
			return
		}
		if len(items) > 0 {
			sections = append(sections, activitySection{Kind: q.kind, Items: items})
		}
	}

	// Each person's and platform's servers, most used first, for their badges.
	serverRank := map[string]string{"plays": "count(*) DESC,sum(secs) DESC", "duration": "sum(secs) DESC,count(*) DESC"}[order]
	personServers, err := readActivityServerUse(ctx, tx, `SELECT x.person,x.server FROM (`+people+`) x GROUP BY 1,2 ORDER BY `+serverRank+`,2`, args(2))
	if err != nil {
		domainError(w, err)
		return
	}
	platformServers, err := readActivityServerUse(ctx, tx, `SELECT h.platform,h.server_id FROM (SELECT h.*,`+mumWatchedSeconds+` AS secs FROM `+history+` h) h
	 WHERE`+recordedWhere+` AND h.platform IS NOT NULL AND h.platform<>'' GROUP BY 1,2 ORDER BY `+serverRank+`,2`, window)
	if err != nil {
		domainError(w, err)
		return
	}

	// A user's picture: their own server account's, or for a MUM account the
	// first of its linked server accounts that has one. A title's page in the
	// library catalogue, found as for a server's Users page.
	session, sessionErr := a.requestSession(ctx, r)
	now := time.Now()
	for i := range sections {
		users := sections[i].Kind == "users"
		for j := range sections[i].Items {
			item := &sections[i].Items[j]
			if users {
				if used := personServers[item.item]; used != nil {
					item.Servers = used
				}
				if item.UserUUID == nil || sessionErr != nil {
					continue
				}
				if url, err := a.activityUserAvatar(ctx, tx, *item.UserUUID, session, now); err != nil {
					domainError(w, err)
					return
				} else if url != "" {
					item.AvatarURL = &url
				}
			} else if sections[i].Kind != "libraries" {
				link, err := readServerPlayLink(ctx, tx, item.Server, &serverAccountPlay{item: item.item, parent: item.parent, poster: item.art})
				if err != nil {
					domainError(w, err)
					return
				}
				item.Link = link
				if link == nil {
					item.NotInLibrary, err = activityMissingFromLibrary(ctx, tx, item.Server, item.item, item.parent)
					if err != nil {
						domainError(w, err)
						return
					}
				}
				// The title's poster: the one poster link every play view uses.
				if sessionErr == nil {
					url, err := a.playPosterURL(ctx, tx, session, playPoster{server: item.Server, item: item.item, parent: item.parent, art: item.art,
						row: item.poster.Int64, imported: item.imported, stored: item.poster.Valid}, now)
					if err != nil {
						domainError(w, err)
						return
					}
					if url != "" {
						item.PosterURL = &url
					}
				}
			}
		}
	}

	platforms := []map[string]any{}
	platformRank := map[string]string{"plays": "count(*) DESC", "duration": "sum(" + mumWatchedSeconds + ") DESC"}[order]
	rows, err := tx.QueryContext(ctx, `SELECT h.platform,count(*),coalesce(sum(`+mumWatchedSeconds+`),0) FROM `+history+` h WHERE`+recordedWhere+` AND h.platform IS NOT NULL AND h.platform<>'' GROUP BY h.platform ORDER BY `+platformRank+`,h.platform LIMIT 10`, window...)
	if err != nil {
		domainError(w, err)
		return
	}
	for rows.Next() {
		var name string
		var plays, seconds int64
		if err := rows.Scan(&name, &plays, &seconds); err != nil {
			rows.Close()
			domainError(w, err)
			return
		}
		used := platformServers[name]
		if used == nil {
			used = []int64{}
		}
		platforms = append(platforms, map[string]any{"name": name, "plays": plays, "seconds": seconds, "server_ids": used})
	}
	rows.Close()

	// The most streams playing at once, from MUM's recordings.
	concurrent, err := readConcurrentPeaks(ctx, tx, since, server)
	if err != nil {
		domainError(w, err)
		return
	}

	// Servers that report activity (the picker), those that don't (the note)
	// and those whose figures come from imported history (with the last import).
	servers, err := readActivityServers(ctx, tx, `SELECT s.id,s.server_nickname,s.service_type,NULL FROM media_servers s WHERE s.service_type IN (`+monitored+`,`+imported+`) ORDER BY lower(s.server_nickname),s.id`)
	if err != nil {
		domainError(w, err)
		return
	}
	unreported, err := readActivityServers(ctx, tx, `SELECT s.id,s.server_nickname,s.service_type,NULL FROM media_servers s WHERE s.service_type NOT IN (`+monitored+`) AND s.service_type NOT IN (`+imported+`) ORDER BY lower(s.server_nickname),s.id`)
	if err != nil {
		domainError(w, err)
		return
	}
	importedServers, err := readActivityServers(ctx, tx, `SELECT s.id,s.server_nickname,s.service_type,(SELECT r.finished_at FROM history_import_runs r WHERE r.server_id=s.id AND r.state='completed')
	 FROM media_servers s WHERE s.service_type IN (`+imported+`) AND (?=0 OR s.id=?) ORDER BY lower(s.server_nickname),s.id`, server, server)
	if err != nil {
		domainError(w, err)
		return
	}
	if err := tx.Commit(); err != nil {
		domainError(w, err)
		return
	}

	var chosen any
	if server != 0 {
		chosen = server
	}
	respond(w, 200, map[string]any{
		"days": days, "server_id": chosen, "order": order, "with_imported": withImported,
		"totals":   map[string]any{"plays": totals.plays, "seconds": totals.seconds, "people": totals.people, "titles": totals.titles},
		"sections": sections, "platforms": platforms, "concurrent": concurrent, "servers": servers, "unreported": unreported, "imported": importedServers,
	})
}

// Absence is reported only when history identifies one supported library and
// a complete catalogue sync exists for it; unknown or ambiguous is not missing.
func activityMissingFromLibrary(ctx context.Context, tx *sql.Tx, server int64, item, parent string) (bool, error) {
	if server <= 0 || item == "" && parent == "" {
		return false, nil
	}
	rows, err := tx.QueryContext(ctx, `SELECT l.id,l.catalogue_synced_at,coalesce(l.library_type,''),l.external_id,s.service_type
		FROM media_libraries l JOIN media_servers s ON s.id=l.server_id
		WHERE l.server_id=? AND l.is_available=1 AND (
		l.name IN (SELECT h.library_name FROM media_activity_history h WHERE h.server_id=? AND h.library_name IS NOT NULL AND ((?<>'' AND h.item_id=?) OR (?<>'' AND h.parent_item_id=?)))
		OR l.external_id IN (SELECT i.library_id FROM history_imports i WHERE i.server_id=? AND i.library_id IS NOT NULL AND ((?<>'' AND i.item_id=?) OR (?<>'' AND i.item_id=?)))) LIMIT 2`, server, server, item, item, parent, parent, server, item, item, parent, parent)
	if err != nil {
		return false, err
	}
	type candidate struct {
		id                       int64
		synced                   sql.NullString
		kind, external, provider string
	}
	var found []candidate
	for rows.Next() {
		var c candidate
		if err := rows.Scan(&c.id, &c.synced, &c.kind, &c.external, &c.provider); err != nil {
			rows.Close()
			return false, err
		}
		found = append(found, c)
	}
	if err := errors.Join(rows.Err(), rows.Close()); err != nil {
		return false, err
	}
	if len(found) != 1 || !found[0].synced.Valid || !catalogueLibrarySupported(found[0].provider, found[0].kind, found[0].external) {
		return false, nil
	}
	var exists bool
	err = tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM media_items WHERE library_id=? AND ((?<>'' AND external_id=?) OR (?<>'' AND external_id=?)))`, found[0].id, item, item, parent, parent).Scan(&exists)
	return !exists, err
}

func readActivityTitles(ctx context.Context, tx *sql.Tx, query string, args []any) ([]activityTitle, error) {
	rows, err := tx.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []activityTitle{}
	for rows.Next() {
		var item activityTitle
		var subtitle, at, user, libraryType, name sql.NullString
		var library sql.NullInt64
		var imported int64
		if err := rows.Scan(&item.Server, &item.Title, &subtitle, &item.Plays, &item.Seconds, &item.People, &item.poster, &at, &user, &library, &libraryType, &imported,
			&item.item, &item.parent, &item.art, &name); err != nil {
			return nil, err
		}
		if name.Valid && name.String != "" {
			item.UserName = &name.String
		}
		item.Servers = []int64{}
		if subtitle.Valid && subtitle.String != "" {
			item.Subtitle = &subtitle.String
		}
		if at.Valid {
			item.PlayedAt = &at.String
		}
		if user.Valid && user.String != "" {
			item.UserUUID = &user.String
		}
		if library.Valid {
			item.LibraryID = &library.Int64
		}
		if libraryType.Valid && libraryType.String != "" {
			item.LibraryType = &libraryType.String
		}
		// A negative poster row is an imported play's (see history).
		item.imported = imported == 1
		if item.poster.Valid && item.poster.Int64 < 0 {
			item.poster.Int64, item.imported = -item.poster.Int64, true
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

// readActivityServerUse maps a person or platform to the servers they used,
// in the query's order.
func readActivityServerUse(ctx context.Context, tx *sql.Tx, query string, args []any) (map[string][]int64, error) {
	rows, err := tx.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string][]int64{}
	for rows.Next() {
		var key string
		var server int64
		if err := rows.Scan(&key, &server); err != nil {
			return nil, err
		}
		out[key] = append(out[key], server)
	}
	return out, rows.Err()
}

// readActivityServers lists servers as id, name, type and an optional time
// (the last completed import).
func readActivityServers(ctx context.Context, tx *sql.Tx, query string, args ...any) ([]map[string]any, error) {
	rows, err := tx.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var id int64
		var name, kind string
		var at sql.NullString
		if err := rows.Scan(&id, &name, &kind, &at); err != nil {
			return nil, err
		}
		out = append(out, map[string]any{"server_id": id, "name": name, "service_type": kind, "imported_at": nullableString(at)})
	}
	return out, rows.Err()
}

// activityUserAvatar signs a picture for a person: their own server account,
// else a server account linked to their MUM account, whichever has one first.
func (a *App) activityUserAvatar(ctx context.Context, tx *sql.Tx, person, session string, now time.Time) (string, error) {
	rows, err := tx.QueryContext(ctx, `SELECT i.id,s.service_type,coalesce(sa.external_user_id,''),coalesce(sa.external_avatar_url,'')
	 FROM service_accounts sa JOIN identities i ON i.uuid=sa.uuid JOIN media_servers s ON s.id=sa.server_id
	 WHERE sa.uuid=? OR sa.uuid IN (SELECT l.service_uuid FROM service_links l WHERE l.user_uuid=? AND l.link_kind='owner')
	 ORDER BY sa.uuid=? DESC,i.id`, person, person, person)
	if err != nil {
		return "", err
	}
	defer rows.Close()
	for rows.Next() {
		var identity int64
		var kind, external, avatar string
		if err := rows.Scan(&identity, &kind, &external, &avatar); err != nil {
			return "", err
		}
		if serviceHasAvatar(kind, external, avatar) {
			return a.serviceAvatarURL(session, identity, now), nil
		}
	}
	return "", rows.Err()
}
