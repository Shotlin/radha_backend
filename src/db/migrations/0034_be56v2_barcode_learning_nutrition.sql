-- BE-56 v2: Nutrition capture for Community Barcode Learning submissions
-- Extends `barcode_learning_submissions` so a consumer's live-scanner
-- read of the nutrition panel travels with the submission instead of
-- being lost. Column shape mirrors `product_nutrition` so the real
-- `ProductsCatalogPort` adapter can upsert straight across on approval
-- without any unit/precision translation.
--
-- All columns nullable — submissions may still carry text + images
-- only, same as before this migration.

ALTER TABLE barcode_learning_submissions
  ADD COLUMN IF NOT EXISTS serving_size    DECIMAL(10,2),
  ADD COLUMN IF NOT EXISTS serving_unit    VARCHAR(10),
  ADD COLUMN IF NOT EXISTS calories        DECIMAL(8,2),
  ADD COLUMN IF NOT EXISTS protein         DECIMAL(8,2),
  ADD COLUMN IF NOT EXISTS carbohydrates   DECIMAL(8,2),
  ADD COLUMN IF NOT EXISTS sugars          DECIMAL(8,2),
  ADD COLUMN IF NOT EXISTS fat             DECIMAL(8,2),
  ADD COLUMN IF NOT EXISTS saturated_fat   DECIMAL(8,2),
  ADD COLUMN IF NOT EXISTS trans_fat       DECIMAL(8,2),
  ADD COLUMN IF NOT EXISTS fiber           DECIMAL(8,2),
  ADD COLUMN IF NOT EXISTS sodium          DECIMAL(8,2);
