-- ===========================================================================
-- 0018 — Customer accounts (email-code sign-in)
--
-- Buyers are nudged after purchase to create an account with a 6-digit email
-- code (passwordless — Supabase Auth OTP). Orders attach to the account two
-- ways: the device's (id, tracking_token) stubs are claimed, and — because
-- the code PROVED ownership of the email — every past order placed with that
-- email is claimed too. Signed-in checkouts attach automatically. Order
-- reading uses the "customer read" RLS policies that have existed since 0001.
--
-- Run this whole file in the Supabase SQL editor. Requires 0001–0017.
--
-- ONE-TIME DASHBOARD SETUP (required for sign-in emails):
--   1. Auth → Email Templates → "Magic Link": include the 6-digit code in the
--      body, e.g.:  <p>Your Melelo sign-in code: <strong>{{ .Token }}</strong></p>
--   2. Auth → SMTP Settings: enable custom SMTP via Resend
--      (host smtp.resend.com, port 465, user "resend", password = your Resend
--      API key, sender orders@melelo.shop). Supabase's built-in mailer allows
--      only a few emails per hour — not usable in production.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- place_order v5 — signed-in buyers own their orders from the start, and
-- their empty profile fields are filled from checkout.
-- ---------------------------------------------------------------------------
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
    (human_id, customer_id, email, phone, ship_address, subtotal, shipping, total, payment_method, slip_url)
  values
    (v_human, auth.uid(), nullif(trim(p_email), ''), nullif(trim(p_phone), ''),
     trim(p_name) || ', ' || trim(p_address), 0, 0, 0, v_method,
     nullif(trim(p_slip_path), ''))
  returning id, tracking_token into v_order_id, v_token;

  -- Signed-in buyers: fill empty profile fields from checkout (never overwrite).
  if auth.uid() is not null then
    update public.profiles
      set full_name = coalesce(nullif(full_name, ''), trim(p_name)),
          phone     = coalesce(nullif(phone, ''), nullif(trim(p_phone), ''))
      where id = auth.uid();
  end if;

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
-- claim_my_orders — attach orders to the signed-in account:
--   1. device stubs (id + tracking_token pairs, verified),
--   2. every unclaimed order placed with the account's (OTP-verified) email.
-- Fills empty profile fields from the newest claimed order.
-- ---------------------------------------------------------------------------
create or replace function public.claim_my_orders(p_stubs jsonb default '[]')
returns jsonb
  language plpgsql security definer set search_path = public as $$
declare
  v_uid   uuid := auth.uid();
  v_email text;
  v_stub  jsonb;
  v_n     int := 0;
  v_c     int;
  o       record;
begin
  if v_uid is null then raise exception 'Sign in first.'; end if;

  -- 1) Token claims from this device.
  for v_stub in select * from jsonb_array_elements(coalesce(p_stubs, '[]'::jsonb)) loop
    begin
      update public.orders set customer_id = v_uid
        where id = (v_stub->>'id')::uuid
          and tracking_token = (v_stub->>'token')::uuid
          and (customer_id is null or customer_id = v_uid);
      get diagnostics v_c = row_count;
      v_n := v_n + v_c;
    exception when others then
      null; -- malformed stub: skip it
    end;
  end loop;

  -- 2) Email claim — safe because the sign-in code proved email ownership.
  v_email := lower(coalesce(auth.jwt()->>'email', ''));
  if v_email <> '' then
    update public.orders set customer_id = v_uid
      where customer_id is null and lower(coalesce(email, '')) = v_email;
    get diagnostics v_c = row_count;
    v_n := v_n + v_c;
  end if;

  -- 3) Seed an empty profile from the newest owned order (name is the
  --    ship_address prefix; see place_order).
  select * into o from public.orders
    where customer_id = v_uid order by placed_at desc limit 1;
  if found then
    update public.profiles
      set full_name = coalesce(nullif(full_name, ''), nullif(trim(split_part(o.ship_address, ',', 1)), '')),
          phone     = coalesce(nullif(phone, ''), o.phone)
      where id = v_uid;
  end if;

  return jsonb_build_object('claimed', v_n);
end $$;
grant execute on function public.claim_my_orders(jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- get_my_orders — the account's orders as tracking stubs (same shape as
-- get_telegram_orders, so the client merges them identically).
-- ---------------------------------------------------------------------------
create or replace function public.get_my_orders()
returns table (id uuid, human_id text, token uuid, total numeric, placed_at timestamptz, address text)
  language sql stable security definer set search_path = public as $$
  select o.id, o.human_id, o.tracking_token, o.total, o.placed_at, o.ship_address
  from public.orders o
  where o.customer_id = auth.uid()
  order by o.placed_at desc;
$$;
grant execute on function public.get_my_orders() to authenticated;
