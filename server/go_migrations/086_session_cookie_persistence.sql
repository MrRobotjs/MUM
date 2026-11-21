ALTER TABLE app_sessions ADD COLUMN remember_device INTEGER NOT NULL DEFAULT 1 CHECK(remember_device IN (0,1));
