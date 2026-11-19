-- When the current pause of a recorded play began, so pauses are timed
-- exactly from Plex's notifications, and a pause that spans several reads or
-- a restart keeps its
-- start. NULL when the play isn't paused, and for every play before this.
ALTER TABLE media_activity_history ADD COLUMN paused_since TEXT;
