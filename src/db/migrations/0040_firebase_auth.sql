-- 0040_firebase_auth.sql
--
-- Phase 13 (firebase_auth_migration): Firebase Auth (Google Sign-In)
-- becomes the primary mobile login. `mobile` is no longer guaranteed —
-- Google-only signups never collect one. `firebase_uid` links a users
-- row to its Firebase identity; `auth_provider` records provenance
-- ('otp' | 'google' | 'google_linked') for audit/debugging during the
-- OTP -> Google migration window.
--
-- A plain UNIQUE INDEX on a nullable column is correct here: Postgres
-- treats each NULL as distinct, so the many existing/demo rows with
-- firebase_uid IS NULL remain valid; only a real duplicate Firebase uid
-- would collide, which is exactly the desired constraint.

ALTER TABLE users ALTER COLUMN mobile DROP NOT NULL;

ALTER TABLE users ADD COLUMN IF NOT EXISTS firebase_uid varchar(128);

ALTER TABLE users ADD COLUMN IF NOT EXISTS auth_provider varchar(20) NOT NULL DEFAULT 'otp';

CREATE UNIQUE INDEX IF NOT EXISTS users_firebase_uid_unique ON users (firebase_uid);
