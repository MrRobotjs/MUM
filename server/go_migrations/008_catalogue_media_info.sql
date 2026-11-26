-- Technical details of an item's file (container, bitrate, codecs, resolution,
-- frame rate, audio channels, size) saved by library syncs as one JSON object.
ALTER TABLE media_items ADD COLUMN media_info TEXT CHECK(media_info IS NULL OR (json_valid(media_info) AND json_type(media_info)='object' AND length(media_info)<=4096));
