-- BE-30 — Client In-App Dashboard (v2 ADDENDUM)
-- Table: operational_health_scores (OHS history for the Operational
-- Health Score gauge + 30-day trend on the Client Dashboard).
--
-- Numbering: 0010 is intentional. BE-27 / BE-28 / BE-29 ship in the
-- same wave as BE-30 and the orchestrator has reserved 0007 / 0008 /
-- 0009 for those three. Taking 0010 here keeps the wave's migration
-- numbers contiguous without anyone re-renaming files when the
-- siblings land.
--
-- Idempotent: every CREATE checks IF NOT EXISTS so re-running on a
-- dev DB doesn't fail.

CREATE TABLE IF NOT EXISTS operational_health_scores (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),

  tenant_id                   UUID NOT NULL,
  -- Nullable so a future tenant-level rollup can sit beside store rows.
  store_id                    UUID,

  computed_for_date           DATE NOT NULL,
  algorithm_version           VARCHAR(20) NOT NULL,

  total_score                 NUMERIC(5, 2) NOT NULL CHECK (total_score BETWEEN 0 AND 100),
  compliance_component        NUMERIC(5, 2) NOT NULL CHECK (compliance_component BETWEEN 0 AND 100),
  expiry_component            NUMERIC(5, 2) NOT NULL CHECK (expiry_component BETWEEN 0 AND 100),
  inventory_component         NUMERIC(5, 2) NOT NULL CHECK (inventory_component BETWEEN 0 AND 100),
  task_component              NUMERIC(5, 2) NOT NULL CHECK (task_component BETWEEN 0 AND 100),
  team_activity_component     NUMERIC(5, 2) NOT NULL CHECK (team_activity_component BETWEEN 0 AND 100),
  vendor_quality_component    NUMERIC(5, 2) NOT NULL CHECK (vendor_quality_component BETWEEN 0 AND 100),

  raw_inputs                  JSONB NOT NULL DEFAULT '{}'::jsonb,

  computed_at                 TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ohs_trend
  ON operational_health_scores (tenant_id, store_id, computed_for_date);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_ohs_tenant_store_date_alg
  ON operational_health_scores (tenant_id, store_id, computed_for_date, algorithm_version);
