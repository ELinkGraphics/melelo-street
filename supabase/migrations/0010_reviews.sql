-- ===========================================================================
-- 0010 — Post-delivery ratings & reviews
--
-- Delivered customers rate each product in their order (1–5 stars, text,
-- up to 3 photos). Identity = the (order id, tracking_token) pair, so only
-- real buyers can review, and only products in their delivered order.
-- Reviews are moderated: they appear on the storefront ONLY after the admin
-- approves them (Admin → Reviews). On approval the reviewer gets a single-use
-- percent-off discount code (Settings knob, 0 = off) via email + Telegram.
-- A one-time reminder nudges delivered-but-unreviewed orders after N days.
--
-- Run this whole file in the Supabase SQL editor. Requires 0001–0009.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Schema
-- ---------------------------------------------------------------------------
do $$ begin
  create type review_status as enum ('pending','approved','rejected');
exception when duplicate_object then null; end $$;

create table if not exists public.reviews (
  id            uuid primary key default gen_random_uuid(),
  order_id      uuid not null references public.orders(id) on delete cascade,
  product_id    uuid not null references public.products(id) on delete cascade,
  rating        int not null check (rating between 1 and 5),
  body          text,
  photos        jsonb not null default '[]',
  reviewer_name text,
  status        review_status not null default 'pending',
  reward_code   text,
  created_at    timestamptz not null default now(),
  approved_at   timestamptz,
  unique (order_id, product_id)
);
create index if not exists reviews_product_idx on public.reviews(product_id, status);

alter table public.reviews enable row level security;
-- The storefront reads approved reviews directly; writes only happen through
-- the submit_review RPC (security definer), so there is no insert policy.
drop policy if exists "reviews public read approved" on public.reviews;
create policy "reviews public read approved" on public.reviews
  for select using (status = 'approved');
drop policy if exists "reviews admin all" on public.reviews;
create policy "reviews admin all" on public.reviews
  for all using (public.is_admin()) with check (public.is_admin());

alter table public.settings add column if not exists review_reward_percent int not null default 10;
alter table public.settings add column if not exists review_reminder_days  int not null default 3;

alter table public.orders add column if not exists review_reminder_sent_at timestamptz;

-- Photo storage: public bucket (URLs are unguessable UUID paths and only
-- surface in the UI once a review is approved). Insert is open like slips.
insert into storage.buckets (id, name, public) values
  ('review-photos','review-photos', true)
on conflict (id) do nothing;

drop policy if exists "review photos public read" on storage.objects;
create policy "review photos public read" on storage.objects
  for select using (bucket_id = 'review-photos');
drop policy if exists "review photos insert" on storage.objects;
create policy "review photos insert" on storage.objects
  for insert with check (bucket_id = 'review-photos');

-- ---------------------------------------------------------------------------
-- Live rating aggregates — products.rating / review_count always reflect the
-- approved reviews, no matter how a review changes (approve/reject/delete).
-- ---------------------------------------------------------------------------
create or replace function public.refresh_product_rating()
returns trigger
  language plpgsql security definer set search_path = public as $$
declare
  v_pid uuid := coalesce(new.product_id, old.product_id);
begin
  update public.products p
    set rating       = sub.avg_rating,
        review_count = sub.cnt
    from (
      select round(avg(r.rating)::numeric, 1) as avg_rating, count(*)::int as cnt
      from public.reviews r
      where r.product_id = v_pid and r.status = 'approved'
    ) sub
    where p.id = v_pid;
  return coalesce(new, old);
end $$;

drop trigger if exists reviews_refresh_rating on public.reviews;
create trigger reviews_refresh_rating
  after insert or update or delete on public.reviews
  for each row execute function public.refresh_product_rating();

-- ---------------------------------------------------------------------------
-- submit_review — buyer-facing, token-authenticated. Upserts one review per
-- (order, product); editable until the admin approves it.
-- ---------------------------------------------------------------------------
create or replace function public.submit_review(
  p_id         uuid,
  p_token      uuid,
  p_product_id uuid,
  p_rating     int,
  p_body       text default null,
  p_photos     jsonb default '[]',
  p_name       text default null
) returns jsonb
  language plpgsql security definer set search_path = public as $$
declare
  o          public.orders%rowtype;
  s          record;
  v_tg_token text;
  v_pname    text;
  v_name     text;
  v_photo    text;
  v_existing public.reviews%rowtype;
begin
  select * into o from public.orders where id = p_id and tracking_token = p_token;
  if not found then raise exception 'Order not found.'; end if;
  if o.fulfillment_status <> 'delivered' then
    raise exception 'Reviews open once your order is delivered.';
  end if;

  select p.name into v_pname
    from public.order_items i join public.products p on p.id = i.product_id
    where i.order_id = o.id and i.product_id = p_product_id
    limit 1;
  if v_pname is null then raise exception 'This product is not part of the order.'; end if;

  if p_rating is null or p_rating < 1 or p_rating > 5 then
    raise exception 'Rating must be between 1 and 5.';
  end if;
  if length(coalesce(p_body, '')) > 2000 then
    raise exception 'Review text is too long (max 2000 characters).';
  end if;
  if jsonb_typeof(coalesce(p_photos, '[]'::jsonb)) <> 'array'
     or jsonb_array_length(coalesce(p_photos, '[]'::jsonb)) > 3 then
    raise exception 'Up to 3 photos are allowed.';
  end if;
  for v_photo in select jsonb_array_elements_text(coalesce(p_photos, '[]'::jsonb)) loop
    if position('/storage/v1/object/public/review-photos/' in v_photo) = 0 then
      raise exception 'Invalid photo attachment.';
    end if;
  end loop;

  select * into v_existing from public.reviews
    where order_id = o.id and product_id = p_product_id;
  if found and v_existing.status = 'approved' then
    raise exception 'This review is already published.';
  end if;

  -- Display name: explicit → checkout name (ship_address prefix) → Telegram.
  v_name := left(coalesce(
    nullif(trim(p_name), ''),
    nullif(trim(split_part(o.ship_address, ',', 1)), ''),
    o.telegram_username,
    'Verified buyer'), 80);

  insert into public.reviews (order_id, product_id, rating, body, photos, reviewer_name)
  values (o.id, p_product_id, p_rating, nullif(trim(p_body), ''),
          coalesce(p_photos, '[]'::jsonb), v_name)
  on conflict (order_id, product_id) do update
    set rating = excluded.rating,
        body = excluded.body,
        photos = excluded.photos,
        reviewer_name = excluded.reviewer_name,
        status = 'pending',
        approved_at = null,
        created_at = now();

  -- Heads-up to the owner (async, never blocks the submission).
  begin
    select telegram_enabled, telegram_admin_chat_id, site_url into s
      from public.settings where id = 1;
    select v into v_tg_token from private.secrets where k = 'telegram_bot_token';
    if coalesce(s.telegram_enabled, false) and v_tg_token is not null
       and coalesce(trim(s.telegram_admin_chat_id), '') <> '' then
      perform net.http_post(
        url := 'https://api.telegram.org/bot' || v_tg_token || '/sendMessage',
        body := jsonb_strip_nulls(jsonb_build_object(
          'chat_id', s.telegram_admin_chat_id,
          'text', format(e'⭐ New review pending approval\n%s★ on %s — by %s\nOrder %s',
            p_rating, v_pname, v_name, o.human_id),
          'reply_markup', case when coalesce(trim(s.site_url), '') <> ''
            then jsonb_build_object('inline_keyboard', jsonb_build_array(jsonb_build_array(
              jsonb_build_object('text', '📝 Review it', 'url', rtrim(s.site_url, '/') || '/admin/reviews'))))
            else null end)),
        headers := jsonb_build_object('Content-Type', 'application/json'));
    end if;
  exception when others then null; end;

  return jsonb_build_object('status', 'pending');
end $$;
grant execute on function public.submit_review(uuid, uuid, uuid, int, text, jsonb, text) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- approve_review — admin moderation. Approving mints the single-use reward
-- code (Settings → review_reward_percent, 0 = off) and tells the customer.
-- ---------------------------------------------------------------------------
create or replace function public.approve_review(p_id uuid, p_approve boolean)
returns jsonb
  language plpgsql security definer set search_path = public as $$
declare
  r          public.reviews%rowtype;
  o          public.orders%rowtype;
  s          record;
  v_key      text;
  v_tg_token text;
  v_from     text;
  v_code     text;
  v_pname    text;
  v_text     text;
begin
  if not public.is_admin() then raise exception 'Admins only.'; end if;

  select * into r from public.reviews where id = p_id;
  if not found then raise exception 'Review not found.'; end if;

  if not p_approve then
    update public.reviews set status = 'rejected', approved_at = null where id = p_id;
    return jsonb_build_object('status', 'rejected');
  end if;

  select review_reward_percent, store_name, site_url,
         email_enabled, email_from, telegram_enabled
    into s from public.settings where id = 1;

  v_code := r.reward_code;
  if v_code is null and coalesce(s.review_reward_percent, 0) > 0 then
    loop
      -- md5(random) keeps this free of pgcrypto (which lives outside our search_path).
      v_code := 'THANKS-' || upper(substr(md5(random()::text || clock_timestamp()::text), 1, 6));
      begin
        insert into public.discounts (code, type, value, min_subtotal, usage_limit, active)
        values (v_code, 'percent', s.review_reward_percent, 0, 1, true);
        exit;
      exception when unique_violation then null; -- rare collision: try another
      end;
    end loop;
  end if;

  update public.reviews
    set status = 'approved', approved_at = now(), reward_code = v_code
    where id = p_id;

  -- Thank the customer with the code (best-effort, never blocks approval).
  begin
    select * into o from public.orders where id = r.order_id;
    select name into v_pname from public.products where id = r.product_id;
    select v into v_key from private.secrets where k = 'resend_api_key';
    select v into v_tg_token from private.secrets where k = 'telegram_bot_token';
    v_from := coalesce(nullif(trim(s.email_from), ''), 'Melelo Brands <onboarding@resend.dev>');

    v_text := 'Your review of ' || coalesce(v_pname, 'your item') || ' is now live. Thank you!'
      || case when v_code is not null
           then ' Here''s ' || s.review_reward_percent || '% off your next order: ' || v_code
           else '' end;

    if coalesce(s.telegram_enabled, false) and v_tg_token is not null
       and o.telegram_chat_id is not null then
      perform net.http_post(
        url := 'https://api.telegram.org/bot' || v_tg_token || '/sendMessage',
        body := jsonb_build_object('chat_id', o.telegram_chat_id, 'text', '🌟 ' || v_text),
        headers := jsonb_build_object('Content-Type', 'application/json'));
    end if;

    if coalesce(s.email_enabled, false) and v_key is not null and o.email is not null then
      perform net.http_post(
        url := 'https://api.resend.com/emails',
        body := jsonb_build_object(
          'from', v_from,
          'to', jsonb_build_array(o.email),
          'subject', 'Your review is live' || case when v_code is not null
            then ' — here''s ' || s.review_reward_percent || '% off' else '' end,
          'html', format(
            '<!doctype html><body style="margin:0;background:#09090b;padding:32px 16px;font-family:Arial,Helvetica,sans-serif;">'
            || '<table width="520" cellpadding="0" cellspacing="0" style="max-width:520px;width:100%%;background:#18181b;border:1px solid #27272a;border-radius:16px;padding:32px;margin:0 auto;">'
            || '<tr><td>'
            || '<p style="margin:0 0 4px;color:#f97316;font-size:11px;letter-spacing:2px;text-transform:uppercase;font-weight:bold;">%s</p>'
            || '<h1 style="margin:0 0 12px;color:#ffffff;font-size:24px;">Thanks for your review 🌟</h1>'
            || '<p style="margin:0;color:#a1a1aa;font-size:14px;line-height:1.6;">Your review of %s is now live on the store.</p>'
            || '%s'
            || '<p style="margin:26px 0 0;color:#52525b;font-size:12px;">Order <span style="color:#a1a1aa;font-family:monospace;">%s</span> · %s</p>'
            || '</td></tr></table></body>',
            coalesce(s.store_name, 'Melelo Brands'),
            coalesce(v_pname, 'your item'),
            case when v_code is not null then format(
              '<div style="margin-top:20px;padding:16px;background:#09090b;border:1px dashed #f97316;border-radius:12px;text-align:center;">'
              || '<p style="margin:0 0 6px;color:#a1a1aa;font-size:12px;">%s%% off your next order</p>'
              || '<p style="margin:0;color:#f97316;font-size:22px;font-weight:bold;font-family:monospace;letter-spacing:2px;">%s</p></div>',
              s.review_reward_percent, v_code) else '' end,
            o.human_id, coalesce(s.store_name, 'Melelo Brands'))),
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'Authorization', 'Bearer ' || v_key));
    end if;
  exception when others then null; end;

  return jsonb_build_object('status', 'approved', 'reward_code', v_code);
end $$;
grant execute on function public.approve_review(uuid, boolean) to authenticated;

-- ---------------------------------------------------------------------------
-- get_order_by_token v4 — items carry product_id; the order's own reviews and
-- the reward percent ride along so the tracking UI needs no extra fetches.
-- ---------------------------------------------------------------------------
create or replace function public.get_order_by_token(p_id uuid, p_token uuid)
returns jsonb
  language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'id', o.id,
    'human_id', o.human_id,
    'subtotal', o.subtotal,
    'discount', o.discount,
    'shipping', o.shipping,
    'total', o.total,
    'placed_at', o.placed_at,
    'approved_at', o.approved_at,
    'payment_status', o.payment_status,
    'fulfillment_status', o.fulfillment_status,
    'payment_method', o.payment_method,
    'address', o.ship_address,
    'payment_expires_at', (
      select case
        when o.payment_method = 'chapa'
         and o.payment_status = 'pending'
         and o.fulfillment_status = 'pending_approval'
         and coalesce(st.payment_expiry_hours, 0) > 0
        then o.placed_at + make_interval(hours => st.payment_expiry_hours)
        else null end
      from public.settings st where st.id = 1
    ),
    'reward_percent', (select coalesce(st.review_reward_percent, 0) from public.settings st where st.id = 1),
    'items', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'product_id', i.product_id, 'name', i.name, 'image', i.image, 'size', i.size,
        'color', i.color, 'unit_price', i.unit_price, 'qty', i.qty)), '[]'::jsonb)
      from public.order_items i where i.order_id = o.id
    ),
    'reviews', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'product_id', r.product_id, 'rating', r.rating, 'body', r.body,
        'photos', r.photos, 'status', r.status, 'reward_code', r.reward_code,
        'reviewer_name', r.reviewer_name)), '[]'::jsonb)
      from public.reviews r where r.order_id = o.id
    ),
    'events', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'status', e.status, 'note', e.note, 'at', e.created_at)
        order by e.created_at), '[]'::jsonb)
      from public.order_events e where e.order_id = o.id
    )
  )
  from public.orders o
  where o.id = p_id and o.tracking_token = p_token;
$$;
grant execute on function public.get_order_by_token(uuid, uuid) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- notify_order_event v3 — the delivered message now invites a review
-- (email button + Telegram keyboard button), mentioning the reward when on.
-- ---------------------------------------------------------------------------
create or replace function public.notify_order_event()
returns trigger
  language plpgsql security definer set search_path = public as $$
declare
  s          record;
  o          public.orders%rowtype;
  v_key      text;
  v_tg_token text;
  v_from     text;
  v_track    text := null;
  v_review   text := null;
  v_subject  text;
  v_heading  text;
  v_detail   text;
  v_items    text := '';
  v_cta      text := '';
  v_html     text;
  v_tg_text  text;
  v_tg_kb    jsonb := null;
begin
  if new.status not in ('pending_approval','confirmed','packed','shipped','out_for_delivery','delivered','cancelled') then
    return new;
  end if;

  select email_enabled, email_from, site_url, contact_email, store_name,
         telegram_enabled, telegram_admin_chat_id, review_reward_percent
    into s from public.settings where id = 1;
  if s is null then return new; end if;

  select v into v_key from private.secrets where k = 'resend_api_key';
  select v into v_tg_token from private.secrets where k = 'telegram_bot_token';

  select * into o from public.orders where id = new.order_id;
  if not found then return new; end if;

  v_from := coalesce(nullif(trim(s.email_from), ''), 'Melelo Brands <onboarding@resend.dev>');
  if coalesce(trim(s.site_url), '') <> '' then
    v_track := rtrim(s.site_url, '/') || '/?track=' || o.id || ':' || o.tracking_token;
    v_review := v_track || '&review=1';
  end if;

  -- Copy per status (shared by email + Telegram) ---------------------------
  if new.status = 'pending_approval' then
    v_subject := 'Order received — ' || o.human_id;
    v_heading := 'Thanks — we''ve got your order!';
    v_detail  := case when o.payment_method = 'chapa'
      then 'Once your Chapa payment is verified we''ll confirm your order right away.'
      else 'Your bank-transfer slip is being reviewed. We''ll notify you the moment payment is approved.' end;
  elsif new.status = 'confirmed' then
    v_subject := 'Payment confirmed — ' || o.human_id;
    v_heading := 'Payment confirmed 🎉';
    v_detail  := 'Your order is confirmed and heading to packing.';
  elsif new.status = 'packed' then
    v_subject := 'Your order is packed — ' || o.human_id;
    v_heading := 'Packed and ready';
    v_detail  := 'Your order has been packed and will ship shortly.';
  elsif new.status = 'shipped' then
    v_subject := 'Your order has shipped — ' || o.human_id;
    v_heading := 'On its way 🚚';
    v_detail  := 'Your order has left our hands and is on the road.';
  elsif new.status = 'out_for_delivery' then
    v_subject := 'Out for delivery — ' || o.human_id;
    v_heading := 'Arriving today';
    v_detail  := 'Your order is out for delivery. Keep your phone close!';
  elsif new.status = 'delivered' then
    v_subject := 'Delivered — ' || o.human_id;
    v_heading := 'Delivered. Enjoy!';
    v_detail  := 'Your order has been delivered. Thanks for shopping with us — wear it loud.'
      || ' Tell us what you think — rate your items'
      || case when coalesce(s.review_reward_percent, 0) > 0
           then ' and get ' || s.review_reward_percent || '% off your next order.'
           else '.' end;
  else -- cancelled
    v_subject := 'Order cancelled — ' || o.human_id;
    v_heading := 'Your order was cancelled';
    v_detail  := coalesce(new.note, 'If this is unexpected, contact us and we''ll sort it out.');
  end if;

  -- ============================ EMAIL ======================================
  if coalesce(s.email_enabled, false) and v_key is not null then
    if new.status = 'pending_approval' then
      select coalesce(string_agg(format(
          '<tr><td style="padding:10px 0;border-bottom:1px solid #27272a;color:#e4e4e7;">%s<br>'
          || '<span style="color:#a1a1aa;font-size:12px;">%s · %s · ×%s</span></td>'
          || '<td style="padding:10px 0;border-bottom:1px solid #27272a;text-align:right;color:#e4e4e7;white-space:nowrap;">$%s</td></tr>',
          i.name, i.color, i.size, i.qty, to_char(i.unit_price * i.qty, 'FM999990.00')), ''), '')
        into v_items
        from public.order_items i where i.order_id = o.id;

      v_items := '<table width="100%" cellpadding="0" cellspacing="0" style="margin:18px 0 6px;">'
        || v_items
        || format('<tr><td style="padding:10px 0;color:#a1a1aa;">Subtotal</td><td style="text-align:right;color:#e4e4e7;">$%s</td></tr>', to_char(o.subtotal, 'FM999990.00'))
        || case when o.discount > 0 then format('<tr><td style="padding:2px 0;color:#a1a1aa;">Discount</td><td style="text-align:right;color:#4ade80;">−$%s</td></tr>', to_char(o.discount, 'FM999990.00')) else '' end
        || format('<tr><td style="padding:2px 0;color:#a1a1aa;">Shipping</td><td style="text-align:right;color:#e4e4e7;">%s</td></tr>', case when o.shipping = 0 then 'Free' else '$' || to_char(o.shipping, 'FM999990.00') end)
        || format('<tr><td style="padding:8px 0;color:#ffffff;font-weight:bold;">Total</td><td style="text-align:right;color:#ffffff;font-weight:bold;font-size:18px;">$%s</td></tr>', to_char(o.total, 'FM999990.00'))
        || '</table>';
    end if;

    if v_track is not null then
      v_cta := format(
        '<a href="%s" style="display:inline-block;margin-top:18px;background:#f97316;color:#000000;text-decoration:none;font-weight:bold;padding:12px 28px;border-radius:999px;">Track your order</a>',
        v_track);
      if new.status = 'delivered' then
        v_cta := v_cta || format(
          '<a href="%s" style="display:inline-block;margin-top:18px;margin-left:10px;background:#27272a;color:#f97316;text-decoration:none;font-weight:bold;padding:12px 28px;border-radius:999px;border:1px solid #f97316;">⭐ Rate your items</a>',
          v_review);
      end if;
    end if;

    v_html := format(
      '<!doctype html><body style="margin:0;background:#09090b;padding:32px 16px;font-family:Arial,Helvetica,sans-serif;">'
      || '<table width="100%%" cellpadding="0" cellspacing="0"><tr><td align="center">'
      || '<table width="520" cellpadding="0" cellspacing="0" style="max-width:520px;width:100%%;background:#18181b;border:1px solid #27272a;border-radius:16px;padding:32px;">'
      || '<tr><td>'
      || '<p style="margin:0 0 4px;color:#f97316;font-size:11px;letter-spacing:2px;text-transform:uppercase;font-weight:bold;">%s</p>'
      || '<h1 style="margin:0 0 12px;color:#ffffff;font-size:24px;">%s</h1>'
      || '<p style="margin:0;color:#a1a1aa;font-size:14px;line-height:1.6;">%s</p>'
      || '%s%s'
      || '<p style="margin:26px 0 0;color:#52525b;font-size:12px;">Order <span style="color:#a1a1aa;font-family:monospace;">%s</span> · %s</p>'
      || '</td></tr></table></td></tr></table></body>',
      coalesce(s.store_name, 'Melelo Brands'), v_heading, v_detail, v_items, v_cta,
      o.human_id, coalesce(s.store_name, 'Melelo Brands'));

    if o.email is not null then
      perform net.http_post(
        url := 'https://api.resend.com/emails',
        body := jsonb_build_object(
          'from', v_from,
          'to', jsonb_build_array(o.email),
          'subject', v_subject,
          'html', v_html),
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'Authorization', 'Bearer ' || v_key)
      );
    end if;

    if new.status = 'pending_approval' and coalesce(trim(s.contact_email), '') <> '' then
      perform net.http_post(
        url := 'https://api.resend.com/emails',
        body := jsonb_build_object(
          'from', v_from,
          'to', jsonb_build_array(s.contact_email),
          'subject', format('New order %s — $%s', o.human_id, to_char(o.total, 'FM999990.00')),
          'html', format(
            '<!doctype html><body style="margin:0;background:#09090b;padding:32px 16px;font-family:Arial,Helvetica,sans-serif;">'
            || '<table width="520" cellpadding="0" cellspacing="0" style="max-width:520px;width:100%%;background:#18181b;border:1px solid #27272a;border-radius:16px;padding:32px;margin:0 auto;">'
            || '<tr><td>'
            || '<h1 style="margin:0 0 12px;color:#ffffff;font-size:20px;">New order %s</h1>'
            || '<p style="margin:0;color:#a1a1aa;font-size:14px;line-height:1.7;">%s<br>%s · %s payment<br><strong style="color:#ffffff;">Total $%s</strong></p>'
            || '%s'
            || '</td></tr></table></body>',
            o.human_id,
            coalesce(o.ship_address, '—'),
            coalesce(o.phone, 'no phone'),
            case when o.payment_method = 'chapa' then 'Chapa' else 'bank-slip' end,
            to_char(o.total, 'FM999990.00'),
            case when coalesce(trim(s.site_url), '') <> ''
              then format('<a href="%s/admin/orders" style="display:inline-block;margin-top:18px;background:#f97316;color:#000000;text-decoration:none;font-weight:bold;padding:12px 28px;border-radius:999px;">Open dashboard</a>', rtrim(s.site_url, '/'))
              else '' end)),
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'Authorization', 'Bearer ' || v_key)
      );
    end if;
  end if;

  -- =========================== TELEGRAM ====================================
  if coalesce(s.telegram_enabled, false) and v_tg_token is not null then
    v_tg_text := v_heading || e'\n' || v_detail || e'\n\nOrder ' || o.human_id;
    if v_track is not null then
      v_tg_kb := jsonb_build_object('inline_keyboard',
        case when new.status = 'delivered'
          then jsonb_build_array(
            jsonb_build_array(jsonb_build_object('text', '⭐ Rate your items', 'url', v_review)),
            jsonb_build_array(jsonb_build_object('text', '📦 Track order', 'url', v_track)))
          else jsonb_build_array(jsonb_build_array(
            jsonb_build_object('text', '📦 Track order', 'url', v_track)))
        end);
    end if;

    -- Customer DM (only when the order came through Telegram).
    if o.telegram_chat_id is not null then
      perform net.http_post(
        url := 'https://api.telegram.org/bot' || v_tg_token || '/sendMessage',
        body := jsonb_strip_nulls(jsonb_build_object(
          'chat_id', o.telegram_chat_id,
          'text', v_tg_text,
          'reply_markup', v_tg_kb)),
        headers := jsonb_build_object('Content-Type', 'application/json')
      );
    end if;

    -- Owner new-order alert.
    if new.status = 'pending_approval' and coalesce(trim(s.telegram_admin_chat_id), '') <> '' then
      perform net.http_post(
        url := 'https://api.telegram.org/bot' || v_tg_token || '/sendMessage',
        body := jsonb_build_object(
          'chat_id', s.telegram_admin_chat_id,
          'text', format(e'🛒 New order %s — $%s\n%s\n%s · %s payment',
            o.human_id, to_char(o.total, 'FM999990.00'),
            coalesce(o.ship_address, '—'), coalesce(o.phone, 'no phone'),
            case when o.payment_method = 'chapa' then 'Chapa' else 'bank-slip' end)),
        headers := jsonb_build_object('Content-Type', 'application/json')
      );
    end if;
  end if;

  return new;
exception when others then
  -- Notifications must never break checkout or admin actions.
  return new;
end $$;

-- ---------------------------------------------------------------------------
-- review_nudger — hourly: delivered orders with no review after N days get
-- one reminder (email + Telegram). Mirrors payment_sweeper (0009).
-- ---------------------------------------------------------------------------
create or replace function public.review_nudger()
returns void
  language plpgsql security definer set search_path = public as $$
declare
  s          record;
  o          record;
  v_key      text;
  v_tg_token text;
  v_from     text;
  v_review   text;
  v_text     text;
begin
  select review_reminder_days, review_reward_percent, site_url, store_name,
         email_enabled, email_from, telegram_enabled
    into s from public.settings where id = 1;
  if s is null or coalesce(s.review_reminder_days, 0) <= 0 then return; end if;

  select v into v_key from private.secrets where k = 'resend_api_key';
  select v into v_tg_token from private.secrets where k = 'telegram_bot_token';
  v_from := coalesce(nullif(trim(s.email_from), ''), 'Melelo Brands <onboarding@resend.dev>');

  for o in
    select ord.*, d.delivered_at
    from public.orders ord
    join lateral (
      select max(e.created_at) as delivered_at
      from public.order_events e
      where e.order_id = ord.id and e.status = 'delivered'
    ) d on true
    where ord.fulfillment_status = 'delivered'
      and ord.review_reminder_sent_at is null
      and d.delivered_at < now() - make_interval(days => s.review_reminder_days)
      and not exists (select 1 from public.reviews r where r.order_id = ord.id)
      and (ord.email is not null or ord.telegram_chat_id is not null)
    order by d.delivered_at
    limit 50
  loop
    begin
      v_review := case when coalesce(trim(s.site_url), '') <> ''
        then rtrim(s.site_url, '/') || '/?track=' || o.id || ':' || o.tracking_token || '&review=1'
        else null end;
      v_text := 'How''s your order ' || o.human_id || ' treating you? Rate your items'
        || case when coalesce(s.review_reward_percent, 0) > 0
             then ' and get ' || s.review_reward_percent || '% off your next order.'
             else ' — it takes a minute.' end;

      if coalesce(s.telegram_enabled, false) and v_tg_token is not null
         and o.telegram_chat_id is not null then
        perform net.http_post(
          url := 'https://api.telegram.org/bot' || v_tg_token || '/sendMessage',
          body := jsonb_strip_nulls(jsonb_build_object(
            'chat_id', o.telegram_chat_id,
            'text', '⭐ ' || v_text,
            'reply_markup', case when v_review is not null
              then jsonb_build_object('inline_keyboard', jsonb_build_array(jsonb_build_array(
                jsonb_build_object('text', '⭐ Rate your items', 'url', v_review))))
              else null end)),
          headers := jsonb_build_object('Content-Type', 'application/json'));
      end if;

      if coalesce(s.email_enabled, false) and v_key is not null and o.email is not null then
        perform net.http_post(
          url := 'https://api.resend.com/emails',
          body := jsonb_build_object(
            'from', v_from,
            'to', jsonb_build_array(o.email),
            'subject', 'How was your order? — ' || o.human_id,
            'html', format(
              '<!doctype html><body style="margin:0;background:#09090b;padding:32px 16px;font-family:Arial,Helvetica,sans-serif;">'
              || '<table width="520" cellpadding="0" cellspacing="0" style="max-width:520px;width:100%%;background:#18181b;border:1px solid #27272a;border-radius:16px;padding:32px;margin:0 auto;">'
              || '<tr><td>'
              || '<p style="margin:0 0 4px;color:#f97316;font-size:11px;letter-spacing:2px;text-transform:uppercase;font-weight:bold;">%s</p>'
              || '<h1 style="margin:0 0 12px;color:#ffffff;font-size:24px;">How''s the fit? ⭐</h1>'
              || '<p style="margin:0;color:#a1a1aa;font-size:14px;line-height:1.6;">%s</p>'
              || '%s'
              || '<p style="margin:26px 0 0;color:#52525b;font-size:12px;">Order <span style="color:#a1a1aa;font-family:monospace;">%s</span> · %s</p>'
              || '</td></tr></table></body>',
              coalesce(s.store_name, 'Melelo Brands'),
              v_text,
              case when v_review is not null then format(
                '<a href="%s" style="display:inline-block;margin-top:18px;background:#f97316;color:#000000;text-decoration:none;font-weight:bold;padding:12px 28px;border-radius:999px;">Rate your items</a>',
                v_review) else '' end,
              o.human_id, coalesce(s.store_name, 'Melelo Brands'))),
          headers := jsonb_build_object(
            'Content-Type', 'application/json',
            'Authorization', 'Bearer ' || v_key));
      end if;

      update public.orders set review_reminder_sent_at = now() where id = o.id;
    exception when others then
      null; -- one bad order must not stop the run
    end;
  end loop;
exception when others then
  return;
end $$;

-- Schedule hourly (idempotent). Minute 7 keeps it clear of the 5-min sweeper.
do $$ begin
  perform cron.unschedule('review-nudger');
exception when others then null; end $$;
select cron.schedule('review-nudger', '7 * * * *', $$select public.review_nudger()$$);
