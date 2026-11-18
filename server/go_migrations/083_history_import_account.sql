-- Per-person imports (HISTORY_TOOLBAR_DESIGN.md): a run that imports one
-- account's history records that account; NULL is a full import of the server.
-- Audiobookshelf sessions also bring how long they were listened to, for the
-- History tab's Listened column; NULL when unknown or never reported.
ALTER TABLE history_import_runs ADD COLUMN account_id TEXT CHECK(account_id IS NULL OR length(account_id) BETWEEN 1 AND 64);
ALTER TABLE history_imports ADD COLUMN listened_seconds INTEGER CHECK(listened_seconds IS NULL OR listened_seconds>=0);
