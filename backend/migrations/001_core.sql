CREATE TABLE IF NOT EXISTS app_users (
  id BIGSERIAL PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','operator','reviewer')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS feature_records (
  id BIGSERIAL PRIMARY KEY,
  feature_id TEXT NOT NULL,
  reference TEXT UNIQUE NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'Open',
  owner TEXT NOT NULL,
  risk TEXT NOT NULL DEFAULT 'Moderate',
  due_date DATE NOT NULL,
  amount NUMERIC(16,2) NOT NULL DEFAULT 0,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_feature_records_feature ON feature_records(feature_id);
CREATE INDEX IF NOT EXISTS idx_feature_records_status ON feature_records(status);
CREATE TABLE IF NOT EXISTS analysis_results (
  id BIGSERIAL PRIMARY KEY,
  feature_id TEXT NOT NULL,
  record_reference TEXT,
  analysis_type TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  result JSONB NOT NULL,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS audit_events (
  id BIGSERIAL PRIMARY KEY,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  object_type TEXT NOT NULL,
  object_reference TEXT NOT NULL,
  detail TEXT NOT NULL,
  event_time TIMESTAMPTZ NOT NULL DEFAULT now()
);
