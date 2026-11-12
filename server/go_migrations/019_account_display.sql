ALTER TABLE user_accounts ADD COLUMN display_preferences TEXT NOT NULL
DEFAULT '{"mode":"device","time_format":"12","time_zone":null}'
CHECK (json_valid(display_preferences));
