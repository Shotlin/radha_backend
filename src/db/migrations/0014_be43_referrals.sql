-- BE-43: Referral Program (Req 42)
-- Adds referral_code + referred_by_user_id to users, and creates the
-- referral_rewards table that records per-grant audit rows.
--
-- See server/src/db/schema/users.ts and server/src/db/schema/referrals.ts
-- for the Drizzle equivalents.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS referral_code TEXT,
  ADD COLUMN IF NOT EXISTS referred_by_user_id UUID
    REFERENCES users(id);

CREATE UNIQUE INDEX IF NOT EXISTS users_referral_code_unique
  ON users (referral_code)
  WHERE referral_code IS NOT NULL;

CREATE INDEX IF NOT EXISTS users_referred_by_idx
  ON users (referred_by_user_id);

CREATE TABLE IF NOT EXISTS referral_rewards (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_referral_user_id     UUID NOT NULL REFERENCES users(id),
  reward_type                 TEXT NOT NULL DEFAULT 'premium_consumer_month',
  granted_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  applied_to_subscription_id  UUID,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS referral_rewards_unique_pair
  ON referral_rewards (user_id, source_referral_user_id, reward_type);

CREATE INDEX IF NOT EXISTS referral_rewards_user_idx
  ON referral_rewards (user_id);

CREATE INDEX IF NOT EXISTS referral_rewards_source_idx
  ON referral_rewards (source_referral_user_id);
