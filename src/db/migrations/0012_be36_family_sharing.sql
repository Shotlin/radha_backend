-- BE-36: Family Sharing Members table
-- Links a primary Premium Consumer subscriber to up to 5 family members.

DO $$ BEGIN
  CREATE TYPE family_sharing_status AS ENUM ('invited', 'accepted', 'removed', 'expired');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS family_sharing_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  primary_user_id UUID NOT NULL REFERENCES users(id),
  member_user_id UUID REFERENCES users(id),
  invited_mobile VARCHAR(15) NOT NULL,
  status family_sharing_status NOT NULL DEFAULT 'invited',
  accepted_at TIMESTAMPTZ,
  removed_at TIMESTAMPTZ,
  invite_expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS family_sharing_primary_user_idx
  ON family_sharing_members(primary_user_id);

CREATE INDEX IF NOT EXISTS family_sharing_member_user_idx
  ON family_sharing_members(member_user_id);

CREATE INDEX IF NOT EXISTS family_sharing_status_idx
  ON family_sharing_members(status);

-- Prevent duplicate active invites for the same mobile under a primary user
CREATE UNIQUE INDEX IF NOT EXISTS family_sharing_unique_active_invite
  ON family_sharing_members(primary_user_id, invited_mobile, status)
  WHERE status NOT IN ('removed', 'expired');
