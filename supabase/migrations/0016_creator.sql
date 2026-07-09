-- ===========================================================================
-- 0016 — Brand founder / creator identity
--
-- settings.creator holds the person behind Melelo Brands — TikTok creator
-- Hermela Medfu ("Bazi"), the founder & owner — separate from the brand's own
-- social accounts (settings.socials). The storefront turns this into
-- schema.org Person + Organization.founder structured data so Google and AI
-- engines associate the brand with her, and shows a founder credit with links
-- in the About panel. Editable in Admin → Settings → Store.
--
-- Run this whole file in the Supabase SQL editor. Requires 0001–0015.
-- ===========================================================================

alter table public.settings add column if not exists creator jsonb;

update public.settings set creator = jsonb_build_object(
  'name', 'Hermela Medfu',
  'alias', 'Bazi',
  'role', 'Founder & Owner',
  'tiktok', '',
  'instagram', '',
  'youtube', ''
) where id = 1 and creator is null;
