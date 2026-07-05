-- Telegram — Mini App shop, bot notifications, comments inbox, admin controls.
-- Run after 0007_emails.sql. Safe to re-run.
--
-- Inbound (chat messages, /start, /orders) uses getUpdates long-polling from a
-- pg_cron job every 10 seconds — no webhook/Edge Function needed. IMPORTANT:
-- never call setWebhook on this bot; it conflicts with getUpdates.
-- Outbound (order status DMs) extends the notify_order_event trigger via async
-- pg_net, so checkout and admin actions are never blocked by Telegram.

create extension if not exists pg_cron;

-- ---------------------------------------------------------------------------
-- Settings & schema
-- ---------------------------------------------------------------------------
alter table public.settings
  add column if not exists telegram_enabled boolean not null default false,
  add column if not exists telegram_bot_username text,
  add column if not exists telegram_admin_chat_id text;

alter table public.orders
  add column if not exists telegram_chat_id bigint,
  add column if not exists telegram_username text;
create index if not exists orders_telegram_idx on public.orders(telegram_chat_id);

-- Customer <-> store chat log (both directions). Admin-only via RLS.
create table if not exists public.telegram_messages (
  id         uuid primary key default gen_random_uuid(),
  chat_id    bigint not null,
  username   text,
  first_name text,
  text       text not null,
  direction  text not null check (direction in ('in','out')),
  read       boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists tg_messages_chat_idx on public.telegram_messages(chat_id, created_at);
alter table public.telegram_messages enable row level security;
drop policy if exists "tg messages admin all" on public.telegram_messages;
create policy "tg messages admin all" on public.telegram_messages
  for all using (public.is_admin()) with check (public.is_admin());

-- Poller state — private schema, no API exposure.
create table if not exists private.telegram_state (
  id             int primary key default 1 check (id = 1),
  last_update_id bigint not null default 0
);
insert into private.telegram_state (id) values (1) on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- Bot token management (write-only, same pattern as Chapa/Resend)
-- ---------------------------------------------------------------------------
create or replace function public.set_telegram_secret(p_key text)
returns void
  language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then
    raise exception 'Admins only.';
  end if;
  if coalesce(trim(p_key), '') = '' then
    delete from private.secrets where k = 'telegram_bot_token';
  else
    insert into private.secrets (k, v) values ('telegram_bot_token', trim(p_key))
    on conflict (k) do update set v = excluded.v;
  end if;
end $$;
grant execute on function public.set_telegram_secret(text) to authenticated;

create or replace function public.telegram_secret_status()
returns jsonb
  language plpgsql stable security definer set search_path = public as $$
declare v_key text;
begin
  if not public.is_admin() then
    raise exception 'Admins only.';
  end if;
  select v into v_key from private.secrets where k = 'telegram_bot_token';
  if v_key is null then
    return jsonb_build_object('set', false);
  end if;
  return jsonb_build_object('set', true, 'hint', '····' || right(v_key, 4));
end $$;
grant execute on function public.telegram_secret_status() to authenticated;

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
-- Percent-decoding (multibyte-safe: bytes are accumulated, then converted once).
create or replace function private.url_decode(p text)
returns text
  language plpgsql immutable as $$
declare
  b bytea := ''::bytea;
  i int := 1;
  c text;
begin
  if p is null then return null; end if;
  while i <= length(p) loop
    c := substr(p, i, 1);
    if c = '%' and i + 2 <= length(p) then
      b := b || decode(substr(p, i + 1, 2), 'hex');
      i := i + 3;
    elsif c = '+' then
      b := b || convert_to(' ', 'utf8');
      i := i + 1;
    else
      b := b || convert_to(c, 'utf8');
      i := i + 1;
    end if;
  end loop;
  return convert_from(b, 'utf8');
exception when others then
  return p;
end $$;

-- Synchronous Bot API call (poller + admin replies). Private schema: not
-- exposed through PostgREST, callable only from definer functions.
create or replace function private.tg_api(p_method text, p_payload jsonb)
returns jsonb
  language plpgsql security definer set search_path = public, extensions as $$
declare
  v_token text;
  r extensions.http_response;
begin
  select v into v_token from private.secrets where k = 'telegram_bot_token';
  if v_token is null then return null; end if;
  r := extensions.http((
    'POST',
    'https://api.telegram.org/bot' || v_token || '/' || p_method,
    ARRAY[]::extensions.http_header[],
    'application/json',
    p_payload::text
  )::extensions.http_request);
  return r.content::jsonb;
exception when others then
  return null;
end $$;

-- ---------------------------------------------------------------------------
-- Mini App auth — verify Telegram WebApp initData (HMAC per Bot API docs)
-- Returns the signed `user` object, or null when invalid/stale/unconfigured.
-- ---------------------------------------------------------------------------
create or replace function public.telegram_verify_init(p_init text)
returns jsonb
  language plpgsql stable security definer set search_path = public, extensions as $$
declare
  v_token  text;
  pair     text;
  k        text;
  v        text;
  v_hash   text;
  v_user   jsonb;
  v_auth   bigint;
  v_pairs  text[] := '{}';
  v_check  text;
  v_secret bytea;
begin
  if coalesce(trim(p_init), '') = '' then return null; end if;
  select s.v into v_token from private.secrets s where s.k = 'telegram_bot_token';
  if v_token is null then return null; end if;

  foreach pair in array string_to_array(p_init, '&') loop
    k := split_part(pair, '=', 1);
    v := private.url_decode(substr(pair, length(k) + 2));
    if k = 'hash' then
      v_hash := v;
    else
      v_pairs := array_append(v_pairs, k || '=' || v);
      if k = 'user' then v_user := v::jsonb; end if;
      if k = 'auth_date' then v_auth := v::bigint; end if;
    end if;
  end loop;

  if v_hash is null or v_user is null then return null; end if;
  -- Reject stale signatures (older than 24h).
  if v_auth is null or (extract(epoch from now())::bigint - v_auth) > 86400 then return null; end if;

  select string_agg(x, e'\n' order by x) into v_check from unnest(v_pairs) as x;
  v_secret := hmac(convert_to(v_token, 'utf8'), convert_to('WebAppData', 'utf8'), 'sha256');
  if encode(hmac(convert_to(v_check, 'utf8'), v_secret, 'sha256'), 'hex') <> lower(v_hash) then
    return null;
  end if;
  return v_user;
exception when others then
  return null;
end $$;
grant execute on function public.telegram_verify_init(text) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Telegram-linked order history for the Mini App ("My Orders" on any device)
-- ---------------------------------------------------------------------------
create or replace function public.get_telegram_orders(p_init text)
returns jsonb
  language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', o.id,
      'human_id', o.human_id,
      'token', o.tracking_token,
      'total', o.total,
      'status', o.fulfillment_status,
      'placed_at', o.placed_at,
      'address', o.ship_address)
    order by o.placed_at desc), '[]'::jsonb)
  from public.orders o
  where o.telegram_chat_id = ((public.telegram_verify_init(p_init))->>'id')::bigint;
$$;
grant execute on function public.get_telegram_orders(text) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Admin reply from the dashboard
-- ---------------------------------------------------------------------------
create or replace function public.telegram_send(p_chat_id bigint, p_text text)
returns jsonb
  language plpgsql security definer set search_path = public as $$
declare resp jsonb;
begin
  if not public.is_admin() then
    raise exception 'Admins only.';
  end if;
  if coalesce(trim(p_text), '') = '' then
    raise exception 'Message is empty.';
  end if;
  resp := private.tg_api('sendMessage', jsonb_build_object('chat_id', p_chat_id, 'text', p_text));
  if resp is null or not coalesce((resp->>'ok')::boolean, false) then
    raise exception 'Telegram send failed: %', coalesce(resp->>'description', 'no response');
  end if;
  insert into public.telegram_messages (chat_id, text, direction, read)
  values (p_chat_id, trim(p_text), 'out', true);
  return jsonb_build_object('ok', true);
end $$;
grant execute on function public.telegram_send(bigint, text) to authenticated;

-- ---------------------------------------------------------------------------
-- place_order v4 — optional Telegram Mini App identity
-- ---------------------------------------------------------------------------
drop function if exists public.place_order(text, text, text, text, text, jsonb, text, text);

create or replace function public.place_order(
  p_name text,
  p_address text,
  p_phone text,
  p_email text,
  p_slip_path text,
  p_items jsonb,
  p_discount_code text default null,
  p_payment_method text default 'bank_slip',
  p_tg_init text default null
) returns jsonb
  language plpgsql security definer set search_path = public as $$
declare
  v_item      jsonb;
  v_product   public.products%rowtype;
  v_variant   public.product_variants%rowtype;
  v_disc      public.discounts%rowtype;
  v_qty       int;
  v_size      text;
  v_image     text;
  v_subtotal  numeric := 0;
  v_discount  numeric := 0;
  v_flat      numeric := 0;
  v_threshold numeric;
  v_shipping  numeric := 0;
  v_order_id  uuid;
  v_human     text;
  v_token     uuid;
  v_updated   int;
  v_method    payment_method;
  v_tg        jsonb;
begin
  if p_payment_method not in ('bank_slip', 'chapa') then
    raise exception 'Unknown payment method.';
  end if;
  v_method := p_payment_method::payment_method;

  if p_items is null or jsonb_array_length(p_items) = 0 then
    raise exception 'Your cart is empty.';
  end if;
  if coalesce(trim(p_name), '') = '' or coalesce(trim(p_address), '') = '' then
    raise exception 'Name and address are required.';
  end if;
  if v_method = 'bank_slip' and coalesce(trim(p_slip_path), '') = '' then
    raise exception 'A payment slip is required.';
  end if;
  if v_method = 'chapa' then
    if coalesce(trim(p_email), '') = '' then
      raise exception 'An email address is required for Chapa payments.';
    end if;
    if not exists (select 1 from public.settings where id = 1 and chapa_enabled) then
      raise exception 'Chapa payments are not enabled.';
    end if;
  end if;

  v_human := 'MLB-' || to_char(now(), 'YYYYMMDD') || '-' || lpad(floor(random() * 1000000)::text, 6, '0');

  insert into public.orders
    (human_id, email, phone, ship_address, subtotal, shipping, total, payment_method, slip_url)
  values
    (v_human, nullif(trim(p_email), ''), nullif(trim(p_phone), ''),
     trim(p_name) || ', ' || trim(p_address), 0, 0, 0, v_method,
     nullif(trim(p_slip_path), ''))
  returning id, tracking_token into v_order_id, v_token;

  -- Telegram Mini App identity: verified server-side; links the order to the
  -- buyer's chat so status updates arrive as bot DMs.
  if p_tg_init is not null then
    v_tg := public.telegram_verify_init(p_tg_init);
    if v_tg is not null and (v_tg->>'id') is not null then
      update public.orders
        set telegram_chat_id = (v_tg->>'id')::bigint,
            telegram_username = v_tg->>'username'
        where id = v_order_id;
    end if;
  end if;

  for v_item in select * from jsonb_array_elements(p_items) loop
    select * into v_product from public.products
      where id = (v_item->>'product_id')::uuid and status = 'active';
    if not found then
      raise exception 'A product in your cart is no longer available.';
    end if;

    select * into v_variant from public.product_variants
      where product_id = v_product.id and color_name = v_item->>'color';
    if not found then
      raise exception 'Color "%" is no longer available for %.', v_item->>'color', v_product.name;
    end if;

    v_qty  := coalesce((v_item->>'qty')::int, 0);
    v_size := v_item->>'size';
    if v_qty < 1 or v_qty > 20 then
      raise exception 'Invalid quantity for %.', v_product.name;
    end if;

    update public.inventory
      set stock_qty = stock_qty - v_qty
      where variant_id = v_variant.id and size = v_size and stock_qty >= v_qty;
    get diagnostics v_updated = row_count;
    if v_updated = 0 then
      raise exception 'Out of stock: % — % / size %.', v_product.name, v_variant.color_name, v_size;
    end if;

    select url into v_image from public.product_images
      where product_id = v_product.id
        and (variant_id = v_variant.id or variant_id is null)
        and view = 'product'
      order by (variant_id is null), sort
      limit 1;

    insert into public.order_items
      (order_id, product_id, variant_id, name, image, size, color, unit_price, qty)
    values
      (v_order_id, v_product.id, v_variant.id, v_product.name, v_image,
       v_size, v_variant.color_name, v_product.base_price, v_qty);

    v_subtotal := v_subtotal + v_product.base_price * v_qty;
  end loop;

  if coalesce(trim(p_discount_code), '') <> '' then
    select * into v_disc from public.discounts
      where upper(code) = upper(trim(p_discount_code)) and active
        and (starts_at is null or starts_at <= now())
        and (ends_at is null or ends_at >= now());
    if not found then
      raise exception 'Invalid or expired discount code.';
    end if;
    if v_disc.usage_limit is not null and v_disc.used_count >= v_disc.usage_limit then
      raise exception 'This discount code has been fully redeemed.';
    end if;
    if v_subtotal < v_disc.min_subtotal then
      raise exception 'This code requires a minimum subtotal of $%.', v_disc.min_subtotal;
    end if;
    v_discount := case v_disc.type
      when 'percent' then round(v_subtotal * v_disc.value / 100, 2)
      else least(v_disc.value, v_subtotal)
    end;
    update public.discounts set used_count = used_count + 1 where id = v_disc.id;
  end if;

  select coalesce(shipping_flat, 0), free_ship_threshold
    into v_flat, v_threshold from public.settings where id = 1;
  v_shipping := case
    when v_threshold is not null and (v_subtotal - v_discount) >= v_threshold then 0
    else coalesce(v_flat, 0)
  end;

  update public.orders
    set subtotal = v_subtotal,
        discount = v_discount,
        shipping = v_shipping,
        total = v_subtotal - v_discount + v_shipping
    where id = v_order_id;

  insert into public.order_events (order_id, status, note)
  values (v_order_id, 'pending_approval',
    case when v_method = 'chapa'
      then 'Order placed — awaiting Chapa payment'
      else 'Order placed — awaiting payment approval' end);

  return jsonb_build_object(
    'id', v_order_id,
    'human_id', v_human,
    'token', v_token,
    'subtotal', v_subtotal,
    'discount', v_discount,
    'shipping', v_shipping,
    'total', v_subtotal - v_discount + v_shipping,
    'placed_at', now()
  );
end $$;

grant execute on function public.place_order(text, text, text, text, text, jsonb, text, text, text) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Poller — getUpdates every 10s via pg_cron
-- ---------------------------------------------------------------------------
create or replace function public.telegram_poll()
returns void
  language plpgsql security definer set search_path = public as $$
declare
  s          record;
  v_offset   bigint;
  resp       jsonb;
  upd        jsonb;
  v_chat     bigint;
  v_text     text;
  v_from     jsonb;
  v_button   jsonb;
  v_list     text;
  o          record;
begin
  select telegram_enabled, site_url into s from public.settings where id = 1;
  if s is null or not coalesce(s.telegram_enabled, false) then return; end if;
  if not exists (select 1 from private.secrets where k = 'telegram_bot_token') then return; end if;

  select last_update_id into v_offset from private.telegram_state where id = 1;
  resp := private.tg_api('getUpdates', jsonb_build_object(
    'offset', coalesce(v_offset, 0) + 1,
    'timeout', 0,
    'allowed_updates', jsonb_build_array('message')));
  if resp is null or not coalesce((resp->>'ok')::boolean, false) then return; end if;

  for upd in select * from jsonb_array_elements(resp->'result') loop
    update private.telegram_state
      set last_update_id = greatest(last_update_id, (upd->>'update_id')::bigint)
      where id = 1;

    v_chat := (upd->'message'->'chat'->>'id')::bigint;
    v_text := upd->'message'->>'text';
    v_from := upd->'message'->'from';
    if v_chat is null or v_text is null then continue; end if;

    if v_text like '/start%' then
      -- web_app buttons require https; fall back to a plain url button otherwise.
      if coalesce(trim(s.site_url), '') <> '' then
        v_button := jsonb_build_object('inline_keyboard', jsonb_build_array(jsonb_build_array(
          case when s.site_url like 'https://%'
            then jsonb_build_object('text', '🛍 Open shop', 'web_app', jsonb_build_object('url', rtrim(s.site_url, '/')))
            else jsonb_build_object('text', '🛍 Open shop', 'url', rtrim(s.site_url, '/'))
          end)));
      else
        v_button := null;
      end if;
      perform private.tg_api('sendMessage', jsonb_strip_nulls(jsonb_build_object(
        'chat_id', v_chat,
        'text', e'Welcome to Melelo Brands! 👋\nBrowse the collection and order right here — your order updates will arrive in this chat.\n\nCommands:\n/orders — your recent orders\n/id — your chat id',
        'reply_markup', v_button)));

    elsif v_text = '/id' then
      perform private.tg_api('sendMessage', jsonb_build_object(
        'chat_id', v_chat, 'text', 'Your chat id: ' || v_chat));

    elsif v_text = '/orders' then
      v_list := '';
      for o in
        select human_id, fulfillment_status, total, id, tracking_token
        from public.orders where telegram_chat_id = v_chat
        order by placed_at desc limit 5
      loop
        v_list := v_list || format(e'• %s — %s — $%s\n', o.human_id,
          replace(o.fulfillment_status::text, '_', ' '), to_char(o.total, 'FM999990.00'));
        if coalesce(trim(s.site_url), '') <> '' then
          v_list := v_list || rtrim(s.site_url, '/') || '/?track=' || o.id || ':' || o.tracking_token || e'\n';
        end if;
        v_list := v_list || e'\n';
      end loop;
      perform private.tg_api('sendMessage', jsonb_build_object(
        'chat_id', v_chat,
        'text', case when v_list = ''
          then 'No orders are linked to this chat yet. Order through the shop button and they''ll show up here.'
          else e'Your recent orders:\n\n' || v_list end));

    else
      insert into public.telegram_messages (chat_id, username, first_name, text, direction)
      values (v_chat, v_from->>'username', coalesce(v_from->>'first_name', ''), v_text, 'in');
      perform private.tg_api('sendMessage', jsonb_build_object(
        'chat_id', v_chat,
        'text', 'Thanks! Your message reached the Melelo team — we''ll reply right here.'));
    end if;
  end loop;
exception when others then
  return; -- polling must never raise into cron logs as failures cascade
end $$;

-- Schedule (idempotent).
do $$ begin
  perform cron.unschedule('telegram-poll');
exception when others then null; end $$;
select cron.schedule('telegram-poll', '10 seconds', $$select public.telegram_poll()$$);

-- ---------------------------------------------------------------------------
-- notify_order_event v2 — email (unchanged) + Telegram DMs
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
         telegram_enabled, telegram_admin_chat_id
    into s from public.settings where id = 1;
  if s is null then return new; end if;

  select v into v_key from private.secrets where k = 'resend_api_key';
  select v into v_tg_token from private.secrets where k = 'telegram_bot_token';

  select * into o from public.orders where id = new.order_id;
  if not found then return new; end if;

  v_from := coalesce(nullif(trim(s.email_from), ''), 'Melelo Brands <onboarding@resend.dev>');
  if coalesce(trim(s.site_url), '') <> '' then
    v_track := rtrim(s.site_url, '/') || '/?track=' || o.id || ':' || o.tracking_token;
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
    v_detail  := 'Your order has been delivered. Thanks for shopping with us — wear it loud.';
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
      v_tg_kb := jsonb_build_object('inline_keyboard', jsonb_build_array(jsonb_build_array(
        jsonb_build_object('text', '📦 Track order', 'url', v_track))));
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
