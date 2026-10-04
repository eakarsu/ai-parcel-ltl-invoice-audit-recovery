-- Account-scoped operator-imported tariff text, independently approved rules, immutable assessments.
CREATE UNIQUE INDEX IF NOT EXISTS app_users_id_account_idx ON app_users(id,account_id);
CREATE TABLE IF NOT EXISTS parcel_tariff_sources (
 id BIGSERIAL PRIMARY KEY,
 account_id TEXT NOT NULL REFERENCES customer_accounts(id),
 source_file TEXT NOT NULL,
 content TEXT NOT NULL,
 content_hash TEXT NOT NULL,
 created_by_id BIGINT NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 FOREIGN KEY (created_by_id,account_id) REFERENCES app_users(id,account_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS parcel_tariff_sources_id_account_idx ON parcel_tariff_sources(id,account_id);
CREATE INDEX IF NOT EXISTS parcel_tariff_sources_account_idx ON parcel_tariff_sources(account_id,created_at DESC);

CREATE TABLE IF NOT EXISTS parcel_tariff_rules (
 id BIGSERIAL PRIMARY KEY,
 account_id TEXT NOT NULL REFERENCES customer_accounts(id),
 carrier_key TEXT NOT NULL,
 carrier_label TEXT NOT NULL,
 feature_id TEXT NOT NULL CHECK(feature_id IN ('fuel-surcharge-audit','accessorial-charge-validation')),
 charge_type_key TEXT NOT NULL,
 charge_type_label TEXT NOT NULL,
 method TEXT NOT NULL CHECK(method IN ('PERCENT_OF_BASE','FIXED_PER_SHIPMENT')),
 percent_units BIGINT CHECK(percent_units BETWEEN 0 AND 1000000),
 fixed_cents BIGINT CHECK(fixed_cents >= 0),
 effective_on DATE NOT NULL,
 expires_on DATE NOT NULL,
 source_id BIGINT NOT NULL,
 source_line INTEGER NOT NULL CHECK(source_line > 0),
 source_quote TEXT NOT NULL,
 version INTEGER NOT NULL CHECK(version > 0),
 status TEXT NOT NULL DEFAULT 'DRAFT' CHECK(status IN ('DRAFT','APPROVED','SUPERSEDED')),
 created_by_id BIGINT NOT NULL,
 approved_by_id BIGINT,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 approved_at TIMESTAMPTZ,
 CHECK(effective_on <= expires_on),
 CHECK((method='PERCENT_OF_BASE' AND percent_units IS NOT NULL AND fixed_cents IS NULL)
    OR (method='FIXED_PER_SHIPMENT' AND fixed_cents IS NOT NULL AND percent_units IS NULL)),
 UNIQUE(account_id,carrier_key,feature_id,charge_type_key,version),
 FOREIGN KEY (source_id,account_id) REFERENCES parcel_tariff_sources(id,account_id),
 FOREIGN KEY (created_by_id,account_id) REFERENCES app_users(id,account_id),
 FOREIGN KEY (approved_by_id,account_id) REFERENCES app_users(id,account_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS parcel_tariff_rules_id_account_idx ON parcel_tariff_rules(id,account_id);
CREATE UNIQUE INDEX IF NOT EXISTS parcel_tariff_rules_one_approved_idx ON parcel_tariff_rules(account_id,carrier_key,feature_id,charge_type_key) WHERE status='APPROVED';
CREATE INDEX IF NOT EXISTS parcel_tariff_rules_account_idx ON parcel_tariff_rules(account_id,carrier_key,feature_id);

CREATE TABLE IF NOT EXISTS parcel_surcharge_assessments (
 id BIGSERIAL PRIMARY KEY,
 account_id TEXT NOT NULL REFERENCES customer_accounts(id),
 rule_id BIGINT NOT NULL,
 statement_line_id BIGINT NOT NULL,
 observed_cents BIGINT NOT NULL,
 expected_cents BIGINT,
 variance_cents BIGINT,
 status TEXT NOT NULL CHECK(status IN ('CANDIDATE','NO_VARIANCE','INSUFFICIENT')),
 calculation JSONB NOT NULL,
 assessed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 UNIQUE(rule_id,statement_line_id),
 FOREIGN KEY (rule_id,account_id) REFERENCES parcel_tariff_rules(id,account_id),
 FOREIGN KEY (statement_line_id,account_id) REFERENCES statement_lines(id,account_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS parcel_surcharge_assessments_id_account_idx ON parcel_surcharge_assessments(id,account_id);
CREATE UNIQUE INDEX IF NOT EXISTS parcel_surcharge_assessments_claim_link_idx ON parcel_surcharge_assessments(id,account_id,statement_line_id);
CREATE INDEX IF NOT EXISTS parcel_surcharge_assessments_account_rule_idx ON parcel_surcharge_assessments(account_id,rule_id,status);

ALTER TABLE recovery_claims ADD COLUMN IF NOT EXISTS parcel_assessment_id BIGINT;
CREATE UNIQUE INDEX IF NOT EXISTS recovery_claims_parcel_assessment_idx ON recovery_claims(parcel_assessment_id) WHERE parcel_assessment_id IS NOT NULL;
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='recovery_claims_parcel_assessment_account_fkey') THEN
  ALTER TABLE recovery_claims ADD CONSTRAINT recovery_claims_parcel_assessment_account_fkey
   FOREIGN KEY (parcel_assessment_id,account_id) REFERENCES parcel_surcharge_assessments(id,account_id);
 END IF;
END $$;
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='recovery_claims_parcel_assessment_line_fkey') THEN
  ALTER TABLE recovery_claims ADD CONSTRAINT recovery_claims_parcel_assessment_line_fkey
   FOREIGN KEY (parcel_assessment_id,account_id,statement_line_id)
   REFERENCES parcel_surcharge_assessments(id,account_id,statement_line_id);
 END IF;
END $$;
