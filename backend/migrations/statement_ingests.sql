CREATE TABLE IF NOT EXISTS statement_ingests (
  id SERIAL PRIMARY KEY,
  checksum TEXT NOT NULL,
  source_file TEXT,
  row_count INTEGER NOT NULL DEFAULT 0,
  rejected_count INTEGER NOT NULL DEFAULT 0,
  created_by TEXT,
  ingested_at TIMESTAMP NOT NULL DEFAULT NOW()
);
ALTER TABLE statement_ingests ADD COLUMN IF NOT EXISTS feature_id TEXT;
ALTER TABLE statement_ingests DROP CONSTRAINT IF EXISTS statement_ingests_checksum_key;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='statement_ingests' AND column_name='account_id') THEN
    CREATE UNIQUE INDEX IF NOT EXISTS statement_ingests_feature_checksum_idx ON statement_ingests(feature_id, checksum);
  END IF;
END $$;
ALTER TABLE statement_ingests ADD COLUMN IF NOT EXISTS assumed_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE statement_ingests ADD COLUMN IF NOT EXISTS confirmed_recovery NUMERIC(16,2) NOT NULL DEFAULT 0;
ALTER TABLE statement_ingests ADD COLUMN IF NOT EXISTS reconciliation JSONB NOT NULL DEFAULT '{}'::jsonb;
CREATE TABLE IF NOT EXISTS statement_lines (
  id BIGSERIAL PRIMARY KEY,
  ingest_id INTEGER NOT NULL REFERENCES statement_ingests(id) ON DELETE CASCADE,
  feature_id TEXT NOT NULL,
  source_file TEXT NOT NULL,
  checksum TEXT NOT NULL,
  line_number INTEGER NOT NULL,
  reference TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  amount NUMERIC(16,2),
  currency TEXT NOT NULL DEFAULT 'USD',
  statement_date TEXT,
  reconciliation_status TEXT NOT NULL,
  record_reference TEXT,
  expected_amount NUMERIC(16,2),
  delta NUMERIC(16,2),
  rejection_reason TEXT,
  provenance JSONB NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (ingest_id, line_number)
);
CREATE INDEX IF NOT EXISTS idx_statement_lines_ingest ON statement_lines(ingest_id);
CREATE INDEX IF NOT EXISTS idx_statement_lines_feature ON statement_lines(feature_id);
