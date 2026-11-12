ALTER TABLE activity_monitor_schedules ADD COLUMN socket_enabled INTEGER NOT NULL DEFAULT 0 CHECK(socket_enabled IN (0,1));
ALTER TABLE activity_monitor_schedules ADD COLUMN socket_revision INTEGER NOT NULL DEFAULT 1 CHECK(socket_revision>0);
