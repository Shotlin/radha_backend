-- BE-51: Public Product Profile Pages (SEO)
-- Per Req 53, every product in the global catalog gets a public
-- profile page at https://radha.app/p/{slug}. The slug is generated
-- as `{kebab(name)}-{ean.slice(-4)}` so collisions are rare; the
-- `UNIQUE` constraint below is the last line of defense and forces
-- `SlugService` to retry with a numeric suffix if it ever loses the
-- race.
--
-- `public_status` gates the page:
--   - 'active'    — page is renderable
--   - 'withdrawn' — brand pulled the product (page returns 410 Gone)
--   - 'unsafe'    — product is on a recall (page returns 410 Gone)
--
-- The partial index keeps slug lookups O(log N) over the (small)
-- subset of products that have actually been published to the public
-- catalog — most rows in `products` are tenant-private and therefore
-- carry NULL `public_slug`.

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS public_slug TEXT UNIQUE;

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS public_status TEXT NOT NULL DEFAULT 'active'
    CHECK (public_status IN ('active', 'withdrawn', 'unsafe'));

CREATE INDEX IF NOT EXISTS idx_products_public_slug
  ON products(public_slug)
  WHERE public_slug IS NOT NULL;
