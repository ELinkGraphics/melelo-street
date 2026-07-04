-- Phase 4 — working discount codes + free-shipping threshold.
-- Run after 0002_orders.sql. Safe to re-run.

-- ---------------------------------------------------------------------------
-- validate_discount — checkout preview. Returns {valid, amount, message} so the
-- storefront can show the discount before placing the order. Discounts table
-- itself stays admin-only; this definer function is the only public window.
-- ---------------------------------------------------------------------------
create or replace function public.validate_discount(p_code text, p_subtotal numeric)
returns jsonb
  language plpgsql stable security definer set search_path = public as $$
declare
  d public.discounts%rowtype;
  v_amount numeric;
begin
  select * into d from public.discounts
    where upper(code) = upper(trim(p_code)) and active
      and (starts_at is null or starts_at <= now())
      and (ends_at is null or ends_at >= now());
  if not found then
    return jsonb_build_object('valid', false, 'message', 'Invalid or expired code.');
  end if;
  if d.usage_limit is not null and d.used_count >= d.usage_limit then
    return jsonb_build_object('valid', false, 'message', 'This code has been fully redeemed.');
  end if;
  if p_subtotal < d.min_subtotal then
    return jsonb_build_object('valid', false, 'message',
      'Requires a minimum subtotal of $' || to_char(d.min_subtotal, 'FM999990.00') || '.');
  end if;
  v_amount := case d.type
    when 'percent' then round(p_subtotal * d.value / 100, 2)
    else least(d.value, p_subtotal)
  end;
  return jsonb_build_object('valid', true, 'amount', v_amount, 'code', d.code,
    'label', case d.type when 'percent' then d.value || '% off' else '$' || d.value || ' off' end);
end $$;

grant execute on function public.validate_discount(text, numeric) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- place_order v2 — adds optional p_discount_code and a free-shipping threshold.
-- Drop v1 first so PostgREST doesn't see an ambiguous overload; old callers
-- (without the new arg) still resolve here via the parameter default.
-- ---------------------------------------------------------------------------
drop function if exists public.place_order(text, text, text, text, text, jsonb);

create or replace function public.place_order(
  p_name text,
  p_address text,
  p_phone text,
  p_email text,
  p_slip_path text,
  p_items jsonb,
  p_discount_code text default null
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
begin
  if p_items is null or jsonb_array_length(p_items) = 0 then
    raise exception 'Your cart is empty.';
  end if;
  if coalesce(trim(p_name), '') = '' or coalesce(trim(p_address), '') = '' then
    raise exception 'Name and address are required.';
  end if;
  if coalesce(trim(p_slip_path), '') = '' then
    raise exception 'A payment slip is required.';
  end if;

  v_human := 'MLB-' || to_char(now(), 'YYYYMMDD') || '-' || lpad(floor(random() * 1000000)::text, 6, '0');

  insert into public.orders
    (human_id, email, phone, ship_address, subtotal, shipping, total, payment_method, slip_url)
  values
    (v_human, nullif(trim(p_email), ''), nullif(trim(p_phone), ''),
     trim(p_name) || ', ' || trim(p_address), 0, 0, 0, 'bank_slip', p_slip_path)
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

  -- Discount (validated server-side; usage counted only on successful placement).
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

  -- Shipping: flat rate, waived past the free-shipping threshold (if set).
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
  values (v_order_id, 'pending_approval', 'Order placed — awaiting payment approval');

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

grant execute on function public.place_order(text, text, text, text, text, jsonb, text) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- get_order_by_token — include the discount amount.
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
    'items', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'name', i.name, 'image', i.image, 'size', i.size,
        'color', i.color, 'unit_price', i.unit_price, 'qty', i.qty)), '[]'::jsonb)
      from public.order_items i where i.order_id = o.id
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
