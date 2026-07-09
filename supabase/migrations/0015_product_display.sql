-- ===========================================================================
-- 0015 — Per-product model positioning in the collection view
--
-- products.display holds per-device transforms for the storefront's center
-- model image: { desktop: {scale,x,y}, mobile: {scale,x,y} } — edited in
-- Admin → Catalog → (product) → "Model position". Missing values mean the
-- untouched default (scale 1, no offset), so existing products are unchanged.
--
-- Independent of 0014 — these two can run in either order.
-- ===========================================================================

alter table public.products add column if not exists display jsonb;
