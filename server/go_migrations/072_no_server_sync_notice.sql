-- Adding a server no longer raises a "not synced yet" notification (user
-- decision 2026-11-15). Clear the ones already stored; their receipts go with
-- them. The notification kind stays allowed for future use.
DELETE FROM admin_notifications WHERE notification_type='SERVER_NOT_SYNCED';
