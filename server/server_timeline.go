package main

import (
	"cmp"
	"context"
	"database/sql"
	"net/http"
	"net/url"
	"slices"
	"strconv"
	"strings"
	"time"
)

// A server's play history for its History tab and the History page: every
// person's plays on one server at a time, newest first, with the same records,
// type and stream filters as a person's History tab, and an optional person.
// Administrators only. The reply lists the servers (for the History page's
// picker) and the people who played on the server shown (for the person
// picker).

type timelinePerson struct {
	UUID string `json:"uuid"`
	Name string `json:"name"`
}

func (a *App) serverTimeline(w http.ResponseWriter, r *http.Request) {
	actor, ok := a.principal(w, r, false)
	if !ok {
		return
	}
	q := activityReadQuery{History: true, All: true}
	filter := timelineFilter{Records: "all"}
	cursor := timelineCursor{At: "9999", Source: "p", ID: 1 << 62}
	values, err := url.ParseQuery(r.URL.RawQuery)
	valid := err == nil
	allServers := false
	for key, list := range values {
		if !valid || len(list) != 1 {
			valid = false
			break
		}
		switch key {
		case "server":
			if list[0] == "all" {
				allServers = true
				break
			}
			id, err := strconv.ParseInt(list[0], 10, 64)
			valid = err == nil && id > 0 && strconv.FormatInt(id, 10) == list[0]
			filter.Server = id
		case "user":
			valid = validAdminMemberCursor(list[0])
			q.Target = list[0]
		case "records":
			valid = list[0] == "all" || list[0] == "mum" || list[0] == "server"
			filter.Records = list[0]
		case "types":
			filter.Types, valid = parseTimelineList(list[0], timelineCategories)
		case "methods":
			filter.Methods, valid = parseTimelineList(list[0], []string{"direct_play", "direct_stream", "transcode"})
		case "before":
			cursor, valid = parseTimelineCursor(list[0])
		default:
			valid = false
		}
	}
	if !valid {
		fail(w, 400, "INVALID_TIMELINE_QUERY", "Use a server ID, optionally a person, records all/mum/server, known types and stream methods, and a cursor from the previous page")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	tx, err := a.store.beginActivityView(ctx, actor.UUID, bearer(r), true)
	if err != nil {
		domainError(w, err)
		return
	}
	defer tx.Rollback()
	if err := checkActivityTarget(ctx, tx, actor.UUID, q); err != nil {
		domainError(w, err)
		return
	}
	servers, err := readAllTimelineServers(ctx, tx)
	if err != nil {
		domainError(w, err)
		return
	}
	// The server shown: the one asked for, else the one with the newest play,
	// else the first by name that has history.
	var shown *timelineServer
	if allServers {
		shown = &timelineServer{ID: "all", Name: "All Servers", Live: true, History: true}
	}
	for i := range servers {
		if allServers {
			break
		}
		if filter.Server != 0 {
			if servers[i].id == filter.Server {
				shown = &servers[i]
			}
		} else if servers[i].History && (shown == nil || servers[i].newest > shown.newest) {
			shown = &servers[i]
		}
	}
	if filter.Server != 0 && shown == nil {
		domainError(w, ErrNotFound)
		return
	}
	var serverID *string
	people := []timelinePerson{}
	if shown != nil {
		serverID = &shown.ID
		if people, err = readTimelinePeople(ctx, tx, shown.id); err != nil {
			domainError(w, err)
			return
		}
	}
	items, categories, next, err := readTimelinePage(ctx, tx, actor.UUID, q, cursor, filter, shown)
	if err == nil {
		err = a.signTimelinePosters(ctx, tx, actor.UUID, bearer(r), items)
	}
	if err == nil {
		err = tx.Commit()
	}
	if err != nil {
		domainError(w, err)
		return
	}
	// Authority is checked again right before delivery, as for a person's history.
	check, err := a.store.beginActivityView(ctx, actor.UUID, bearer(r), true)
	if err == nil {
		err = checkActivityTarget(ctx, check, actor.UUID, q)
		check.Rollback()
	}
	if err != nil {
		domainError(w, err)
		return
	}
	var user *string
	if q.Target != "" {
		user = &q.Target
	}
	respond(w, 200, map[string]any{"actor_uuid": actor.UUID, "user": user, "server_id": serverID, "records": filter.Records,
		"servers": servers, "categories": categories, "people": people, "items": items, "next_before": next})
}

// readAllTimelineServers lists every server by name, with the time of its
// newest play.
func readAllTimelineServers(ctx context.Context, tx *sql.Tx) ([]timelineServer, error) {
	rows, err := tx.QueryContext(ctx, `SELECT ms.id,ms.server_nickname,ms.service_type,
	 max(coalesce((SELECT max(h.first_seen_at) FROM media_activity_history h WHERE h.server_id=ms.id),''),coalesce((SELECT max(i.viewed_at) FROM history_imports i WHERE i.server_id=ms.id),''))
	 FROM media_servers ms ORDER BY ms.server_nickname COLLATE NOCASE,ms.id LIMIT 1000`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	servers := []timelineServer{}
	for rows.Next() {
		var server timelineServer
		if err := rows.Scan(&server.id, &server.Name, &server.Type, &server.newest); err != nil {
			return nil, err
		}
		server.ID = strconv.FormatInt(server.id, 10)
		server.Live = slices.Contains(monitoredActivity, server.Type)
		server.History = server.Live || slices.Contains(importableHistory, server.Type)
		servers = append(servers, server)
	}
	return servers, rows.Err()
}

// readTimelinePeople lists, by name, the people with a play on the server,
// recorded or imported, each once.
func readTimelinePeople(ctx context.Context, tx *sql.Tx, server int64) ([]timelinePerson, error) {
	rows, err := tx.QueryContext(ctx, `SELECT person,coalesce(min(nullif(name,'Unknown')),'Unknown') FROM (
	 SELECT coalesce(h.owner_uuid,h.service_uuid) AS person,`+timelinePersonNameForService("coalesce(h.owner_uuid,h.service_uuid)", "h.service_uuid")+` AS name FROM media_activity_history h WHERE (?=0 OR h.server_id=?)
	 UNION ALL SELECT `+timelineImportedPerson+`,`+timelinePersonNameForService(timelineImportedPerson, "s.uuid")+` FROM history_imports i JOIN service_accounts s ON s.server_id=i.server_id AND s.external_user_id=i.account_id WHERE (?=0 OR i.server_id=?))
	 GROUP BY person LIMIT 5000`, server, server, server, server)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	people := []timelinePerson{}
	for rows.Next() {
		var person timelinePerson
		if err := rows.Scan(&person.UUID, &person.Name); err != nil {
			return nil, err
		}
		people = append(people, person)
	}
	slices.SortFunc(people, func(x, y timelinePerson) int {
		return cmp.Or(cmp.Compare(strings.ToLower(x.Name), strings.ToLower(y.Name)), cmp.Compare(x.UUID, y.UUID))
	})
	return people, rows.Err()
}
