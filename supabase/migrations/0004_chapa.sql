-- Phase 3 — Chapa payments (Hosted Checkout / redirect method).
-- Run after 0003_discounts_shipping.sql. Safe to re-run.
--
-- Flow: place_order(method='chapa') reserves stock → chapa_init calls Chapa's
-- initialize API (server-side, via the http extension) and returns checkout_url
-- → customer pays on Chapa's hosted page → returns to the site → chapa_confirm
-- calls Chapa's verify API and marks the order paid/confirmed.
-- The secret key lives in the `private` schema: PostgREST never exposes it, and
-- only SECURITY DEFINER functions can read it.

-- ---------------------------------------------------------------------------
-- Extensions & private secrets store
-- ---------------------------------------------------------------------------
create extension if not exists http with schema extensions;

create schema if not exists private;

create table if not exists private.secrets (
  k text primary key,
  v text not null
);
-- No grants: anon/authenticated cannot touch this schema at all.

-- Admin sets/replaces the Chapa secret key (never readable back through the API).
create or replace function public.set_chapa_secret(p_key text)
returns void
  language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then
    raise exception 'Admins only.';
  end if;
  if coalesce(trim(p_key), '') = '' then
    delete from private.secrets where k = 'chapa_secret_key';
  else
    insert into private.secrets (k, v) values ('chapa_secret_key', trim(p_key))
    on conflict (k) do update set v = excluded.v;
  end if;
end $$;
grant execute on function public.set_chapa_secret(text) to authenticated;

-- Masked status so the admin UI can show whether a key is configured.
create or replace function public.chapa_secret_status()
returns jsonb
  language plpgsql stable security definer set search_path = public as $$
declare v_key text;
begin
  if not public.is_admin() then
    raise exception 'Admins only.';
  end if;
  select v into v_key from private.secrets where k = 'chapa_secret_key';
  if v_key is null then
    return jsonb_build_object('set', false);
  end if;
  return jsonb_build_object('set', true,
    'hint', '····' || right(v_key, 4),
    'test_mode', v_key like 'CHASECK_TEST%');
end $$;
grant execute on function public.chapa_secret_status() to authenticated;

-- ---------------------------------------------------------------------------
-- Settings: admin toggle — checkout shows Chapa as Active vs "Coming soon"
-- ---------------------------------------------------------------------------
alter table public.settings
  add column if not exists chapa_enabled boolean not null default false;

-- ---------------------------------------------------------------------------
-- place_order v3 — payment method aware. Bank-slip orders require a slip;
-- Chapa orders require an email (Chapa's initialize API needs one) and start
-- unpaid until chapa_confirm verifies the payment.
-- ---------------------------------------------------------------------------
drop function if exists public.place_order(text, text, text, text, text, jsonb, text);

create or replace function public.place_order(
  p_name text,
  p_address text,
  p_phone text,
  p_email text,
  p_slip_path text,
  p_items jsonb,
  p_discount_code text default null,
  p_payment_method text default 'bank_slip'
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

grant execute on function public.place_order(text, text, text, text, text, jsonb, text, text) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- chapa_init — initialize a Hosted Checkout transaction for an order and
-- return the checkout_url. Guarded by the order's secret token.
-- ---------------------------------------------------------------------------
create or replace function public.chapa_init(p_id uuid, p_token uuid, p_return_url text)
returns jsonb
  language plpgsql security definer set search_path = public, extensions as $$
declare
  o        public.orders%rowtype;
  v_secret text;
  v_curr   text;
  v_resp   extensions.http_response;
  v_body   jsonb;
begin
  select * into o from public.orders where id = p_id and tracking_token = p_token;
  if not found then
    raise exception 'Order not found.';
  end if;
  if o.payment_method <> 'chapa' then
    raise exception 'This order does not use Chapa.';
  end if;
  if o.payment_status = 'paid' then
    return jsonb_build_object('already_paid', true);
  end if;

  select v into v_secret from private.secrets where k = 'chapa_secret_key';
  if v_secret is null then
    raise exception 'Chapa is not configured.';
  end if;
  select coalesce(currency, 'ETB') into v_curr from public.settings where id = 1;

  v_resp := extensions.http((
    'POST',
    'https://api.chapa.co/v1/transaction/initialize',
    ARRAY[extensions.http_header('Authorization', 'Bearer ' || v_secret)],
    'application/json',
    jsonb_build_object(
      'amount', to_char(o.total, 'FM999999990.00'),
      'currency', v_curr,
      'email', o.email,
      'first_name', coalesce(split_part(o.ship_address, ',', 1), 'Customer'),
      'tx_ref', o.human_id,
      'return_url', p_return_url,
      'customization', jsonb_build_object(
        'title', 'Melelo Brands',
        'description', 'Order ' || o.human_id)
    )::text
  )::extensions.http_request);

  v_body := v_resp.content::jsonb;
  if v_resp.status <> 200 or v_body->>'status' <> 'success' then
    raise exception 'Chapa initialize failed: %', coalesce(v_body->>'message', v_resp.content);
  end if;

  update public.orders set chapa_tx_ref = o.human_id where id = o.id;

  return jsonb_build_object('checkout_url', v_body->'data'->>'checkout_url');
end $$;

grant execute on function public.chapa_init(uuid, uuid, text) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- chapa_confirm — verify the transaction with Chapa and, on success, mark the
-- order paid + confirmed. Idempotent; validates the paid amount.
-- ---------------------------------------------------------------------------
create or replace function public.chapa_confirm(p_id uuid, p_token uuid)
returns jsonb
  language plpgsql security definer set search_path = public, extensions as $$
declare
  o        public.orders%rowtype;
  v_secret text;
  v_resp   extensions.http_response;
  v_body   jsonb;
  v_status text;
  v_amount numeric;
begin
  select * into o from public.orders where id = p_id and tracking_token = p_token;
  if not found then
    raise exception 'Order not found.';
  end if;
  if o.payment_status = 'paid' then
    return jsonb_build_object('paid', true, 'already', true);
  end if;
  if o.payment_method <> 'chapa' or o.chapa_tx_ref is null then
    raise exception 'This order has no Chapa transaction.';
  end if;

  select v into v_secret from private.secrets where k = 'chapa_secret_key';
  if v_secret is null then
    raise exception 'Chapa is not configured.';
  end if;

  v_resp := extensions.http((
    'GET',
    'https://api.chapa.co/v1/transaction/verify/' || o.chapa_tx_ref,
    ARRAY[extensions.http_header('Authorization', 'Bearer ' || v_secret)],
    null, null
  )::extensions.http_request);

  v_body   := v_resp.content::jsonb;
  v_status := coalesce(v_body->'data'->>'status', v_body->>'status');
  v_amount := coalesce((v_body->'data'->>'amount')::numeric, 0);

  if v_resp.status = 200 and v_body->>'status' = 'success' and v_status = 'success' then
    if v_amount + 0.01 < o.total then
      raise exception 'Paid amount (%) is less than the order total (%).', v_amount, o.total;
    end if;
    update public.orders
      set payment_status = 'paid',
          fulfillment_status = 'confirmed',
          approved_at = now()
      where id = o.id;
    insert into public.payments (order_id, provider, provider_ref, amount, status, raw_payload)
    values (o.id, 'chapa', o.chapa_tx_ref, v_amount, 'paid', v_body);
    insert into public.order_events (order_id, status, note)
    values (o.id, 'confirmed', 'Chapa payment verified — order confirmed');
    return jsonb_build_object('paid', true);
  end if;

  return jsonb_build_object('paid', false, 'status', v_status);
end $$;

grant execute on function public.chapa_confirm(uuid, uuid) to anon, authenticated;
