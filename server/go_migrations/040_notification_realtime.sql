-- Durable, coalesced invalidation counters: no notification data or event history.
CREATE TABLE admin_notification_signals (
 scope TEXT PRIMARY KEY,
 revision INTEGER NOT NULL CHECK(revision>0)
);
INSERT INTO admin_notification_signals VALUES('administrators',1);
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
