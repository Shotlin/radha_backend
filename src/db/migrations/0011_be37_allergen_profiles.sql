-- BE-37: Allergen Profile (per-family-member)

CREATE TABLE allergen_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  family_member_user_id UUID REFERENCES users(id),
  display_name_encrypted BYTEA NOT NULL,
  age_band TEXT NOT NULL CHECK (age_band IN ('infant','toddler','child','adolescent','adult','senior')),
  allergy_tags TEXT[] NOT NULL DEFAULT '{}',
  condition_tags TEXT[] NOT NULL DEFAULT '{}',
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes
CREATE INDEX idx_allergen_profiles_tenant_user ON allergen_profiles (tenant_id, user_id);
CREATE INDEX idx_allergen_profiles_user_active ON allergen_profiles (user_id, is_active);
CREATE INDEX idx_allergen_profiles_family_member ON allergen_profiles (family_member_user_id);

-- Row Level Security
ALTER TABLE allergen_profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY allergen_tenant_isolation ON allergen_profiles
  USING (tenant_id::text = current_setting('app.tenant_id', true));
