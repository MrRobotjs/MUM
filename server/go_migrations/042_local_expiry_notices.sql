-- Expand notice kinds without losing IDs, receipts, revisions or AUTOINCREMENT high water.
CREATE TABLE expiry_notice_sequence AS SELECT seq FROM sqlite_sequence WHERE name='admin_notifications';
CREATE TABLE expiry_notice_receipts AS SELECT * FROM admin_notification_receipts;
DROP TABLE admin_notification_receipts;
CREATE TABLE admin_notifications_next (
 id INTEGER PRIMARY KEY AUTOINCREMENT CHECK(id>0 AND id<=9007199254740991),
 notification_type TEXT NOT NULL CHECK(notification_type IN ('SERVER_NOT_SYNCED','ACCOUNT_EXPIRED')),
 occurred_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 audience TEXT NOT NULL CHECK(audience IN ('administrators','recipient')),
 recipient_uuid TEXT REFERENCES user_accounts(uuid) ON DELETE CASCADE,
 server_id INTEGER REFERENCES media_servers(id) ON DELETE CASCADE,
 subject_uuid TEXT REFERENCES user_accounts(uuid) ON DELETE CASCADE,
 expiry_revision INTEGER,
 resolved INTEGER NOT NULL DEFAULT 0 CHECK(resolved IN (0,1)),
 CHECK((audience='administrators' AND recipient_uuid IS NULL) OR (audience='recipient' AND recipient_uuid IS NOT NULL)),
 CHECK((notification_type='SERVER_NOT_SYNCED' AND server_id IS NOT NULL AND subject_uuid IS NULL AND expiry_revision IS NULL)
 OR (notification_type='ACCOUNT_EXPIRED' AND audience='recipient' AND server_id IS NULL AND subject_uuid IS NOT NULL AND expiry_revision IS NOT NULL AND expiry_revision>0 AND typeof(expiry_revision)='integer'))
);
INSERT INTO admin_notifications_next(id,notification_type,occurred_at,audience,recipient_uuid,server_id,resolved)
 SELECT id,notification_type,occurred_at,audience,recipient_uuid,server_id,resolved FROM admin_notifications;
DROP TABLE admin_notifications;
ALTER TABLE admin_notifications_next RENAME TO admin_notifications;
UPDATE sqlite_sequence SET seq=max(seq,coalesce((SELECT max(seq) FROM expiry_notice_sequence),0)) WHERE name='admin_notifications';
INSERT INTO sqlite_sequence(name,seq) SELECT 'admin_notifications',seq FROM expiry_notice_sequence WHERE NOT EXISTS(SELECT 1 FROM sqlite_sequence WHERE name='admin_notifications');
DROP TABLE expiry_notice_sequence;
CREATE UNIQUE INDEX admin_server_notice ON admin_notifications(server_id,notification_type) WHERE audience='administrators';
CREATE UNIQUE INDEX local_expiry_notice ON admin_notifications(subject_uuid,expiry_revision) WHERE notification_type='ACCOUNT_EXPIRED';
CREATE TABLE admin_notification_receipts(
 user_uuid TEXT NOT NULL REFERENCES user_accounts(uuid) ON DELETE CASCADE,
 notification_id INTEGER NOT NULL REFERENCES admin_notifications(id) ON DELETE CASCADE,
 is_read INTEGER NOT NULL DEFAULT 0 CHECK(is_read IN (0,1)),
 dismissed INTEGER NOT NULL DEFAULT 0 CHECK(dismissed IN (0,1)),
 PRIMARY KEY(user_uuid,notification_id)
);
INSERT INTO admin_notification_receipts SELECT * FROM expiry_notice_receipts;
DROP TABLE expiry_notice_receipts;
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
CREATE TRIGGER admin_notice_signal_insert AFTER INSERT ON admin_notifications BEGIN
 INSERT INTO admin_notification_signals VALUES(CASE WHEN NEW.audience='administrators' THEN 'administrators' ELSE NEW.recipient_uuid END,1)
 ON CONFLICT(scope) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER admin_notice_signal_delete AFTER DELETE ON admin_notifications BEGIN
 INSERT INTO admin_notification_signals VALUES(CASE WHEN OLD.audience='administrators' THEN 'administrators' ELSE OLD.recipient_uuid END,1)
 ON CONFLICT(scope) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER admin_notice_signal_update AFTER UPDATE ON admin_notifications BEGIN
 INSERT INTO admin_notification_signals VALUES(CASE WHEN OLD.audience='administrators' THEN 'administrators' ELSE OLD.recipient_uuid END,1)
 ON CONFLICT(scope) DO UPDATE SET revision=revision+1;
 INSERT INTO admin_notification_signals VALUES(CASE WHEN NEW.audience='administrators' THEN 'administrators' ELSE NEW.recipient_uuid END,1)
 ON CONFLICT(scope) DO UPDATE SET revision=revision+1;
END;
