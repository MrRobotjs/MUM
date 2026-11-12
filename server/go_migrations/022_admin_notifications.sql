CREATE TABLE admin_notifications (
 id INTEGER PRIMARY KEY AUTOINCREMENT CHECK(id>0 AND id<=9007199254740991),
 notification_type TEXT NOT NULL CHECK(notification_type='SERVER_NOT_SYNCED'),
 occurred_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 audience TEXT NOT NULL CHECK(audience IN ('administrators','recipient')),
 recipient_uuid TEXT REFERENCES user_accounts(uuid) ON DELETE CASCADE,
 server_id INTEGER NOT NULL REFERENCES media_servers(id) ON DELETE CASCADE,
 resolved INTEGER NOT NULL DEFAULT 0 CHECK(resolved IN (0,1)),
 CHECK((audience='administrators' AND recipient_uuid IS NULL) OR (audience='recipient' AND recipient_uuid IS NOT NULL))
);
CREATE UNIQUE INDEX admin_server_notice ON admin_notifications(server_id,notification_type) WHERE audience='administrators';
CREATE TABLE admin_notification_content(singleton INTEGER PRIMARY KEY CHECK(singleton=1),revision INTEGER NOT NULL CHECK(revision>0));
INSERT INTO admin_notification_content VALUES(1,1);
CREATE TABLE admin_notification_inboxes(user_uuid TEXT PRIMARY KEY REFERENCES user_accounts(uuid) ON DELETE CASCADE,revision INTEGER NOT NULL CHECK(revision>0));
CREATE TABLE admin_notification_receipts(
 user_uuid TEXT NOT NULL REFERENCES user_accounts(uuid) ON DELETE CASCADE,
 notification_id INTEGER NOT NULL REFERENCES admin_notifications(id) ON DELETE CASCADE,
 is_read INTEGER NOT NULL DEFAULT 0 CHECK(is_read IN (0,1)),
 dismissed INTEGER NOT NULL DEFAULT 0 CHECK(dismissed IN (0,1)),
 PRIMARY KEY(user_uuid,notification_id)
);
CREATE TRIGGER admin_notice_insert AFTER INSERT ON admin_notifications BEGIN UPDATE admin_notification_content SET revision=revision+1; END;
CREATE TRIGGER admin_notice_update AFTER UPDATE ON admin_notifications BEGIN UPDATE admin_notification_content SET revision=revision+1; END;
CREATE TRIGGER admin_notice_delete AFTER DELETE ON admin_notifications BEGIN UPDATE admin_notification_content SET revision=revision+1; END;
CREATE TRIGGER admin_receipt_insert AFTER INSERT ON admin_notification_receipts BEGIN
 INSERT INTO admin_notification_inboxes VALUES(NEW.user_uuid,2) ON CONFLICT(user_uuid) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER admin_receipt_update AFTER UPDATE ON admin_notification_receipts BEGIN
 INSERT INTO admin_notification_inboxes VALUES(NEW.user_uuid,2) ON CONFLICT(user_uuid) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER admin_receipt_delete AFTER DELETE ON admin_notification_receipts BEGIN
 UPDATE admin_notification_inboxes SET revision=revision+1 WHERE user_uuid=OLD.user_uuid;
END;
INSERT INTO admin_notifications(notification_type,audience,server_id)
 SELECT 'SERVER_NOT_SYNCED','administrators',id FROM media_servers WHERE last_sync_at IS NULL;
