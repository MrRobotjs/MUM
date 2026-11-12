-- Preserve complete source records, including fields absent from current models.
CREATE TABLE legacy_records (
    source_table TEXT NOT NULL,
    row_number INTEGER NOT NULL,
    record TEXT NOT NULL CHECK (json_valid(record)),
    PRIMARY KEY (source_table, row_number)
);
