-- Existing single-customer records remain in the local-default account.
CREATE TABLE IF NOT EXISTS customer_accounts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO customer_accounts(id,name) VALUES('local-default','Existing workspace') ON CONFLICT(id) DO NOTHING;

ALTER TABLE app_users ADD COLUMN IF NOT EXISTS account_id TEXT NOT NULL DEFAULT 'local-default';
ALTER TABLE feature_records ADD COLUMN IF NOT EXISTS account_id TEXT NOT NULL DEFAULT 'local-default';
ALTER TABLE analysis_results ADD COLUMN IF NOT EXISTS account_id TEXT NOT NULL DEFAULT 'local-default';
ALTER TABLE audit_events ADD COLUMN IF NOT EXISTS account_id TEXT NOT NULL DEFAULT 'local-default';
ALTER TABLE statement_ingests ADD COLUMN IF NOT EXISTS account_id TEXT NOT NULL DEFAULT 'local-default';
ALTER TABLE statement_lines ADD COLUMN IF NOT EXISTS account_id TEXT NOT NULL DEFAULT 'local-default';

ALTER TABLE feature_records DROP CONSTRAINT IF EXISTS feature_records_reference_key;
DROP INDEX IF EXISTS statement_ingests_feature_checksum_idx;
CREATE UNIQUE INDEX IF NOT EXISTS feature_records_account_reference_idx ON feature_records(account_id,reference);
CREATE UNIQUE INDEX IF NOT EXISTS statement_ingests_account_feature_checksum_idx ON statement_ingests(account_id,feature_id,checksum);
CREATE UNIQUE INDEX IF NOT EXISTS statement_ingests_id_account_idx ON statement_ingests(id,account_id);
CREATE UNIQUE INDEX IF NOT EXISTS statement_lines_id_account_idx ON statement_lines(id,account_id);
CREATE INDEX IF NOT EXISTS feature_records_account_feature_idx ON feature_records(account_id,feature_id);
CREATE INDEX IF NOT EXISTS statement_lines_account_feature_idx ON statement_lines(account_id,feature_id);
CREATE INDEX IF NOT EXISTS audit_events_account_time_idx ON audit_events(account_id,event_time DESC);

DO $$
DECLARE table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['app_users','feature_records','analysis_results','audit_events','statement_ingests','statement_lines'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = table_name || '_account_id_fkey') THEN
      EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (account_id) REFERENCES customer_accounts(id)', table_name, table_name || '_account_id_fkey');
    END IF;
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='statement_lines_account_ingest_fkey') THEN
    ALTER TABLE statement_lines ADD CONSTRAINT statement_lines_account_ingest_fkey FOREIGN KEY (ingest_id,account_id) REFERENCES statement_ingests(id,account_id);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS recovery_claims (
  id BIGSERIAL PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES customer_accounts(id),
  feature_id TEXT NOT NULL,
  record_reference TEXT NOT NULL,
  statement_line_id BIGINT NOT NULL UNIQUE,
  requested_cents BIGINT NOT NULL CHECK(requested_cents > 0),
  credit_cents BIGINT NOT NULL DEFAULT 0 CHECK(credit_cents >= 0),
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK(status IN ('DRAFT','SUBMITTED','ACKNOWLEDGED','REJECTED','PARTIAL_CREDIT','CREDIT_EVIDENCED')),
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (statement_line_id,account_id) REFERENCES statement_lines(id,account_id)
);
CREATE INDEX IF NOT EXISTS recovery_claims_account_status_idx ON recovery_claims(account_id,status);
CREATE UNIQUE INDEX IF NOT EXISTS recovery_claims_id_account_idx ON recovery_claims(id,account_id);

CREATE TABLE IF NOT EXISTS claim_events (
  id BIGSERIAL PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES customer_accounts(id),
  claim_id BIGINT NOT NULL,
  event_type TEXT NOT NULL CHECK(event_type IN ('SUBMITTED','ACKNOWLEDGED','REJECTED')),
  external_reference TEXT NOT NULL,
  evidence_text TEXT NOT NULL,
  evidence_hash TEXT NOT NULL,
  recorded_by TEXT NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (claim_id,account_id) REFERENCES recovery_claims(id,account_id)
);
CREATE INDEX IF NOT EXISTS claim_events_account_claim_idx ON claim_events(account_id,claim_id);

CREATE TABLE IF NOT EXISTS claim_credit_evidence (
  id BIGSERIAL PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES customer_accounts(id),
  claim_id BIGINT NOT NULL,
  credit_line_id BIGINT NOT NULL UNIQUE,
  credit_cents BIGINT NOT NULL CHECK(credit_cents > 0),
  issuer_reference TEXT NOT NULL,
  recorded_by TEXT NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (claim_id,account_id) REFERENCES recovery_claims(id,account_id),
  FOREIGN KEY (credit_line_id,account_id) REFERENCES statement_lines(id,account_id)
);
CREATE INDEX IF NOT EXISTS claim_credit_evidence_account_claim_idx ON claim_credit_evidence(account_id,claim_id);
