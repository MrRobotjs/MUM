package main

import (
	"database/sql"
	"net/http"
	"strconv"
	"time"
)

type accountLinkAccount struct {
	UUID     string `json:"uuid"`
	Username string `json:"external_username"`
	Email    string `json:"external_email"`
	Provider string `json:"service_type"`
	Server   string `json:"server_name"`
}

type accountLinkAccountsRecord struct {
	Actor           string               `json:"actor_uuid"`
	Target          string               `json:"user_uuid"`
	RoleRevision    string               `json:"role_revision"`
	LinkRevision    string               `json:"link_revision"`
	ProfileRevision string               `json:"profile_revision"`
	CanLink         bool                 `json:"can_link"`
	CanUnlink       bool                 `json:"can_unlink"`
	Linked          []accountLinkAccount `json:"linked_accounts"`
	Available       []accountLinkAccount `json:"available_accounts"`
}

// Both lists and their authority/revisions come from one query-only snapshot.
// Oversized selectors fail rather than presenting a silently truncated list.
func (a *App) accountLinkAccounts(w http.ResponseWriter, r *http.Request) {
	actor, ok := a.principal(w, r, true)
	if !ok {
		return
	}
	target := r.PathValue("user")
	if !validAdminMemberCursor(target) || r.URL.RawQuery != "" {
		fail(w, 400, "INVALID_SELECTION", "Select one current human profile")
		return
	}
	tx, err := a.store.reader.BeginTx(r.Context(), &sql.TxOptions{ReadOnly: true})
	if err != nil {
		domainError(w, err)
		return
	}
	defer tx.Rollback()
	if err = accountPreferenceAuthority(r.Context(), tx, actor.UUID, bearer(r)); err == nil {
		err = accountLinkTargetAuthority(r.Context(), tx, actor.UUID, target)
	}
	if err != nil {
		domainError(w, err)
		return
	}
	out := accountLinkAccountsRecord{Actor: actor.UUID, Target: target, CanUnlink: true, Linked: []accountLinkAccount{}, Available: []accountLinkAccount{}}
	var role, link, profile int64
	var active bool
	var expires sql.NullString
	if err = tx.QueryRowContext(r.Context(), "SELECT profile_revision,is_active,access_expires_at FROM user_accounts WHERE uuid=?", target).Scan(&profile, &active, &expires); err == nil {
		err = tx.QueryRowContext(r.Context(), "SELECT revision FROM admin_role_state WHERE singleton=1").Scan(&role)
	}
	if err == nil {
		err = tx.QueryRowContext(r.Context(), "SELECT revision FROM account_link_state WHERE singleton=1").Scan(&link)
	}
	if err != nil {
		domainError(w, err)
		return
	}
	out.CanLink = active
	if expires.Valid {
		deadline, e := time.Parse(time.RFC3339Nano, expires.String)
		out.CanLink = out.CanLink && e == nil && deadline.After(time.Now())
	}
	out.RoleRevision = strconv.FormatInt(role, 10)
	out.LinkRevision = strconv.FormatInt(link, 10)
	out.ProfileRevision = strconv.FormatInt(profile, 10)
	rows, err := tx.QueryContext(r.Context(), `SELECT a.uuid,coalesce(a.external_username,''),coalesce(a.external_email,''),s.service_type,s.server_nickname,
 EXISTS(SELECT 1 FROM service_links l WHERE l.service_uuid=a.uuid AND l.user_uuid=? AND l.link_kind='owner')
 FROM service_accounts a JOIN media_servers s ON s.id=a.server_id
 WHERE EXISTS(SELECT 1 FROM service_links l WHERE l.service_uuid=a.uuid AND l.user_uuid=? AND l.link_kind='owner')
 OR (? AND a.is_active=1 AND NOT EXISTS(SELECT 1 FROM service_links l WHERE l.service_uuid=a.uuid))
 ORDER BY a.uuid LIMIT 1001`, target, target, out.CanLink)
	if err != nil {
		domainError(w, err)
		return
	}
	for rows.Next() {
		var account accountLinkAccount
		var linked bool
		if err = rows.Scan(&account.UUID, &account.Username, &account.Email, &account.Provider, &account.Server, &linked); err != nil {
			break
		}
		if linked {
			out.Linked = append(out.Linked, account)
		} else {
			out.Available = append(out.Available, account)
		}
	}
	if err == nil {
		err = rows.Err()
	}
	rows.Close()
	if err == nil && len(out.Linked)+len(out.Available) > 1000 {
		err = ErrConflict
	}
	if err == nil {
		err = tx.Commit()
	}
	if err != nil {
		domainError(w, err)
		return
	}
	respond(w, 200, out)
}
