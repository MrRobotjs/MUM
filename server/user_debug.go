package main

import (
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
)

const userDebugAccountLimit = 100

// userDebug shows administrators what MUM stored for a service account, or for
// every account a human primarily owns. Raw provider payload columns are never
// read: upstream responses can carry tokens, so only sanitized fields that sync
// recorded and the parsed access policy are returned.
func (a *App) userDebug(w http.ResponseWriter, r *http.Request) {
	p, ok := a.principal(w, r, true)
	if !ok {
		return
	}
	target := r.PathValue("user")
	if r.URL.RawQuery != "" || !validAdminMemberCursor(target) {
		domainError(w, ErrNotFound)
		return
	}
	tx, err := a.store.reader.BeginTx(r.Context(), &sql.TxOptions{ReadOnly: true})
	if err != nil {
		domainError(w, err)
		return
	}
	defer tx.Rollback()
	if err = notificationAuthority(r.Context(), tx, p.UUID, bearer(r)); err != nil {
		domainError(w, err)
		return
	}
	var kind, name string
	err = tx.QueryRowContext(r.Context(), `SELECT i.kind,coalesce(u.local_username,a.external_username,'') FROM identities i LEFT JOIN user_accounts u ON u.uuid=i.uuid LEFT JOIN service_accounts a ON a.uuid=i.uuid WHERE i.uuid=?`, target).Scan(&kind, &name)
	if errors.Is(err, sql.ErrNoRows) {
		err = ErrNotFound
	}
	if err != nil {
		domainError(w, err)
		return
	}
	rows, err := tx.QueryContext(r.Context(), `SELECT a.uuid,a.server_id,s.server_nickname,s.service_type,coalesce(a.external_user_id,''),coalesce(a.external_user_alt_id,''),coalesce(a.external_username,''),coalesce(a.external_email,''),a.is_active,coalesce(a.allowed_library_ids,'[]'),a.allow_downloads,a.access_expires_at,coalesce(a.service_settings,'{}')
 FROM service_accounts a JOIN media_servers s ON s.id=a.server_id
 WHERE a.uuid=? OR a.uuid IN (SELECT service_uuid FROM service_links WHERE user_uuid=? AND link_kind='owner')
 ORDER BY s.id,a.uuid LIMIT ?`, target, target, userDebugAccountLimit+1)
	if err != nil {
		domainError(w, err)
		return
	}
	info := map[string]any{"username": name, "user_uuid": target, "user_type": kind}
	services := []map[string]any{}
	for rows.Next() {
		var service, provider, server, external, alt, username, email, libraries, settings string
		var serverID int64
		var active, downloads bool
		var expires sql.NullString
		if err = rows.Scan(&service, &serverID, &server, &provider, &external, &alt, &username, &email, &active, &libraries, &downloads, &expires, &settings); err != nil {
			break
		}
		var libraryIDs, policy any
		if json.Unmarshal([]byte(libraries), &libraryIDs) != nil || json.Unmarshal([]byte(settings), &policy) != nil {
			err = errors.New("stored account metadata is invalid")
			break
		}
		if service == target {
			info["external_user_id"], info["external_user_alt_id"], info["service_type"], info["server_name"] = external, alt, provider, server
		}
		record := map[string]any{"service_uuid": service, "external_user_id": external, "external_username": username, "external_email": email, "is_active": active, "allowed_library_ids": libraryIDs, "allow_downloads": downloads, "access_expires_at": nil}
		if alt != "" {
			record["external_user_alt_id"] = alt
		}
		if expires.Valid {
			record["access_expires_at"] = expires.String
		}
		services = append(services, map[string]any{"server_id": serverID, "server_name": server, "service_type": provider, "raw_data": record, "service_settings": policy})
	}
	if err == nil {
		err = rows.Err()
	}
	rows.Close()
	if err == nil && len(services) > userDebugAccountLimit {
		err = ErrConflict
	}
	if err == nil {
		err = tx.Commit()
	}
	if err != nil {
		domainError(w, err)
		return
	}
	respond(w, 200, map[string]any{"user_info": info, "service_data": services, "has_data": len(services) > 0})
}
