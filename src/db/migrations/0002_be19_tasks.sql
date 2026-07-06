-- BE-19 — Task management
--
-- Five tables + 5 enums. Soft-delete + audit columns on `tasks`,
-- `task_evidence`, `task_templates`. `task_assignments` uses the
-- revoke-not-delete pattern; `task_events` is append-only.
--
-- Concurrency invariants enforced at the DB level:
--   * one **active** assignment per (task, user) via partial unique index
--   * one **active** task per expiry_alert_id via partial unique index
--   * one template name per tenant (excluding soft-deleted rows)

BEGIN;

-- ─────────────────── Enums ───────────────────

DO $$ BEGIN
  CREATE TYPE task_status AS ENUM (
    'pending',
    'in_progress',
    'completed',
    'rejected',
    'cancelled',
    'overdue'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE task_priority AS ENUM (
    'low',
    'medium',
    'high',
    'urgent'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE task_type AS ENUM (
    'expiry-check',
    'shelf-audit',
    'inventory-count',
    'price-update',
    'cleaning',
    'restock',
    'training',
    'maintenance',
    'other'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE task_assignment_role AS ENUM (
    'primary',
    'observer'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE task_event_type AS ENUM (
    'created',
    'assigned',
    'started',
    'updated',
    'completed',
    'rejected',
    'cancelled',
    'reassigned',
    'unassigned',
    'evidence_added',
    'evidence_removed',
    'comment',
    'status_changed',
    'overdue',
    'recurrence_spawned'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE task_evidence_type AS ENUM (
    'photo',
    'scan',
    'note',
    'video'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ─────────────────── tasks ───────────────────

CREATE TABLE IF NOT EXISTS tasks (
  id                              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at                      timestamptz NOT NULL DEFAULT now(),
  updated_at                      timestamptz NOT NULL DEFAULT now(),
  deleted_at                      timestamptz,
  created_by                      uuid,
  updated_by                      uuid,
  deleted_by                      uuid,
  tenant_id                       uuid NOT NULL,
  store_id                        uuid NOT NULL,
  title                           varchar(200) NOT NULL,
  description                     varchar(2000),
  type                            task_type NOT NULL,
  priority                        task_priority NOT NULL DEFAULT 'medium',
  status                          task_status NOT NULL DEFAULT 'pending',
  start_date                      timestamptz,
  due_date                        timestamptz,
  started_at                      timestamptz,
  completed_at                    timestamptz,
  estimated_duration_minutes      integer,
  actual_duration_minutes         integer,
  requires_photo                  boolean NOT NULL DEFAULT false,
  requires_scan                   boolean NOT NULL DEFAULT false,
  minimum_evidence_count          integer NOT NULL DEFAULT 0,
  expiry_alert_id                 uuid,
  product_ids                     jsonb NOT NULL DEFAULT '[]'::jsonb,
  scan_session_id                 uuid,
  template_id                     uuid,
  is_recurring                    boolean NOT NULL DEFAULT false,
  recurrence_pattern              jsonb,
  parent_task_id                  uuid,
  recurrence_occurrence_count     integer NOT NULL DEFAULT 0,
  evidence_count                  integer NOT NULL DEFAULT 0,
  assignee_count                  integer NOT NULL DEFAULT 0,
  overdue_marked_at               timestamptz,
  metadata                        jsonb DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_tasks_store_status_due
  ON tasks (store_id, status, due_date);
CREATE INDEX IF NOT EXISTS idx_tasks_tenant_status
  ON tasks (tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_tasks_tenant_type
  ON tasks (tenant_id, type);
CREATE INDEX IF NOT EXISTS idx_tasks_expiry_alert
  ON tasks (expiry_alert_id);
CREATE INDEX IF NOT EXISTS idx_tasks_parent
  ON tasks (parent_task_id);
CREATE INDEX IF NOT EXISTS idx_tasks_template
  ON tasks (template_id);
CREATE INDEX IF NOT EXISTS idx_tasks_due
  ON tasks (due_date);

CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_expiry_alert_active_uniq
  ON tasks (expiry_alert_id)
  WHERE expiry_alert_id IS NOT NULL AND deleted_at IS NULL;

-- ─────────────────── task_assignments ───────────────────

CREATE TABLE IF NOT EXISTS task_assignments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  task_id         uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  assignee_id     uuid NOT NULL,
  tenant_id       uuid NOT NULL,
  role            task_assignment_role NOT NULL DEFAULT 'primary',
  assigned_by     uuid NOT NULL,
  assigned_at     timestamptz NOT NULL DEFAULT now(),
  notified_at     timestamptz,
  acknowledged_at timestamptz,
  revoked_at      timestamptz,
  revoked_by      uuid,
  revoked_reason  varchar(500)
);

CREATE INDEX IF NOT EXISTS idx_task_assignments_task
  ON task_assignments (task_id);
CREATE INDEX IF NOT EXISTS idx_task_assignments_assignee
  ON task_assignments (assignee_id, tenant_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_task_assignments_active_uniq
  ON task_assignments (task_id, assignee_id)
  WHERE revoked_at IS NULL;

-- ─────────────────── task_events ───────────────────

CREATE TABLE IF NOT EXISTS task_events (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  task_id      uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  tenant_id    uuid NOT NULL,
  type         task_event_type NOT NULL,
  actor_id     uuid NOT NULL,
  from_status  task_status,
  to_status    task_status,
  notes        varchar(1000),
  metadata     jsonb DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_task_events_task_created
  ON task_events (task_id, created_at);
CREATE INDEX IF NOT EXISTS idx_task_events_type
  ON task_events (tenant_id, type);

-- ─────────────────── task_evidence ───────────────────

CREATE TABLE IF NOT EXISTS task_evidence (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz,
  task_id         uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  tenant_id       uuid NOT NULL,
  type            task_evidence_type NOT NULL,
  media_id        uuid,
  scan_session_id uuid,
  note            varchar(1000),
  added_by        uuid NOT NULL,
  metadata        jsonb DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_task_evidence_task
  ON task_evidence (task_id, created_at);
CREATE INDEX IF NOT EXISTS idx_task_evidence_type
  ON task_evidence (type);

-- ─────────────────── task_templates ───────────────────

CREATE TABLE IF NOT EXISTS task_templates (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  deleted_at                  timestamptz,
  created_by                  uuid,
  updated_by                  uuid,
  deleted_by                  uuid,
  tenant_id                   uuid NOT NULL,
  name                        varchar(200) NOT NULL,
  description                 varchar(2000),
  type                        task_type NOT NULL,
  priority                    task_priority NOT NULL DEFAULT 'medium',
  title_template              varchar(200) NOT NULL,
  default_due_offset_minutes  integer,
  estimated_duration_minutes  integer,
  requires_photo              boolean NOT NULL DEFAULT false,
  requires_scan               boolean NOT NULL DEFAULT false,
  minimum_evidence_count      integer NOT NULL DEFAULT 0,
  is_recurring                boolean NOT NULL DEFAULT false,
  recurrence_pattern          jsonb,
  is_active                   boolean NOT NULL DEFAULT true,
  metadata                    jsonb DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_task_templates_tenant_active
  ON task_templates (tenant_id, is_active);

CREATE UNIQUE INDEX IF NOT EXISTS idx_task_templates_name_uniq
  ON task_templates (tenant_id, name)
  WHERE deleted_at IS NULL;

COMMIT;
