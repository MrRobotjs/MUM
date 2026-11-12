ALTER TABLE provisioning_jobs ADD COLUMN review_operation TEXT CHECK(review_operation IS NULL OR review_operation='resume');
ALTER TABLE provisioning_steps ADD COLUMN resume_state TEXT NOT NULL DEFAULT 'pending' CHECK(resume_state IN ('pending','running','completed','failed','unknown'));
ALTER TABLE provisioning_steps ADD COLUMN resume_error_code TEXT;
