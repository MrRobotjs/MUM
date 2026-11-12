-- The Users page "Mass Edit" feature is called Edit everywhere (user decision
-- 2026-11-12): its tables, index and recorded audit actions are renamed from
-- "bulk" to "edit". Foreign keys between these tables follow the rename.
ALTER TABLE bulk_operations RENAME TO edit_operations;
ALTER TABLE bulk_source_locks RENAME TO edit_source_locks;
ALTER TABLE bulk_removed_identities RENAME TO edit_removed_identities;
DROP INDEX bulk_operations_actor;
CREATE INDEX edit_operations_actor ON edit_operations(actor_uuid,created_at);
UPDATE audit_events SET action='edit.'||substr(action,6) WHERE action LIKE 'bulk.%';
