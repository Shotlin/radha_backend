-- BE-34: Add onboarding segment columns to users table
-- Stores the user's self-selected segment from the onboarding screen.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS onboarding_segment TEXT
    CHECK (onboarding_segment IN ('personal','business_owner','parent','pharmacy','institution','auditor_invited')),
  ADD COLUMN IF NOT EXISTS onboarding_segment_selected_at TIMESTAMPTZ;

-- Index for querying users by onboarding segment (analytics/reporting).
CREATE INDEX IF NOT EXISTS users_onboarding_segment_idx ON users (onboarding_segment)
  WHERE onboarding_segment IS NOT NULL;
