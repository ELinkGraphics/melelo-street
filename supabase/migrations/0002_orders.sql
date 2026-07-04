-- Phase 2 — real orders: guest tracking tokens, stock-aware order placement,
-- and admin stock adjustments. Run after 0001_init.sql. Safe to re-run.

-- ---------------------------------------------------------------------------
-- Schema additions
-- ---------------------------------------------------------------------------
-- Guests have no auth session, so each order carries a secret token; knowing
-- (order id + token) grants read access to that order via get_order_by_token.
alter table public.orders
  add column if not exists tracking_token uuid not null default gen_random_uuid();

-- Snapshot the variant so reject/cancel can restore the exact stock row.
alter table public.order_items
  add column if not exists variant_id uuid references public.product_variants(id) on delete set null;

-- ---------------------------------------------------------------------------
-- place_order — guest checkout entry point (called via supabase.rpc with the
-- anon key). SECURITY DEFINER: validates and prices everything server-side in
-- ONE transaction — client-sent prices are ignored.
--   p_items: [{ "product_id": uuid, "color": text, "size": text, "qty": int }]
-- Stock is decremented here (reserved at placement); reject/cancel restores it.
-- ---------------------------------------------------------------------------
create or replace function public.place_order(
  p_name text,
  p_address text,
  p_phone text,
  p_email text,
  p_slip_path text,
  p_items jsonb
) returns jsonb
  language plpgsql security definer set search_path = public as $$
declare
  v_item     jsonb;
  v_product  public.products%rowtype;
  v_variant  public.product_variants%rowtype;
  v_qty      int;
  v_size     text;
  v_image    text;
  v_subtotal numeric := 0;
  v_shipping numeric := 0;
  v_order_id uuid;
  v_human    text;
  v_token    uuid;
  v_updated  int;
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

  select coalesce(shipping_flat, 0) into v_shipping from public.settings where id = 1;
  v_shipping := coalesce(v_shipping, 0);

  v_human := 'MLB-' || to_char(now(), 'YYYYMMDD') || '-' || lpad(floor(random() * 1000000)::text, 6, '0');

  insert into public.orders
    (human_id, email, phone, ship_address, subtotal, shipping, total, payment_method, slip_url)
  values
    (v_human, nullif(trim(p_email), ''), nullif(trim(p_phone), ''),
     trim(p_name) || ', ' || trim(p_address), 0, v_shipping, 0, 'bank_slip', p_slip_path)
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

    -- Atomic reserve: only succeeds if enough stock remains.
    update public.inventory
      set stock_qty = stock_qty - v_qty
      where variant_id = v_variant.id and size = v_size and stock_qty >= v_qty;
    get diagnostics v_updated = row_count;
    if v_updated = 0 then
      raise exception 'Out of stock: % — % / size %.', v_product.name, v_variant.color_name, v_size;
    end if;

    -- Variant-specific product image first, then product-level fallback.
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

  update public.orders
    set subtotal = v_subtotal, total = v_subtotal + v_shipping
    where id = v_order_id;

  insert into public.order_events (order_id, status, note)
  values (v_order_id, 'pending_approval', 'Order placed — awaiting payment approval');

  return jsonb_build_object(
    'id', v_order_id,
    'human_id', v_human,
    'token', v_token,
    'subtotal', v_subtotal,
    'shipping', v_shipping,
    'total', v_subtotal + v_shipping,
    'placed_at', now()
  );
end $$;

grant execute on function public.place_order(text, text, text, text, text, jsonb) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- get_order_by_token — guest order tracking. Returns the order (+ items and
-- event timeline) only when BOTH the order id and its secret token match.
-- ---------------------------------------------------------------------------
create or replace function public.get_order_by_token(p_id uuid, p_token uuid)
returns jsonb
  language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'id', o.id,
    'human_id', o.human_id,
    'subtotal', o.subtotal,
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

-- ---------------------------------------------------------------------------
-- adjust_stock — admin-only atomic stock delta (used to restore reserved stock
-- when an order is rejected or cancelled).
-- ---------------------------------------------------------------------------
create or replace function public.adjust_stock(p_variant uuid, p_size text, p_delta int)
returns void
  language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then
    raise exception 'Admins only.';
  end if;
  update public.inventory
    set stock_qty = greatest(0, stock_qty + p_delta)
    where variant_id = p_variant and size = p_size;
end $$;

grant execute on function public.adjust_stock(uuid, text, int) to authenticated;
