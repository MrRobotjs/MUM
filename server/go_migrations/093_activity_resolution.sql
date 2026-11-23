-- Retain explicitly observed video resolutions; NULL means unavailable.
ALTER TABLE media_activity_history ADD COLUMN source_resolution TEXT CHECK(source_resolution IS NULL OR length(source_resolution) BETWEEN 2 AND 8);
ALTER TABLE media_activity_history ADD COLUMN stream_resolution TEXT CHECK(stream_resolution IS NULL OR length(stream_resolution) BETWEEN 2 AND 8);
