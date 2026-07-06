-- BE-55: Shopping List Module (consumer)
-- Per Req 47, a per-user, text-input shopping list with optional
-- WhatsApp share. v1 is text-only; voice input is deferred to v2
-- per Req 36.
--
-- `shopping_lists` is the parent collection — every consumer can
-- own multiple named lists ("My Shopping List" by default).
--   - `archived_at` is set when the user archives a list; the
--     partial index `idx_shopping_lists_user_active` keeps the
--     "list active lists" query off archived rows.
--
-- `shopping_list_items` is the line-item table.
--   - `is_purchased` is a tick state — toggling it leaves the row
--     in place so re-using a recurring list across shopping trips
--     stays cheap.
--   - `position` is a stable display order (0-based) the client
--     uses to render and reorder items.
--   - `deleted_at` is a soft delete so undo is trivial; the
--     partial index `idx_shopping_list_items_list` ignores
--     tombstones for the hot read path.
--
-- Tenant scope is intentionally absent: shopping lists are a
-- consumer-only feature scoped per `users(id)`. Cascade on parent
-- deletes keeps cleanup automatic.

CREATE TABLE IF NOT EXISTS shopping_lists (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL DEFAULT 'My Shopping List',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  archived_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_shopping_lists_user_active
  ON shopping_lists(user_id)
  WHERE archived_at IS NULL;

CREATE TABLE IF NOT EXISTS shopping_list_items (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  list_id       UUID NOT NULL REFERENCES shopping_lists(id) ON DELETE CASCADE,
  item          TEXT NOT NULL,
  quantity      TEXT,
  notes         TEXT,
  is_purchased  BOOLEAN NOT NULL DEFAULT FALSE,
  position      INT NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_shopping_list_items_list
  ON shopping_list_items(list_id, position)
  WHERE deleted_at IS NULL;
