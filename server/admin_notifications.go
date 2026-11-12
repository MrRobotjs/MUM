package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"time"
)

type adminNotification struct {
	ID        int64  `json:"id"`
	Timestamp string `json:"timestamp"`
	Kind      string `json:"notification_type"`
	Title     string `json:"title"`
	Message   string `json:"message"`
	Read      bool   `json:"read"`
	Resolved  bool   `json:"resolved"`
}
type notificationSnapshot struct {
	Actor   string `json:"actor_uuid"`
	Content int64  `json:"content_revision"`
	Inbox   int64  `json:"inbox_revision"`
}
type notificationChange struct {
	Actor     string  `json:"expected_actor_uuid"`
	Content   int64   `json:"content_revision"`
	Inbox     int64   `json:"inbox_revision"`
	Operation string  `json:"operation"`
	IDs       []int64 `json:"notification_ids"`
}
type notificationChangeResult struct {
	notificationSnapshot
	Operation string  `json:"operation"`
	IDs       []int64 `json:"notification_ids"`
}

const notificationFrom = ` FROM admin_notifications n LEFT JOIN admin_notification_receipts r ON r.notification_id=n.id AND r.user_uuid=? WHERE (n.audience='administrators' OR n.recipient_uuid=?) AND coalesce(r.dismissed,0)=0`

func notificationRevisions(ctx context.Context, tx *sql.Tx, actor string) (notificationSnapshot, error) {
	s := notificationSnapshot{Actor: actor}
	err := tx.QueryRowContext(ctx, `SELECT revision,coalesce((SELECT revision FROM admin_notification_inboxes WHERE user_uuid=?),1) FROM admin_notification_content WHERE singleton=1`, actor).Scan(&s.Content, &s.Inbox)
	return s, err
}
func notificationAuthority(ctx context.Context, tx *sql.Tx, actor, access string) error {
	if err := accountPreferenceAuthority(ctx, tx, actor, access); err != nil {
		return err
	}
	return requirePermission(ctx, tx, actor, "administrator")
}
func recordServerNotification(ctx context.Context, tx *sql.Tx, server int64) error {
	_, err := tx.ExecContext(ctx, `INSERT INTO admin_notifications(notification_type,audience,server_id) VALUES('SERVER_NOT_SYNCED','administrators',?)`, server)
	return err
}
func (a *App) notificationList(w http.ResponseWriter, r *http.Request) {
	actor, ok := a.principal(w, r, true)
	if !ok {
		return
	}
	after := int64(9007199254740992)
	for key, values := range r.URL.Query() {
		if key != "after" || len(values) != 1 {
			fail(w, 400, "INVALID_NOTIFICATION_QUERY", "Use only an optional positive notification cursor")
			return
		}
		var err error
		after, err = strconv.ParseInt(values[0], 10, 64)
		if err != nil || after < 1 || after > 9007199254740991 || strconv.FormatInt(after, 10) != values[0] {
			fail(w, 400, "INVALID_NOTIFICATION_QUERY", "Use a canonical positive notification cursor")
			return
		}
	}
	tx, err := a.beginAdminRoleRead(r.Context(), actor.UUID, bearer(r))
	if err != nil {
		domainError(w, err)
		return
	}
	defer tx.Rollback()
	snapshot, err := notificationRevisions(r.Context(), tx, actor.UUID)
	if err != nil {
		domainError(w, err)
		return
	}
	var total, unread int
	err = tx.QueryRowContext(r.Context(), `SELECT count(*),coalesce(sum(CASE WHEN n.resolved=0 AND coalesce(r.is_read,0)=0 THEN 1 ELSE 0 END),0)`+notificationFrom, actor.UUID, actor.UUID).Scan(&total, &unread)
	if err != nil {
		domainError(w, err)
		return
	}
	rows, err := tx.QueryContext(r.Context(), `SELECT n.id,n.occurred_at,n.notification_type,n.resolved,(n.resolved=1 OR coalesce(r.is_read,0)=1),coalesce((SELECT local_username FROM user_accounts WHERE uuid=n.subject_uuid),(SELECT external_username FROM service_accounts WHERE uuid=n.subject_uuid),'Account')`+notificationFrom+` AND n.id<? ORDER BY n.id DESC LIMIT 101`, actor.UUID, actor.UUID, after)
	if err != nil {
		domainError(w, err)
		return
	}
	items := []adminNotification{}
	for rows.Next() {
		var item adminNotification
		var subject string
		if err = rows.Scan(&item.ID, &item.Timestamp, &item.Kind, &item.Resolved, &item.Read, &subject); err != nil {
			break
		}
		item.Title = "Server synchronization"
		item.Message = "A server was added. Complete an initial users or libraries synchronization."
		if item.Resolved {
			item.Message = "A server completed an initial synchronization operation."
		}
		if item.Kind == "ACCOUNT_EXPIRED" {
			item.Title = "Local account expiry"
			item.Message = fmt.Sprintf("Local MUM access expired for %q. Prior MUM sessions were revoked. Remote service access was not changed.", subject)
			if item.Resolved {
				item.Message = fmt.Sprintf("The expiry setting for %q changed. Previous MUM sessions remain revoked; remote service access was not changed.", subject)
			}
		}
		if item.Kind == "SERVICE_EXPIRED" {
			item.Title = "Service account expiry"
			item.Message = fmt.Sprintf("Local MUM visibility expired for service account %q. Remote service access was not changed.", subject)
			if item.Resolved {
				item.Message = fmt.Sprintf("The local expiry setting for service account %q changed. Remote service access was not changed.", subject)
			}
		}
		items = append(items, item)
	}
	if err == nil {
		err = rows.Err()
	}
	rows.Close()
	var next *int64
	if len(items) > 100 {
		items = items[:100]
		last := items[99].ID
		next = &last
	}
	if err == nil {
		err = tx.Commit()
	}
	if err != nil {
		domainError(w, err)
		return
	}
	respond(w, 200, struct {
		notificationSnapshot
		Notifications []adminNotification `json:"notifications"`
		Total         int                 `json:"total"`
		Unread        int                 `json:"unread_count"`
		Next          *int64              `json:"next_after"`
	}{snapshot, items, total, unread, next})
}
func validNotificationChange(p notificationChange) bool {
	if !validAdminMemberCursor(p.Actor) || p.Content < 1 || p.Inbox < 1 {
		return false
	}
	if p.Operation != "read" && p.Operation != "read_all" && p.Operation != "dismiss" {
		return false
	}
	if p.Operation == "read_all" {
		return len(p.IDs) == 0
	}
	if len(p.IDs) < 1 || len(p.IDs) > 100 {
		return false
	}
	seen := map[int64]bool{}
	for _, id := range p.IDs {
		if id < 1 || id > 9007199254740991 || seen[id] {
			return false
		}
		seen[id] = true
	}
	return true
}

func commitNotificationChange(ctx context.Context, tx *sql.Tx, p notificationChange, access string) (notificationChangeResult, error) {
	result := notificationChangeResult{Operation: p.Operation, IDs: []int64{}}
	if !validNotificationChange(p) {
		return result, ErrConflict
	}
	if err := notificationAuthority(ctx, tx, p.Actor, access); err != nil {
		return result, err
	}
	before, err := notificationRevisions(ctx, tx, p.Actor)
	if err != nil {
		return result, err
	}
	if before.Content != p.Content || before.Inbox != p.Inbox {
		return result, ErrConflict
	}
	ids := append([]int64{}, p.IDs...)
	if p.Operation == "read_all" {
		rows, err := tx.QueryContext(ctx, `SELECT n.id`+notificationFrom+` AND n.resolved=0 AND coalesce(r.is_read,0)=0 ORDER BY n.id LIMIT 10001`, p.Actor, p.Actor)
		if err != nil {
			return result, err
		}
		for rows.Next() {
			var id int64
			if err = rows.Scan(&id); err != nil {
				break
			}
			ids = append(ids, id)
		}
		if err == nil {
			err = rows.Err()
		}
		rows.Close()
		if err != nil {
			return result, err
		}
	}
	if len(ids) == 0 || len(ids) > 10000 {
		return result, ErrConflict
	}
	for _, id := range ids {
		var read bool
		if err := tx.QueryRowContext(ctx, `SELECT (n.resolved=1 OR coalesce(r.is_read,0)=1)`+notificationFrom+` AND n.id=?`, p.Actor, p.Actor, id).Scan(&read); err != nil {
			return result, err
		}
		if p.Operation != "dismiss" && read {
			return result, ErrConflict
		}
	}
	for _, id := range ids {
		if p.Operation == "dismiss" {
			_, err = tx.ExecContext(ctx, `INSERT INTO admin_notification_receipts(user_uuid,notification_id,dismissed) VALUES(?,?,1) ON CONFLICT(user_uuid,notification_id) DO UPDATE SET dismissed=1`, p.Actor, id)
		} else {
			_, err = tx.ExecContext(ctx, `INSERT INTO admin_notification_receipts(user_uuid,notification_id,is_read) VALUES(?,?,1) ON CONFLICT(user_uuid,notification_id) DO UPDATE SET is_read=1`, p.Actor, id)
		}
		if err != nil {
			return result, err
		}
	}
	result.notificationSnapshot, err = notificationRevisions(ctx, tx, p.Actor)
	if err != nil {
		return result, err
	}
	result.IDs = ids
	details, err := json.Marshal(struct {
		Before notificationSnapshot `json:"before"`
		After  notificationSnapshot `json:"after"`
		IDs    []int64              `json:"notification_ids"`
	}{before, result.notificationSnapshot, ids})
	if err != nil {
		return result, err
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO audit_events(actor_uuid,action,details,occurred_at) VALUES(?,?,?,?)`, p.Actor, "notifications."+p.Operation, string(details), utcTimestamp(time.Now()))
	return result, err
}
func (a *App) notificationState(w http.ResponseWriter, r *http.Request) {
	actor, ok := a.principal(w, r, true)
	if !ok {
		return
	}
	var p notificationChange
	if !decodeStrictBody(w, r, &p) {
		return
	}
	if p.Actor != actor.UUID {
		domainError(w, ErrForbidden)
		return
	}
	valid := len(r.URL.Query()) == 0 && validNotificationChange(p)
	if !valid {
		fail(w, 400, "INVALID_NOTIFICATION_CHANGE", "Use current revisions and distinct notification IDs for a supported action")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	var result notificationChangeResult
	err := a.store.write(ctx, func(tx *sql.Tx) error {
		var err error
		result, err = commitNotificationChange(ctx, tx, p, bearer(r))
		return err
	})
	if err != nil {
		domainError(w, err)
		return
	}
	respond(w, 200, result)
}
