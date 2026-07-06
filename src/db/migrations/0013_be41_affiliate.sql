-- BE-41: Healthy Alternatives + Affiliate Engine
-- Tables: affiliate_partners, affiliate_clicks, affiliate_revenue.
-- See server/src/db/schema/affiliate.ts for the Drizzle equivalent.

CREATE TABLE IF NOT EXISTS affiliate_partners (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL UNIQUE,
  affiliate_id  TEXT NOT NULL,
  link_template TEXT NOT NULL,
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS affiliate_partners_active_idx
  ON affiliate_partners(is_active);

CREATE TABLE IF NOT EXISTS affiliate_clicks (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                  UUID REFERENCES users(id) ON DELETE SET NULL,
  source_product_ean       TEXT NOT NULL,
  alternative_product_ean  TEXT NOT NULL,
  partner_id               UUID NOT NULL REFERENCES affiliate_partners(id),
  clicked_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS affiliate_clicks_partner_idx
  ON affiliate_clicks(partner_id);
CREATE INDEX IF NOT EXISTS affiliate_clicks_user_idx
  ON affiliate_clicks(user_id);
CREATE INDEX IF NOT EXISTS affiliate_clicks_clicked_at_idx
  ON affiliate_clicks(clicked_at);
CREATE INDEX IF NOT EXISTS affiliate_clicks_source_ean_idx
  ON affiliate_clicks(source_product_ean);

CREATE TABLE IF NOT EXISTS affiliate_revenue (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id           UUID NOT NULL REFERENCES affiliate_partners(id),
  amount_paise         INT NOT NULL,
  attributed_click_id  UUID REFERENCES affiliate_clicks(id),
  reported_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS affiliate_revenue_partner_idx
  ON affiliate_revenue(partner_id);
CREATE INDEX IF NOT EXISTS affiliate_revenue_reported_at_idx
  ON affiliate_revenue(reported_at);
CREATE INDEX IF NOT EXISTS affiliate_revenue_click_idx
  ON affiliate_revenue(attributed_click_id);
