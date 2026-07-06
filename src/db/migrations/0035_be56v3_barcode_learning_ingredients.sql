-- BE-56 v3 — community submissions carry the ingredients list.
--
-- The label's INGREDIENTS section (palm oil, added sugar, water, …) is what
-- health judgement is made from; name + photo + nutrition alone lose it.
-- Approved submissions promote this into products.description — the exact
-- field Open Food Facts ingredients already live in — so no products-table
-- change is needed.

ALTER TABLE barcode_learning_submissions
  ADD COLUMN IF NOT EXISTS ingredients text;
