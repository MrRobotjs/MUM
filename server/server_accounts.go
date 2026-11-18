package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"slices"
	"strconv"
	"strings"
	"time"
)

// A server's Users page (SERVER_USERS_DESIGN.md): one page of the server's
// accounts with their activity on this server only, for the chosen records:
// all plays, MUM's recorded plays or the server's imported history. Counts and
// the newest play are worked out in SQL, so sorting by plays or last streamed
// covers every page. IP, platform, player and watch time come only from MUM's
// recordings; IP, platform and player are the newest ones known.

var serverAccountSorts = map[string]string{
	"username_asc":       "lower(coalesce(a.external_username,'')),a.uuid",
	"username_desc":      "lower(coalesce(a.external_username,'')) DESC,a.uuid DESC",
	"last_streamed_desc": "last_streamed IS NULL,last_streamed DESC,a.uuid",
	"last_streamed_asc":  "last_streamed IS NULL,last_streamed,a.uuid",
	"plays_desc":         "plays DESC,lower(coalesce(a.external_username,'')),a.uuid",
	"plays_asc":          "plays,lower(coalesce(a.external_username,'')),a.uuid",
	"watch_desc":         "watch IS NULL,watch DESC,lower(coalesce(a.external_username,'')),a.uuid",
	"watch_asc":          "watch IS NULL,watch,lower(coalesce(a.external_username,'')),a.uuid",
}

// Every other column sorts in SQL too, so the order covers every page. Each
// expression matches what the row shows: the newest play's title (MUM wins a
// tie, as below), the newest known IP, platform and player, the library count
// with all libraries highest. Rows without a value come last both ways.
func init() {
	newest := func(column string) string {
		return `CASE WHEN m.account IS NOT NULL THEN (SELECT lower(` + column + `) FROM media_activity_history x WHERE x.server_id=a.server_id AND x.service_uuid=a.uuid AND x.` + column + ` IS NOT NULL ORDER BY x.first_seen_at DESC,x.id DESC LIMIT 1) END`
	}
	columns := map[string]string{
		"email": "lower(nullif(a.external_email,''))",
		"last_played": `CASE WHEN m.last IS NOT NULL AND (h.last IS NULL OR m.last>=h.last)
  THEN (SELECT lower(x.title) FROM media_activity_history x WHERE x.server_id=a.server_id AND x.service_uuid=a.uuid ORDER BY x.first_seen_at DESC,x.id DESC LIMIT 1)
  WHEN h.last IS NOT NULL THEN (SELECT lower(coalesce(x.title,'')) FROM history_imports x WHERE x.server_id=a.server_id AND x.account_id=a.external_user_id ORDER BY x.viewed_at DESC,x.rowid DESC LIMIT 1) END`,
		"last_ip":       newest("ip_address"),
		"last_platform": newest("platform"),
		"last_player":   newest("device_name"),
		"libraries":     `CASE WHEN json_extract(coalesce(a.service_settings,'{}'),'$.all_libraries')=1 THEN 1000000 ELSE json_array_length(coalesce(a.allowed_library_ids,'[]')) END`,
		"expires":       "a.access_expires_at",
	}
	for name, expr := range columns {
		for _, dir := range []string{"asc", "desc"} {
			serverAccountSorts[name+"_"+dir] = "(" + expr + ") IS NULL,(" + expr + ") " + strings.ToUpper(dir) + ",lower(coalesce(a.external_username,'')),a.uuid"
		}
	}
}

type serverAccountPlay struct {
	Title       string  `json:"title"`
	ParentTitle *string `json:"parent_title"`
	Kind        string  `json:"media_type"`
	Source      string  `json:"source"` // "mum" or the server's type
	at          string
}

func (a *App) serverAccounts(w http.ResponseWriter, r *http.Request) {
	actor, ok := a.principal(w, r, true)
	if !ok {
		return
	}
	server, ok := pathID(w, r, "server")
	if !ok {
		return
	}
	records, search, sort, page, size := "all", "", "username_asc", 1, 100
	values, err := url.ParseQuery(r.URL.RawQuery)
	valid := err == nil
	for key, list := range values {
		if !valid || len(list) != 1 {
			valid = false
			break
		}
		v := list[0]
		switch key {
		case "records":
			valid = v == "all" || v == "mum" || v == "server"
			records = v
		case "search":
			valid = len([]rune(v)) <= 200
			search = strings.TrimSpace(v)
		case "sort":
			_, valid = serverAccountSorts[v]
			sort = v
		case "page":
			page, err = strconv.Atoi(v)
			valid = err == nil && page >= 1 && page <= 100000
		case "page_size":
			size, err = strconv.Atoi(v)
			valid = err == nil && size >= 1 && size <= 200
		default:
			valid = false
		}
	}
	if !valid {
		fail(w, 400, "INVALID_SERVER_ACCOUNTS_QUERY", "Use records all/mum/server, a known sort, a search of up to 200 characters, a page and a page size of 1 to 200")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	tx, err := a.store.reader.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		domainError(w, err)
		return
	}
	defer tx.Rollback()
	if err := accountPreferenceAuthority(ctx, tx, actor.UUID, bearer(r)); err != nil {
		domainError(w, err)
		return
	}
	if err := requirePermission(ctx, tx, actor.UUID, "administrator"); err != nil {
		domainError(w, err)
		return
	}
	var kind, name string
	if err := tx.QueryRowContext(ctx, "SELECT service_type,server_nickname FROM media_servers WHERE id=?", server).Scan(&kind, &name); errors.Is(err, sql.ErrNoRows) {
		domainError(w, ErrNotFound)
		return
	} else if err != nil {
		domainError(w, err)
		return
	}
	live := kind == "plex" || kind == "jellyfin" || kind == "emby"
	withMUM, withImported := live && records != "server", records != "mum" && slices.Contains(importableHistory, kind)

	where := " WHERE a.server_id=? AND a.removed_at IS NULL"
	args := []any{server}
	if search != "" {
		escaped := strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace(strings.ToLower(search))
		where += ` AND lower(coalesce(a.external_username,'')||' '||coalesce(a.external_email,'')) LIKE ? ESCAPE '\'`
		args = append(args, "%"+escaped+"%")
	}
	from := `
 FROM service_accounts a JOIN identities i ON i.uuid=a.uuid
 LEFT JOIN service_links owner ON owner.service_uuid=a.uuid AND owner.link_kind='owner'
 LEFT JOIN user_accounts parent ON parent.uuid=owner.user_uuid
 LEFT JOIN (SELECT h.service_uuid AS account,count(*) AS plays,sum(` + mumWatchedSeconds + `) AS secs,max(h.first_seen_at) AS last
  FROM media_activity_history h WHERE h.server_id=? GROUP BY h.service_uuid) m ON m.account=a.uuid AND ?
 LEFT JOIN (SELECT s.uuid AS account,count(*) AS plays,max(im.viewed_at) AS last
  FROM history_imports im JOIN service_accounts s ON s.server_id=im.server_id AND s.external_user_id=im.account_id WHERE im.server_id=? GROUP BY s.uuid) h ON h.account=a.uuid AND ?`
	fromArgs := []any{server, withMUM, server, withImported}
	var total int
	if err := tx.QueryRowContext(ctx, "SELECT count(*)"+from+where, append(append([]any{}, fromArgs...), args...)...).Scan(&total); err != nil {
		domainError(w, err)
		return
	}
	query := `SELECT a.uuid,i.id,coalesce(a.external_username,''),coalesce(a.external_email,''),a.is_active,coalesce(a.allowed_library_ids,'[]'),coalesce(a.service_settings,'{}'),
 a.access_expires_at,coalesce(a.external_user_id,''),coalesce(a.external_avatar_url,''),coalesce(parent.uuid,''),coalesce(parent.local_username,''),
 coalesce(m.plays,0)+coalesce(h.plays,0) AS plays,CASE WHEN ? THEN coalesce(m.secs,0) END AS watch,
 CASE WHEN m.last IS NULL THEN h.last WHEN h.last IS NULL OR m.last>=h.last THEN m.last ELSE h.last END AS last_streamed` +
		from + where + " ORDER BY " + serverAccountSorts[sort] + " LIMIT ? OFFSET ?"
	queryArgs := append(append(append([]any{withMUM}, fromArgs...), args...), size, (page-1)*size)
	rows, err := tx.QueryContext(ctx, query, queryArgs...)
	if err != nil {
		domainError(w, err)
		return
	}
	type row struct {
		item                         map[string]any
		uuid, external, avatar, kind string
		identity                     int64
		libraryIDs                   []string
		allLibraries                 bool
	}
	var listed []row
	for rows.Next() {
		var r row
		var username, email, libraries, settings, parentUUID, parentName string
		var active bool
		var expires, last sql.NullString
		var plays int
		var watch sql.NullInt64
		if err := rows.Scan(&r.uuid, &r.identity, &username, &email, &active, &libraries, &settings, &expires, &r.external, &r.avatar, &parentUUID, &parentName, &plays, &watch, &last); err != nil {
			rows.Close()
			domainError(w, err)
			return
		}
		var policy map[string]any
		if json.Unmarshal([]byte(libraries), &r.libraryIDs) != nil || json.Unmarshal([]byte(settings), &policy) != nil {
			rows.Close()
			domainError(w, errors.New("invalid stored account policy"))
			return
		}
		r.allLibraries = policy["all_libraries"] == true
		r.kind = kind
		item := map[string]any{"uuid": r.uuid, "username": username, "email": nullableText(email), "is_active": active, "access_expires_at": nullableString(expires),
			"plays": plays, "watch_seconds": nil, "last_streamed_at": nullableString(last), "last_played": nil, "last_ip": nil, "last_platform": nil, "last_player": nil,
			"linked_profile": nil, "libraries": []string{}, "has_all_libraries": r.allLibraries}
		if watch.Valid {
			item["watch_seconds"] = watch.Int64
		}
		if parentUUID != "" {
			item["linked_profile"] = map[string]any{"uuid": parentUUID, "name": parentName}
		}
		r.item = item
		listed = append(listed, r)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		domainError(w, err)
		return
	}
	// The page's details: the newest play, the newest known IP, platform and
	// player, library names and picture links.
	libraryNames, err := readUserLibraryNames(ctx, tx, server)
	if err != nil {
		domainError(w, err)
		return
	}
	session, sessionErr := a.requestSession(ctx, r)
	now := time.Now()
	items := []map[string]any{}
	for _, r := range listed {
		var newest *serverAccountPlay
		if withMUM {
			if play, err := readServerAccountPlay(ctx, tx, `SELECT title,parent_title,media_type,first_seen_at FROM media_activity_history WHERE server_id=? AND service_uuid=? ORDER BY first_seen_at DESC,id DESC LIMIT 1`, server, r.uuid); err != nil {
				domainError(w, err)
				return
			} else if play != nil {
				play.Source, newest = "mum", play
			}
			for column, key := range map[string]string{"ip_address": "last_ip", "platform": "last_platform", "device_name": "last_player"} {
				var value string
				err := tx.QueryRowContext(ctx, `SELECT `+column+` FROM media_activity_history WHERE server_id=? AND service_uuid=? AND `+column+` IS NOT NULL ORDER BY first_seen_at DESC,id DESC LIMIT 1`, server, r.uuid).Scan(&value)
				if err == nil {
					r.item[key] = value
				} else if !errors.Is(err, sql.ErrNoRows) {
					domainError(w, err)
					return
				}
			}
		}
		if withImported {
			play, err := readServerAccountPlay(ctx, tx, `SELECT coalesce(title,''),coalesce(grandparent_title,parent_title),coalesce(media_type,''),viewed_at FROM history_imports WHERE server_id=? AND account_id=? ORDER BY viewed_at DESC,rowid DESC LIMIT 1`, server, r.external)
			if err != nil {
				domainError(w, err)
				return
			}
			if play != nil && (newest == nil || play.at > newest.at) {
				play.Source, newest = kind, play
			}
		}
		if newest != nil {
			r.item["last_played"] = newest
		}
		r.item["libraries"] = userLibraryDisplayNames(libraryNames, r.libraryIDs, r.allLibraries)
		if sessionErr == nil && serviceHasAvatar(kind, r.external, r.avatar) {
			r.item["avatar_url"] = a.serviceAvatarURL(session, r.identity, now)
		}
		items = append(items, r.item)
	}
	if err := tx.Commit(); err != nil {
		domainError(w, err)
		return
	}
	respond(w, 200, map[string]any{"server_id": server, "server_name": name, "service_type": kind, "live": live, "records": records, "items": items,
		"page": page, "page_size": size, "total_items": total, "total_pages": (total + size - 1) / size})
}

func readServerAccountPlay(ctx context.Context, tx *sql.Tx, query string, args ...any) (*serverAccountPlay, error) {
	var play serverAccountPlay
	var parent sql.NullString
	err := tx.QueryRowContext(ctx, query, args...).Scan(&play.Title, &parent, &play.Kind, &play.at)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if parent.Valid && parent.String != "" {
		play.ParentTitle = &parent.String
	}
	return &play, nil
}
