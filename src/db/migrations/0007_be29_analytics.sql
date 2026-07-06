-- BE-29 — Analytics & Lead Ingestion
--
-- Tables:
--   1. website_events       — public marketing site events (no PII)
--   2. marketing_leads      — inbound contact / demo leads
--   3. app_usage_events     — authenticated mobile event log
--   4. owner_daily_metrics  — pre-aggregated platform KPIs
--
-- Enums:
--   1. website_event_type   (11 values)
--   2. lead_source          (7 values)
--   3. lead_status          (8 values)
--   4. app_event_type       (5 values)
--
-- Numbering note: BE-29's phase doc lists 0009 (reserving 0007/0008
-- for BE-27/BE-28). At commit time, BE-27 and BE-28 had not yet
-- shipped migrations, so 0007 is the next free integer per the
-- monotonic-numbering rule. If BE-27/BE-28 land later, they will
-- take 0008/0009.
--
-- Idempotent: every CREATE / DO block is guarded with IF NOT EXISTS
-- or duplicate_object handlers, so re-applying this migration in a
-- partially-migrated dev environment is safe.

-- ───── Enums ────────────────────────────────────────────────────────

DO $$ BEGIN
  CREATE TYPE website_event_type AS ENUM (
    'page_view',
    'button_click',
    'pricing_view',
    'demo_click',
    'contact_click',
    'whatsapp_click',
    'app_download_click',
    'feature_view',
    'scroll_depth',
    'video_play',
    'form_submit'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE lead_source AS ENUM (
    'contact_form',
    'demo_request',
    'whatsapp',
    'phone',
    'email',
    'referral',
    'other'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE lead_status AS ENUM (
    'new',
    'contacted',
    'qualified',
    'demo_scheduled',
    'demo_completed',
    'converted',
    'lost',
    'spam'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE app_event_type AS ENUM (
    'screen_view',
    'feature_use',
    'error',
    'crash',
    'performance'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ───── website_events ──────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS website_events (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),

  type               website_event_type NOT NULL,

  page               VARCHAR(500),
  page_title         VARCHAR(200),
  referrer           VARCHAR(500),

  utm_source         VARCHAR(100),
  utm_medium         VARCHAR(100),
  utm_campaign       VARCHAR(200),
  utm_term           VARCHAR(200),
  utm_content        VARCHAR(200),

  user_agent         VARCHAR(500),
  browser            VARCHAR(50),
  os                 VARCHAR(50),
  device             VARCHAR(30),

  country            VARCHAR(2),

  session_id         VARCHAR(64),
  visitor_id_hash    VARCHAR(64),

  year_month_day     VARCHAR(10) NOT NULL,

  metadata           JSONB DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_website_events_type_date
  ON website_events (type, year_month_day);
CREATE INDEX IF NOT EXISTS idx_website_events_session
  ON website_events (session_id);
CREATE INDEX IF NOT EXISTS idx_website_events_visitor
  ON website_events (visitor_id_hash);
CREATE INDEX IF NOT EXISTS idx_website_events_utm_campaign
  ON website_events (utm_campaign);
CREATE INDEX IF NOT EXISTS idx_website_events_date
  ON website_events (year_month_day);

-- ───── marketing_leads ─────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS marketing_leads (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at          TIMESTAMPTZ,
  created_by          UUID,
  updated_by          UUID,
  deleted_by          UUID,

  name                VARCHAR(100) NOT NULL,
  email               VARCHAR(255) NOT NULL,
  mobile              VARCHAR(20),
  company             VARCHAR(200),
  message             VARCHAR(2000),

  source              lead_source NOT NULL,
  status              lead_status NOT NULL DEFAULT 'new',

  utm_source          VARCHAR(100),
  utm_medium          VARCHAR(100),
  utm_campaign        VARCHAR(200),

  page_url            VARCHAR(500),
  referrer            VARCHAR(500),

  contacted_at        TIMESTAMPTZ,
  contacted_by        UUID,
  demo_scheduled_at   TIMESTAMPTZ,
  converted_at        TIMESTAMPTZ,
  converted_tenant_id UUID,
  lost_at             TIMESTAMPTZ,
  lost_reason         VARCHAR(500),

  notes               VARCHAR(2000),
  assigned_to         UUID,

  metadata            JSONB DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_leads_status     ON marketing_leads (status);
CREATE INDEX IF NOT EXISTS idx_leads_source     ON marketing_leads (source);
CREATE INDEX IF NOT EXISTS idx_leads_email      ON marketing_leads (email);
CREATE INDEX IF NOT EXISTS idx_leads_converted  ON marketing_leads (converted_tenant_id);
CREATE INDEX IF NOT EXISTS idx_leads_created    ON marketing_leads (created_at);

-- ───── app_usage_events ────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS app_usage_events (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  tenant_id       UUID NOT NULL,
  user_id         UUID NOT NULL,
  store_id        UUID,

  event_type      app_event_type NOT NULL,
  category        VARCHAR(50) NOT NULL,
  action          VARCHAR(100) NOT NULL,
  label           VARCHAR(200),
  value           NUMERIC(14, 4),

  screen          VARCHAR(100),
  app_version     VARCHAR(20),
  platform        VARCHAR(10),
  device_model    VARCHAR(100),

  year_month_day  VARCHAR(10) NOT NULL,

  metadata        JSONB DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_app_events_tenant_date
  ON app_usage_events (tenant_id, year_month_day);
CREATE INDEX IF NOT EXISTS idx_app_events_user_date
  ON app_usage_events (user_id, year_month_day);
CREATE INDEX IF NOT EXISTS idx_app_events_type
  ON app_usage_events (event_type);
CREATE INDEX IF NOT EXISTS idx_app_events_action
  ON app_usage_events (category, action);

-- ───── owner_daily_metrics ─────────────────────────────────────────

CREATE TABLE IF NOT EXISTS owner_daily_metrics (
  id                            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at                    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                    TIMESTAMPTZ NOT NULL DEFAULT now(),

  date                          TIMESTAMPTZ NOT NULL,

  website_visitors              INTEGER NOT NULL DEFAULT 0,
  website_page_views            INTEGER NOT NULL DEFAULT 0,
  website_contact_clicks        INTEGER NOT NULL DEFAULT 0,
  website_pricing_views         INTEGER NOT NULL DEFAULT 0,
  website_app_download_clicks   INTEGER NOT NULL DEFAULT 0,

  new_leads                     INTEGER NOT NULL DEFAULT 0,
  qualified_leads               INTEGER NOT NULL DEFAULT 0,
  converted_leads               INTEGER NOT NULL DEFAULT 0,

  new_tenants                   INTEGER NOT NULL DEFAULT 0,
  active_tenants                INTEGER NOT NULL DEFAULT 0,
  trial_tenants                 INTEGER NOT NULL DEFAULT 0,
  paid_tenants                  INTEGER NOT NULL DEFAULT 0,
  cancelled_tenants             INTEGER NOT NULL DEFAULT 0,

  starter_count                 INTEGER NOT NULL DEFAULT 0,
  growth_count                  INTEGER NOT NULL DEFAULT 0,
  pro_count                     INTEGER NOT NULL DEFAULT 0,

  mrr                           NUMERIC(14, 2) NOT NULL DEFAULT 0,
  new_mrr                       NUMERIC(14, 2) NOT NULL DEFAULT 0,
  churned_mrr                   NUMERIC(14, 2) NOT NULL DEFAULT 0,

  total_scans                   INTEGER NOT NULL DEFAULT 0,
  total_reports                 INTEGER NOT NULL DEFAULT 0,
  total_ai_calls                INTEGER NOT NULL DEFAULT 0,
  total_ean_validations         INTEGER NOT NULL DEFAULT 0,

  dau                           INTEGER NOT NULL DEFAULT 0,
  mau                           INTEGER NOT NULL DEFAULT 0,

  ai_cost                       NUMERIC(12, 6) NOT NULL DEFAULT 0,
  sms_cost                      NUMERIC(12, 6) NOT NULL DEFAULT 0,
  s3_cost                       NUMERIC(12, 6) NOT NULL DEFAULT 0,

  metadata                      JSONB DEFAULT '{}'::jsonb
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_owner_metrics_date
  ON owner_daily_metrics (date);
CREATE INDEX IF NOT EXISTS idx_owner_metrics_date
  ON owner_daily_metrics (date);
