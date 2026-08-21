-- 0041_session_refresh_grace.sql
--
-- Records the immediately-previous refresh token hash alongside the
-- current one, so a short grace window can distinguish a harmless
-- concurrent-replay race (two app processes both holding the same
-- about-to-be-rotated token -- e.g. a reinstall/relaunch overlap) from
-- genuine token theft. See AuthService.refreshTokens().

ALTER TABLE user_sessions ADD COLUMN IF NOT EXISTS previous_refresh_token_hash varchar(255);
