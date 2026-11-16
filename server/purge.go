package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"time"
)

// The purge (PURGE_DESIGN.md) removes Plex server accounts that have not
// played anything for a chosen number of days, so their places can go to
// someone else. The list comes from GET /api/users/eligible-for-purge; the
// removal is Edit's prepared delete with the purge rule attached, so Plex
// removes the share and MUM checks it is gone before removing its record. Each
// account is checked against the rule again just before Plex is asked.
// The owner and full administrators may purge; the owner's and every
// administrator's server accounts are never purged, whoever runs it (user
// decision 2026-11-16).

// editPurgeRule is the purge dialog's rule, carried by a delete_users edit.
type editPurgeRule struct {
	InactiveDays     int  `json:"inactive_days"`
	ExcludeSharers   bool `json:"exclude_sharers"`
	ExcludeProtected bool `json:"exclude_whitelisted"`
	IgnoreJoinDate   bool `json:"ignore_creation_date"`
}

func validPurgeRule(rule editPurgeRule) bool {
	return rule.InactiveDays >= 1 && rule.InactiveDays <= 36500
}

// purgeAccount is what the rule needs to know about one Plex server account.
type purgeAccount struct {
	UUID, Name, Email, ServerName string
	External                      string // the Plex user ID, shared by the person's accounts on every Plex server
	ServerID                      int64
	ServerActive                  bool
	Joined                        time.Time
	MUMLast, PlexLast             *time.Time
	Protected, SharesBack, Home   bool
	Guarded                       bool // the owner's, the actor's or any administrator's
}

// lastPlay is the newest play from MUM's records or the imported Plex history.
func (p purgeAccount) lastPlay() (*time.Time, string) {
	switch {
	case p.MUMLast != nil && (p.PlexLast == nil || !p.PlexLast.After(*p.MUMLast)):
		return p.MUMLast, "mum"
	case p.PlexLast != nil:
		return p.PlexLast, "plex_history"
	}
	return nil, ""
}

// purgeDecision returns "" when the rule removes the account, otherwise why not.
func purgeDecision(p purgeAccount, rule editPurgeRule, now time.Time) string {
	cutoff := now.AddDate(0, 0, -rule.InactiveDays)
	last, _ := p.lastPlay()
	switch {
	case p.Guarded:
		return "protected_account"
	case p.Home:
		return "plex_home"
	case rule.ExcludeProtected && p.Protected:
		return "purge_protected"
	case rule.ExcludeSharers && p.SharesBack:
		return "shares_back"
	case last != nil && !last.Before(cutoff):
		return "recently_active"
	case last == nil && !rule.IgnoreJoinDate && !p.Joined.Before(cutoff):
		return "recently_joined"
	}
	return ""
}

// purgeAccountsSQL reads Plex server accounts that are not removed. The guard
// covers accounts linked to the owner, the actor or any administrator.
// Arguments: the actor, then a service account and a Plex user ID to restrict
// to, each twice, or "".
const purgeAccountsSQL = `SELECT a.uuid,coalesce(a.external_username,''),coalesce(a.external_email,''),a.external_user_id,s.id,s.is_active=1,s.server_nickname,
 coalesce(a.service_join_date,a.created_at),
 (SELECT max(h.last_seen_at) FROM media_activity_history h WHERE h.service_uuid=a.uuid),
 (SELECT max(i.viewed_at) FROM plex_history_imports i WHERE i.server_id=a.server_id AND i.account_id=a.external_user_id),
 a.is_purge_whitelisted,
 EXISTS(SELECT 1 FROM identity_user_roles r JOIN relationship_roles k ON k.role_id=r.role_id WHERE r.user_uuid=a.uuid AND k.kind='shares_back'),
 EXISTS(SELECT 1 FROM identity_user_roles r JOIN relationship_roles k ON k.role_id=r.role_id WHERE r.user_uuid=a.uuid AND k.kind='home_user'),
 EXISTS(SELECT 1 FROM service_links l JOIN user_accounts u ON u.uuid=l.user_uuid WHERE l.service_uuid=a.uuid AND (u.kind='owner' OR u.uuid=?
  OR EXISTS(SELECT 1 FROM admin_privileges WHERE user_uuid=u.uuid)))
 FROM service_accounts a JOIN media_servers s ON s.id=a.server_id
 WHERE s.service_type='plex' AND a.removed_at IS NULL AND a.external_user_id IS NOT NULL AND (?='' OR a.uuid=?) AND (?='' OR a.external_user_id=?)`

type purgeQuerier interface {
	QueryContext(context.Context, string, ...any) (*sql.Rows, error)
}

func loadPurgeAccounts(ctx context.Context, q purgeQuerier, actor, only, external string) ([]purgeAccount, error) {
	rows, err := q.QueryContext(ctx, purgeAccountsSQL, actor, only, only, external, external)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []purgeAccount
	parse := func(value string) (time.Time, bool) {
		at, err := time.Parse(time.RFC3339Nano, value)
		return at, err == nil
	}
	for rows.Next() {
		var p purgeAccount
		var joined string
		var mum, plex sql.NullString
		if err := rows.Scan(&p.UUID, &p.Name, &p.Email, &p.External, &p.ServerID, &p.ServerActive, &p.ServerName, &joined, &mum, &plex, &p.Protected, &p.SharesBack, &p.Home, &p.Guarded); err != nil {
			return nil, err
		}
		var ok bool
		if p.Joined, ok = parse(joined); !ok {
			// An unreadable join date never makes an account look old.
			p.Joined = time.Now()
		}
		if at, ok := parse(mum.String); mum.Valid && ok {
			p.MUMLast = &at
		}
		if at, ok := parse(plex.String); plex.Valid && ok {
			p.PlexLast = &at
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

// purgeTargetReason checks one selected account against the rule: "" when it
// may be removed, otherwise the reason it is skipped. Removing a Plex share
// removes the friendship, which ends the person's access to the owner's other
// Plex servers too, so every Plex account of the same person must meet the
// rule as well.
func purgeTargetReason(ctx context.Context, q purgeQuerier, actor, service string, rule editPurgeRule) (string, error) {
	accounts, err := loadPurgeAccounts(ctx, q, actor, service, "")
	if err != nil {
		return "", err
	}
	if len(accounts) != 1 || !accounts[0].ServerActive {
		return "not_purgeable", nil
	}
	now := time.Now()
	if reason := purgeDecision(accounts[0], rule, now); reason != "" {
		return reason, nil
	}
	same, err := loadPurgeAccounts(ctx, q, actor, "", accounts[0].External)
	if err != nil {
		return "", err
	}
	for _, other := range same {
		if other.UUID != service && purgeDecision(other, rule, now) != "" {
			return "kept_on_another_server", nil
		}
	}
	return "", nil
}

// purgeStillAllowed rereads the account just before Plex is asked to remove it.
func (a *App) purgeStillAllowed(ctx context.Context, actor, service string, rule editPurgeRule) (string, error) {
	tx, err := a.store.reader.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return "", err
	}
	defer tx.Rollback()
	return purgeTargetReason(ctx, tx, actor, service, rule)
}

// recordPurge audits a finished purge with its rule and counts.
func recordPurge(ctx context.Context, tx *sql.Tx, b editStored) error {
	if b.Operation.Purge == nil {
		return nil
	}
	rule := b.Operation.Purge
	details, err := json.Marshal(map[string]any{"operation_id": b.ID, "inactive_days": rule.InactiveDays, "exclude_sharers": rule.ExcludeSharers,
		"exclude_whitelisted": rule.ExcludeProtected, "ignore_creation_date": rule.IgnoreJoinDate,
		"deleted": b.Summary["deleted"], "skipped": b.Summary["skipped"], "failed": b.Summary["failed"], "unknown": b.Summary["unknown"]})
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, "INSERT INTO audit_events(actor_uuid,action,details,occurred_at) VALUES(?,'users.purge',?,?)", b.Actor, string(details), utcTimestamp(time.Now()))
	return err
}

func parsePurgeQuery(values map[string][]string) (editPurgeRule, bool) {
	rule := editPurgeRule{ExcludeSharers: true, ExcludeProtected: true}
	flags := map[string]*bool{"exclude_sharers": &rule.ExcludeSharers, "exclude_whitelisted": &rule.ExcludeProtected, "ignore_creation_date": &rule.IgnoreJoinDate}
	for key, value := range values {
		if len(value) != 1 {
			return rule, false
		}
		if key == "inactive_days" {
			days, err := strconv.Atoi(value[0])
			if err != nil {
				return rule, false
			}
			rule.InactiveDays = days
			continue
		}
		flag, known := flags[key]
		if !known {
			return rule, false
		}
		switch value[0] {
		case "true":
			*flag = true
		case "false":
			*flag = false
		default:
			return rule, false
		}
	}
	return rule, validPurgeRule(rule)
}

func (a *App) eligibleForPurge(w http.ResponseWriter, r *http.Request) {
	actor, ok := a.principal(w, r, true)
	if !ok {
		return
	}
	rule, valid := parsePurgeQuery(r.URL.Query())
	if !valid {
		fail(w, 400, "INVALID_PURGE_RULE", "Choose at least 1 day of inactivity and true or false for each option")
		return
	}
	tx, err := a.store.reader.BeginTx(r.Context(), &sql.TxOptions{ReadOnly: true})
	if err != nil {
		domainError(w, err)
		return
	}
	defer tx.Rollback()
	if err := editAuthorityTx(r.Context(), tx, actor.UUID, bearer(r)); err != nil {
		domainError(w, err)
		return
	}
	accounts, err := loadPurgeAccounts(r.Context(), tx, actor.UUID, "", "")
	if err != nil {
		domainError(w, err)
		return
	}
	now := time.Now()
	// A person is listed only when all of their Plex accounts meet the rule
	// (see purgeTargetReason).
	kept := map[string]bool{}
	for _, p := range accounts {
		if purgeDecision(p, rule, now) != "" {
			kept[p.External] = true
		}
	}
	type listed struct {
		purgeAccount
		since time.Time
	}
	var eligible []listed
	for _, p := range accounts {
		if !p.ServerActive || kept[p.External] {
			continue
		}
		since := p.Joined
		if last, _ := p.lastPlay(); last != nil {
			since = *last
		}
		eligible = append(eligible, listed{p, since})
	}
	// Longest inactive first.
	slices.SortFunc(eligible, func(x, y listed) int {
		if c := x.since.Compare(y.since); c != 0 {
			return c
		}
		return strings.Compare(strings.ToLower(x.Name), strings.ToLower(y.Name))
	})
	users := make([]map[string]any, 0, len(eligible))
	for _, p := range eligible {
		last, source := p.lastPlay()
		var lastValue, sourceValue, emailValue any
		if last != nil {
			lastValue, sourceValue = last.UTC().Format(time.RFC3339), source
		}
		if p.Email != "" {
			emailValue = p.Email
		}
		users = append(users, map[string]any{"uuid": p.UUID, "username": p.Name, "email": emailValue, "server_id": p.ServerID, "server_name": p.ServerName,
			"service_type": "plex", "avatar_url": nil, "created_at": p.Joined.UTC().Format(time.RFC3339), "last_streamed_at": lastValue, "last_play_source": sourceValue,
			"last_login_at": nil, "days_since_activity": int(now.Sub(p.since).Hours() / 24), "is_sharer": p.SharesBack, "is_whitelisted": p.Protected})
	}
	respond(w, 200, map[string]any{"users": users, "criteria": rule})
}
