package main

import (
	"app/server/providers/plex"
	"context"
	"database/sql"
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"time"
)

const userProjection = `SELECT i.id,i.uuid,i.kind,coalesce(u.local_username,a.external_username,''),
 coalesce(u.email,a.external_email,''),coalesce(u.is_active,a.is_active),coalesce(u.created_at,a.created_at),
 coalesce(u.notes,a.notes,''),a.server_id,coalesce(s.server_nickname,''),coalesce(s.service_type,''),
 (SELECT count(*) FROM service_links l WHERE l.user_uuid=i.uuid AND l.link_kind='owner'),
 (SELECT json_group_array(r.name) FROM admin_privileges ap JOIN admin_roles r ON r.id=ap.role_id WHERE ap.user_uuid=i.uuid),
 (SELECT json_group_array(json_object('name',r.name,'color',r.color,'icon',r.icon,'badge_style',r.badge_style)) FROM (SELECT r.* FROM identity_user_roles ir JOIN user_roles r ON r.id=ir.role_id WHERE ir.user_uuid=i.uuid ORDER BY r.position DESC,r.id) r),
 coalesce(a.allowed_library_ids,'[]'),coalesce(a.service_settings,'{}'),coalesce(parent.uuid,''),coalesce(parent.local_username,''),coalesce(u.access_expires_at,a.access_expires_at),
 coalesce(a.external_avatar_url,''),coalesce(a.service_join_date,''),
 coalesce(a.is_active=1 AND s.service_type='plex' AND s.is_active=1 AND EXISTS(SELECT 1 FROM provider_settings p WHERE p.provider_id='plex' AND p.enabled=1),0),
 (SELECT max(seen) FROM (SELECT max(h.last_seen_at) seen FROM media_activity_history h WHERE h.service_uuid=i.uuid
  UNION ALL SELECT max(h.last_seen_at) FROM media_activity_history h WHERE h.owner_uuid=i.uuid))
 FROM identities i LEFT JOIN user_accounts u ON u.uuid=i.uuid LEFT JOIN service_accounts a ON a.uuid=i.uuid
 LEFT JOIN media_servers s ON s.id=a.server_id LEFT JOIN service_links owner ON owner.service_uuid=a.uuid AND owner.link_kind='owner'
 LEFT JOIN user_accounts parent ON parent.uuid=owner.user_uuid`

func (a *App) listUsers(w http.ResponseWriter, r *http.Request) {
	actor, ok := a.principal(w, r, true)
	if !ok {
		return
	}
	page, size := 1, 50
	var err error
	if raw := r.URL.Query().Get("page"); raw != "" {
		page, err = strconv.Atoi(raw)
		if err != nil || page < 1 || page > 1000000 {
			fail(w, 400, "INVALID_PAGE", "Invalid page")
			return
		}
	}
	if raw := r.URL.Query().Get("page_size"); raw != "" {
		size, err = strconv.Atoi(raw)
		if err != nil || size < 1 || size > 100 {
			fail(w, 400, "INVALID_PAGE_SIZE", "Page size must be 1 to 100")
			return
		}
	}
	where := " WHERE 1=1"
	args := []any{}
	if uuid := r.PathValue("user"); uuid != "" {
		where += " AND i.uuid=?"
		args = append(args, uuid)
	}
	// Accounts removed from their provider stay reachable by direct link (for
	// their history) but are not listed.
	if r.PathValue("user") == "" {
		where += " AND a.removed_at IS NULL AND u.deleted_at IS NULL"
	}
	if r.URL.Query().Get("unlinked") == "true" {
		where += " AND i.kind='service' AND owner.user_uuid IS NULL"
	}
	if parent := r.URL.Query().Get("linked_to"); parent != "" {
		where += " AND owner.user_uuid=?"
		args = append(args, parent)
	}
	if kind := r.URL.Query().Get("user_type"); kind != "" {
		if kind != "owner" && kind != "local" && kind != "service" {
			fail(w, 400, "INVALID_USER_TYPE", "Invalid user type")
			return
		}
		where += " AND i.kind=?"
		args = append(args, kind)
	}
	if raw := r.URL.Query().Get("server_id"); raw != "" {
		id, err := strconv.ParseInt(raw, 10, 64)
		if err != nil || id <= 0 {
			fail(w, 400, "INVALID_ID", "Invalid server ID")
			return
		}
		where += " AND a.server_id=?"
		args = append(args, id)
	}
	for _, filter := range []struct{ key, expression string }{{"search", "coalesce(u.local_username,a.external_username,'')||' '||coalesce(u.email,a.external_email,'')||' '||coalesce(u.notes,a.notes,'')"}, {"search_username", "coalesce(u.local_username,a.external_username,'')"}, {"search_email", "coalesce(u.email,a.external_email,'')"}, {"search_notes", "coalesce(u.notes,a.notes,'')"}} {
		if value := r.URL.Query().Get(filter.key); value != "" {
			where += " AND instr(lower(" + filter.expression + "),lower(?))>0"
			args = append(args, value)
		}
	}
	if r.URL.Query().Has("role") || r.URL.Query().Has("admin_role_id") && r.URL.Query().Has("user_role_id") {
		fail(w, 400, "INVALID_ROLE_FILTER", "Select one explicit administrator or visual role ID")
		return
	}
	for _, filter := range []struct{ key, table string }{{"admin_role_id", "admin_privileges"}, {"user_role_id", "identity_user_roles"}} {
		if role := r.URL.Query().Get(filter.key); role != "" {
			if !validAdminRoleID(role) {
				fail(w, 400, "INVALID_ROLE_FILTER", "Select a valid role ID")
				return
			}
			where += " AND EXISTS(SELECT 1 FROM " + filter.table + " assignment WHERE assignment.user_uuid=i.uuid AND assignment.role_id=?)"
			args = append(args, role)
		}
	}

	orders := map[string]string{"": "i.id DESC", "created_desc": "coalesce(u.created_at,a.created_at) DESC,i.id DESC", "created_asc": "coalesce(u.created_at,a.created_at),i.id", "username_asc": "coalesce(u.local_username,a.external_username) COLLATE NOCASE,i.id", "username_desc": "coalesce(u.local_username,a.external_username) COLLATE NOCASE DESC,i.id DESC"}
	order, ok := orders[r.URL.Query().Get("sort")]
	if !ok {
		fail(w, 400, "INVALID_SORT", "Invalid sort")
		return
	}
	// A read transaction keeps count and page contents on one WAL snapshot.
	tx, err := a.store.reader.BeginTx(r.Context(), &sql.TxOptions{ReadOnly: true})
	if err != nil {
		domainError(w, err)
		return
	}
	defer tx.Rollback()
	from := userProjection[strings.Index(userProjection, "\n FROM identities"):]
	var total int
	if err := tx.QueryRowContext(r.Context(), "SELECT count(*) "+from+where, args...).Scan(&total); err != nil {
		domainError(w, err)
		return
	}
	queryArgs := append(append([]any{}, args...), size, (page-1)*size)
	rows, err := tx.QueryContext(r.Context(), userProjection+where+" ORDER BY "+order+" LIMIT ? OFFSET ?", queryArgs...)
	if err != nil {
		domainError(w, err)
		return
	}
	items := []map[string]any{}
	// Library names and avatar links are resolved after the page is read, on
	// the same snapshot; these track which rows need them.
	type pendingLibraries struct {
		item   map[string]any
		server int64
		ids    []string
		all    bool
	}
	var libraryRows []pendingLibraries
	var avatarRows []map[string]any
	for rows.Next() {
		var id, linked int64
		var uuid, kind, name, email, created, notes, nickname, provider, roles, visual, libraries, settings, parent, parentName, avatarTag, joined string
		var active, avatarServed bool
		var server sql.NullInt64
		var expiry, lastSeen sql.NullString
		if err := rows.Scan(&id, &uuid, &kind, &name, &email, &active, &created, &notes, &server, &nickname, &provider, &linked, &roles, &visual, &libraries, &settings, &parent, &parentName, &expiry, &avatarTag, &joined, &avatarServed, &lastSeen); err != nil {
			rows.Close()
			domainError(w, err)
			return
		}
		var adminRoles []string
		var userRoles []map[string]any
		var libraryIDs []string
		var policy map[string]any
		if json.Unmarshal([]byte(roles), &adminRoles) != nil || json.Unmarshal([]byte(visual), &userRoles) != nil || json.Unmarshal([]byte(libraries), &libraryIDs) != nil || json.Unmarshal([]byte(settings), &policy) != nil {
			rows.Close()
			fail(w, 500, "INVALID_STORED_DATA", "Could not read account metadata")
			return
		}
		var parentValue any
		if parent != "" {
			parentValue = map[string]string{"uuid": parent, "username": parentName, "display_name": parentName}
		}
		var serverValue any
		if server.Valid {
			serverValue = server.Int64
		}
		var expiryValue any
		if expiry.Valid {
			expiryValue = expiry.String
		}
		if libraryIDs == nil {
			libraryIDs = []string{}
		}
		// Service accounts report the provider's join date when the provider
		// supplied one; a local account joined MUM when it was created.
		var joinValue any
		if kind != "service" {
			joinValue = created
		} else if joined != "" {
			joinValue = joined
		}
		allLibraries := policy["all_libraries"] == true
		// An unknown address is null, so cards show "No email" rather than an empty value.
		var emailValue any
		if email != "" {
			emailValue = email
		}
		item := map[string]any{"access_expires_at": expiryValue, "id": id, "uuid": uuid, "user_type": kind, "username": name, "display_name": name, "email": emailValue, "external_email": emailValue, "is_active": active, "created_at": created, "notes": notes, "server_id": serverValue, "server_nickname": nickname, "service_type": provider, "linked_service_count": linked, "admin_roles": adminRoles, "user_roles": userRoles, "libraries": []string{}, "allowed_library_ids": libraryIDs, "has_all_libraries": allLibraries, "linked_local_user": parentValue, "avatar_url": nil, "service_join_date": joinValue, "last_streamed_at": nil}
		// Latest observed playback of this account (or of the services it owns).
		if lastSeen.Valid {
			item["last_streamed_at"] = lastSeen.String
		}
		items = append(items, item)
		if server.Valid {
			libraryRows = append(libraryRows, pendingLibraries{item: item, server: server.Int64, ids: libraryIDs, all: allLibraries})
		}
		// The raw provider image address stays server-side; only a signed,
		// session-bound proxy link (rechecked on every fetch) is returned.
		if avatarServed && avatarTag != "" && plex.UserAvatar(avatarTag) == avatarTag {
			avatarRows = append(avatarRows, item)
		}
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		domainError(w, err)
		return
	}
	names := map[int64][]userLibraryName{}
	for _, row := range libraryRows {
		if _, loaded := names[row.server]; loaded {
			continue
		}
		list, err := readUserLibraryNames(r.Context(), tx, row.server)
		if err != nil {
			domainError(w, err)
			return
		}
		names[row.server] = list
	}
	for _, row := range libraryRows {
		row.item["libraries"] = userLibraryDisplayNames(names[row.server], row.ids, row.all)
	}
	if len(avatarRows) > 0 {
		session, err := readCatalogueAuthority(r.Context(), tx, actor.UUID, bearer(r))
		if err != nil {
			domainError(w, err)
			return
		}
		now := time.Now()
		for _, item := range avatarRows {
			item["avatar_url"] = a.signedImageURL("user-avatar", "/api/user-avatars", session, item["id"].(int64), now)
		}
	}
	if err := tx.Commit(); err != nil {
		domainError(w, err)
		return
	}
	if r.PathValue("user") != "" {
		if len(items) == 0 {
			domainError(w, ErrNotFound)
			return
		}
		respond(w, 200, items[0])
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"data": items, "meta": map[string]any{"pagination": map[string]int{"page": page, "page_size": size, "total_items": total, "total_pages": (total + size - 1) / size}}})
}

func (a *App) createUser(w http.ResponseWriter, r *http.Request) {
	p, ok := a.principal(w, r, true)
	if !ok {
		return
	}
	var input struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if !decodeBody(w, r, &input) {
		return
	}
	if strings.TrimSpace(input.Username) == "" || len(input.Username) > 255 {
		fail(w, 400, "INVALID_USERNAME", "A username up to 255 bytes is required")
		return
	}
	if !a.passwordAdmission(w, r) {
		return
	}
	defer func() { <-a.passwordSlots }()
	hash, err := hashPassword(input.Password)
	if err != nil {
		fail(w, 400, "INVALID_PASSWORD", err.Error())
		return
	}
	uuid, err := a.store.CreateAccount(r.Context(), p.UUID, input.Username, hash, false)
	if err != nil {
		domainError(w, err)
		return
	}
	respond(w, 201, map[string]string{"uuid": uuid, "username": input.Username})
}
func (a *App) syncAllUsers(w http.ResponseWriter, r *http.Request) {
	p, ok := a.principal(w, r, true)
	if !ok {
		return
	}
	if !a.syncRun.TryLock() {
		fail(w, 409, "SYNC_BUSY", "Another synchronization is running")
		return
	}
	defer a.syncRun.Unlock()
	rows, err := a.store.reader.QueryContext(r.Context(), serverSelect+" WHERE s.is_active=1 AND p.enabled=1 ORDER BY s.id")
	if err != nil {
		domainError(w, err)
		return
	}
	servers := []ManagedServer{}
	for rows.Next() {
		s, err := scanServer(rows)
		if err != nil {
			rows.Close()
			domainError(w, err)
			return
		}
		servers = append(servers, s)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		domainError(w, err)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()
	defer a.setSyncProgress(false, p, 0, 0, "")
	results := []map[string]any{}
	summary := map[string]int{"total_servers": len(servers), "successful": 0, "failed": 0, "total_added": 0, "total_updated": 0, "total_removed": 0}
	for index, s := range servers {
		a.setSyncProgress(true, p, index+1, len(servers), s.Name)
		counts, err := a.syncServer(ctx, p.UUID, bearer(r), s, true, true)
		result := map[string]any{"server_id": s.ID, "server_name": s.Name, "service_type": s.Type, "success": err == nil}
		if err != nil {
			summary["failed"]++
			result["message"] = "Synchronization failed; previous snapshot retained"
		} else {
			summary["successful"]++
			for _, key := range []string{"added", "updated", "removed"} {
				result[key] = counts[key]
				summary["total_"+key] += counts[key]
			}
		}
		results = append(results, result)
	}
	respond(w, 200, map[string]any{"results": results, "summary": summary})
}
