-- Phase 5 — storefront hero management.
-- Run after 0004_chapa.sql. Safe to re-run.
--
-- settings.hero (jsonb, null = storefront built-in defaults):
--   {
--     "image":   "https://…/product-images/hero/….png",  -- hero model image URL
--     "title1":  "Melelo",                -- headline line 1 (light weight)
--     "title2":  "Brands",                -- headline line 2 (extrabold)
--     "tagline": "Chaotic authenticity.", -- sub-headline
--     "desktop": { "scale": 1.0, "x": 0, "y": 0 },  -- md+ screens
--     "mobile":  { "scale": 1.0, "x": 0, "y": 0 }   -- < md screens
--   }
--   scale = size multiplier on top of the responsive base; x/y = px offsets
--   (+x right / −x left, +y down / −y up). Legacy configs with top-level
--   scale/x/y still work and apply to both devices.
-- Public read is already granted on settings; admin write via existing policy.
-- Hero images upload to the public product-images bucket under hero/ (the
-- existing admin-write policy covers it).

alter table public.settings
  add column if not exists hero jsonb;
