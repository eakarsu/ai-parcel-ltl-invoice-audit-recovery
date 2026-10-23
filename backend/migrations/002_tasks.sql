CREATE TABLE IF NOT EXISTS staff_tasks(
  id BIGSERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'OPEN',
  priority TEXT NOT NULL DEFAULT 'NORMAL',
  due_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_by BIGINT NOT NULL,
  assignee_id BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_staff_tasks_status_due ON staff_tasks(status, due_at);
