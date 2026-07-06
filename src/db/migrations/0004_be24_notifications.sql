-- BE-24 — Notifications & Background Jobs.
--
-- Four tables, five enums:
--   1. `notification_status`        enum (7 states)
--   2. `notification_channel`       enum (4 channels)
--   3. `notification_priority`      enum (4 levels)
--   4. `notification_category`      enum (9 categories — incl. v2 ADDENDUM)
--   5. `device_platform`            enum (3 platforms)
--   6. `notifications`              table — log of every send attempt
--   7. `notification_preferences`   table — per-user knobs (1 row per user)
--   8. `notification_templates`     table — DB-stored template overrides
--   9. `device_tokens`              table — FCM tokens with active flag
--
-- Idempotent: every CREATE / ALTER guards itself with IF NOT EXISTS or
-- DO blocks, so re-running the migration is safe.

-- ───── Enums ──────────────────────────────────────────────────────

DO $$ BEGIN
  CREATE TYPE notification_status AS ENUM (
    'queued',
    'sent',
    'delivered',
    'read',
    'failed',
    'bounced',
    'skipped'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE notification_channel AS ENUM (
    'email',
    'sms',
    'push',
    'in-app'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE notification_priority AS ENUM (
    'low',
    'normal',
    'high',
    'urgent'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE notification_category AS ENUM (
    'auth',
    'expiry-alert',
    'task',
    'report',
    'system',
    'marketing',
    'recall-alert',
    'daily-insights',
    'business-activation'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE device_platform AS ENUM ('ios', 'android', 'web');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ───── notifications ──────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS notifications (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),

  tenant_id               uuid NOT NULL,
  user_id                 uuid NOT NULL,

  category                notification_category NOT NULL,
  template                varchar(50),

  subject                 varchar(200) NOT NULL,
  body                    varchar(2000) NOT NULL,
  body_html               varchar(10000),

  priority                notification_priority NOT NULL DEFAULT 'normal',

  channels                jsonb NOT NULL DEFAULT '[]'::jsonb,

  email_status            notification_status,
  sms_status              notification_status,
  push_status             notification_status,
  in_app_status           notification_status,

  is_read                 boolean NOT NULL DEFAULT false,
  read_at                 timestamptz,

  sent_at                 timestamptz,
  scheduled_for           timestamptz,
  failed_at               timestamptz,
  attempt_count           integer NOT NULL DEFAULT 0,

  related_resource_type   varchar(50),
  related_resource_id     uuid,

  data                    jsonb DEFAULT '{}'::jsonb,
  error                   varchar(1000)
);

CREATE INDEX IF NOT EXISTS notifications_user_created_idx
  ON notifications (user_id, created_at);
CREATE INDEX IF NOT EXISTS notifications_tenant_created_idx
  ON notifications (tenant_id, created_at);
CREATE INDEX IF NOT EXISTS notifications_user_unread_idx
  ON notifications (user_id, is_read);
CREATE INDEX IF NOT EXISTS notifications_category_idx
  ON notifications (tenant_id, category);
CREATE INDEX IF NOT EXISTS notifications_scheduled_idx
  ON notifications (scheduled_for);
CREATE INDEX IF NOT EXISTS notifications_related_idx
  ON notifications (related_resource_type, related_resource_id);

-- ───── notification_preferences ───────────────────────────────────

CREATE TABLE IF NOT EXISTS notification_preferences (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),

  user_id                 uuid NOT NULL,
  tenant_id               uuid,

  email_enabled           boolean NOT NULL DEFAULT true,
  sms_enabled             boolean NOT NULL DEFAULT true,
  push_enabled            boolean NOT NULL DEFAULT true,
  in_app_enabled          boolean NOT NULL DEFAULT true,

  category_opt_ins        jsonb NOT NULL DEFAULT '{}'::jsonb,

  quiet_hours_enabled     boolean NOT NULL DEFAULT false,
  quiet_hours_start       varchar(5),
  quiet_hours_end         varchar(5),
  timezone                varchar(64) NOT NULL DEFAULT 'Asia/Kolkata',

  digest_frequency        varchar(16) NOT NULL DEFAULT 'realtime'
);

CREATE UNIQUE INDEX IF NOT EXISTS notification_preferences_user_uniq
  ON notification_preferences (user_id);

-- ───── notification_templates ─────────────────────────────────────

CREATE TABLE IF NOT EXISTS notification_templates (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  deleted_at              timestamptz,
  created_by              uuid,
  updated_by              uuid,
  deleted_by              uuid,

  tenant_id               uuid,

  key                     varchar(50) NOT NULL,
  locale                  varchar(8) NOT NULL DEFAULT 'en',

  subject                 varchar(200) NOT NULL,
  body                    varchar(2000) NOT NULL,
  body_html               varchar(10000),
  sms_text                varchar(480),
  push_title              varchar(200),
  push_body               varchar(500),

  category                notification_category NOT NULL,
  default_channels        jsonb NOT NULL DEFAULT '[]'::jsonb,

  is_active               boolean NOT NULL DEFAULT true,
  metadata                jsonb DEFAULT '{}'::jsonb
);

CREATE UNIQUE INDEX IF NOT EXISTS notification_templates_tenant_key_uniq
  ON notification_templates (tenant_id, key, locale)
  WHERE tenant_id IS NOT NULL AND deleted_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS notification_templates_global_key_uniq
  ON notification_templates (key, locale)
  WHERE tenant_id IS NULL AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS notification_templates_key_idx
  ON notification_templates (key);

-- ───── device_tokens ──────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS device_tokens (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),

  user_id                 uuid NOT NULL,
  tenant_id               uuid,

  token                   varchar(500) NOT NULL,
  platform                device_platform NOT NULL,

  device_id               varchar(255),
  app_version             varchar(32),

  is_active               boolean NOT NULL DEFAULT true,
  invalidated_at          timestamptz,
  invalidation_reason     varchar(64),

  last_used_at            timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS device_tokens_token_uniq
  ON device_tokens (token);
CREATE INDEX IF NOT EXISTS device_tokens_user_idx
  ON device_tokens (user_id, is_active);
CREATE INDEX IF NOT EXISTS device_tokens_active_idx
  ON device_tokens (is_active);
