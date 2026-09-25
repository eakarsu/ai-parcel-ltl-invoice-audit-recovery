CREATE TABLE IF NOT EXISTS statement_ingests (
  id SERIAL PRIMARY KEY,
  checksum TEXT NOT NULL UNIQUE,
  source_file TEXT,
  row_count INTEGER NOT NULL DEFAULT 0,
  rejected_count INTEGER NOT NULL DEFAULT 0,
  created_by TEXT,
  ingested_at TIMESTAMP NOT NULL DEFAULT NOW()
);
