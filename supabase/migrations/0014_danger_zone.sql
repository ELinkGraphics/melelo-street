-- ===========================================================================
-- 0014 — Danger zone: archive & reset, gated by a reset code
--
-- Admin → Settings → Danger. Every action requires the reset code
-- 'AdminDeleteAll2026' (checked SERVER-side in archive.assert_danger — change
-- it there if it ever leaks) on top of being an authenticated admin.
--
-- • Archive orders    — moves ALL orders (+ items, events, payments, reviews)
--                       into the archive schema; dashboard starts at zero;
--                       product ratings reset automatically.
-- • Archive stock     — snapshots inventory levels, then zeroes them.
-- • Archive messages  — moves the Telegram inbox out.
-- • Archive discounts — moves all discount codes out.
-- • Archive everything — all of the above in one go.
-- • Restore batch     — moves an archived batch back (orders restore heals
--                       references to since-deleted products/users, and the
--                       notify trigger is disabled during the copy so NO
--                       old-status emails/DMs are re-sent).
--
-- The archive schema is not exposed through the API; it is only reachable
-- through these admin-gated functions. Handy when handing the store to a new
-- owner: archive everything, reconfigure Settings, rotate the API keys.
--
-- NOTE: the archive tables mirror today's public tables. If a later migration
-- adds columns to orders/order_items/…, add the same columns to the archive
-- twins before archiving again.
--
-- Run this whole file in the Supabase SQL editor. Requires 0001–0013.
-- ===========================================================================

create schema if not exists archive;

create table if not exists archive.batches (
  id          uuid primary key default gen_random_uuid(),
  kind        text not null check (kind in ('orders','stock','messages','discounts')),
  label       text not null,
  item_count  int not null default 0,
  created_at  timestamptz not null default now(),
  restored_at timestamptz
);

-- Shadow tables: same columns as the live ones + the batch they belong to.
do $$ begin
  create table archive.orders            (like public.orders);
  alter table archive.orders            add column batch_id uuid not null;
exception when duplicate_table then null; end $$;
do $$ begin
  create table archive.order_items       (like public.order_items);
  alter table archive.order_items       add column batch_id uuid not null;
exception when duplicate_table then null; end $$;
do $$ begin
  create table archive.order_events      (like public.order_events);
  alter table archive.order_events      add column batch_id uuid not null;
exception when duplicate_table then null; end $$;
do $$ begin
  create table archive.payments          (like public.payments);
  alter table archive.payments          add column batch_id uuid not null;
exception when duplicate_table then null; end $$;
do $$ begin
  create table archive.reviews           (like public.reviews);
  alter table archive.reviews           add column batch_id uuid not null;
exception when duplicate_table then null; end $$;
do $$ begin
  create table archive.inventory         (like public.inventory);
  alter table archive.inventory         add column batch_id uuid not null;
exception when duplicate_table then null; end $$;
do $$ begin
  create table archive.telegram_messages (like public.telegram_messages);
  alter table archive.telegram_messages add column batch_id uuid not null;
exception when duplicate_table then null; end $$;
do $$ begin
  create table archive.discounts         (like public.discounts);
  alter table archive.discounts         add column batch_id uuid not null;
exception when duplicate_table then null; end $$;

create index if not exists archive_orders_batch_idx       on archive.orders(batch_id);
create index if not exists archive_order_items_batch_idx  on archive.order_items(batch_id);
create index if not exists archive_order_events_batch_idx on archive.order_events(batch_id);

-- ---------------------------------------------------------------------------
-- Gate: authenticated admin + the reset code. Change the code HERE if needed.
-- ---------------------------------------------------------------------------
create or replace function archive.assert_danger(p_code text)
returns void
  language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then
    raise exception 'Admins only.';
  end if;
  if p_code is distinct from 'AdminDeleteAll2026' then
    raise exception 'Wrong reset code.';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Archive actions
-- ---------------------------------------------------------------------------
create or replace function public.admin_archive_orders(p_code text)
returns jsonb
  language plpgsql security definer set search_path = public as $$
declare
  v_batch uuid := gen_random_uuid();
  v_n     int;
begin
  perform archive.assert_danger(p_code);
  select count(*) into v_n from public.orders;
  if v_n = 0 then return jsonb_build_object('kind', 'orders', 'archived', 0); end if;

  insert into archive.batches (id, kind, label, item_count)
  values (v_batch, 'orders', 'Orders · ' || to_char(now(), 'Mon DD, YYYY HH24:MI'), v_n);

  insert into archive.orders            select o.*, v_batch from public.orders o;
  insert into archive.order_items       select i.*, v_batch from public.order_items i;
  insert into archive.order_events      select e.*, v_batch from public.order_events e;
  insert into archive.payments          select p.*, v_batch from public.payments p;
  insert into archive.reviews           select r.*, v_batch from public.reviews r;

  -- Cascades wipe items/events/payments/reviews; the reviews trigger resets
  -- every product's rating/review_count along the way.
  delete from public.orders;

  return jsonb_build_object('kind', 'orders', 'archived', v_n, 'batch', v_batch);
end $$;
grant execute on function public.admin_archive_orders(text) to authenticated;

create or replace function public.admin_archive_stock(p_code text)
returns jsonb
  language plpgsql security definer set search_path = public as $$
declare
  v_batch uuid := gen_random_uuid();
  v_n     int;
begin
  perform archive.assert_danger(p_code);
  select count(*) into v_n from public.inventory where stock_qty <> 0;
  if v_n = 0 then return jsonb_build_object('kind', 'stock', 'archived', 0); end if;

  insert into archive.batches (id, kind, label, item_count)
  values (v_batch, 'stock', 'Stock levels · ' || to_char(now(), 'Mon DD, YYYY HH24:MI'), v_n);

  insert into archive.inventory select i.*, v_batch from public.inventory i;
  update public.inventory set stock_qty = 0 where stock_qty <> 0;

  return jsonb_build_object('kind', 'stock', 'archived', v_n, 'batch', v_batch);
end $$;
grant execute on function public.admin_archive_stock(text) to authenticated;

create or replace function public.admin_archive_messages(p_code text)
returns jsonb
  language plpgsql security definer set search_path = public as $$
declare
  v_batch uuid := gen_random_uuid();
  v_n     int;
begin
  perform archive.assert_danger(p_code);
  select count(*) into v_n from public.telegram_messages;
  if v_n = 0 then return jsonb_build_object('kind', 'messages', 'archived', 0); end if;

  insert into archive.batches (id, kind, label, item_count)
  values (v_batch, 'messages', 'Telegram inbox · ' || to_char(now(), 'Mon DD, YYYY HH24:MI'), v_n);

  insert into archive.telegram_messages select m.*, v_batch from public.telegram_messages m;
  delete from public.telegram_messages;

  return jsonb_build_object('kind', 'messages', 'archived', v_n, 'batch', v_batch);
end $$;
grant execute on function public.admin_archive_messages(text) to authenticated;

create or replace function public.admin_archive_discounts(p_code text)
returns jsonb
  language plpgsql security definer set search_path = public as $$
declare
  v_batch uuid := gen_random_uuid();
  v_n     int;
begin
  perform archive.assert_danger(p_code);
  select count(*) into v_n from public.discounts;
  if v_n = 0 then return jsonb_build_object('kind', 'discounts', 'archived', 0); end if;

  insert into archive.batches (id, kind, label, item_count)
  values (v_batch, 'discounts', 'Discount codes · ' || to_char(now(), 'Mon DD, YYYY HH24:MI'), v_n);

  insert into archive.discounts select d.*, v_batch from public.discounts d;
  delete from public.discounts;

  return jsonb_build_object('kind', 'discounts', 'archived', v_n, 'batch', v_batch);
end $$;
grant execute on function public.admin_archive_discounts(text) to authenticated;

create or replace function public.admin_archive_all(p_code text)
returns jsonb
  language plpgsql security definer set search_path = public as $$
begin
  perform archive.assert_danger(p_code);
  return jsonb_build_object(
    'orders',    public.admin_archive_orders(p_code),
    'stock',     public.admin_archive_stock(p_code),
    'messages',  public.admin_archive_messages(p_code),
    'discounts', public.admin_archive_discounts(p_code));
end $$;
grant execute on function public.admin_archive_all(text) to authenticated;

-- ---------------------------------------------------------------------------
-- Restore a batch. Orders restore heals references to rows deleted since the
-- archive (missing users/products/variants become NULL; reviews of deleted
-- products are skipped) and re-inserts history with the notify trigger OFF.
-- ---------------------------------------------------------------------------
create or replace function public.admin_restore_batch(p_code text, p_batch uuid)
returns jsonb
  language plpgsql security definer set search_path = public as $$
declare
  b   archive.batches%rowtype;
  v_n int := 0;
begin
  perform archive.assert_danger(p_code);

  select * into b from archive.batches where id = p_batch;
  if not found then raise exception 'Archive batch not found.'; end if;
  if b.restored_at is not null then raise exception 'This batch was already restored.'; end if;

  if b.kind = 'orders' then
    -- History must not re-notify customers.
    alter table public.order_events disable trigger order_events_notify;

    insert into public.orders
    select (jsonb_populate_record(null::public.orders,
      (to_jsonb(a) - 'batch_id')
      || case when a.customer_id is not null
             and not exists (select 1 from auth.users u where u.id = a.customer_id)
           then jsonb_build_object('customer_id', null) else '{}'::jsonb end
    )).*
    from archive.orders a where a.batch_id = p_batch
    on conflict (id) do nothing;
    get diagnostics v_n = row_count;

    insert into public.order_items
    select (jsonb_populate_record(null::public.order_items,
      (to_jsonb(a) - 'batch_id')
      || case when a.product_id is not null
             and not exists (select 1 from public.products p where p.id = a.product_id)
           then jsonb_build_object('product_id', null) else '{}'::jsonb end
      || case when a.variant_id is not null
             and not exists (select 1 from public.product_variants v where v.id = a.variant_id)
           then jsonb_build_object('variant_id', null) else '{}'::jsonb end
    )).*
    from archive.order_items a where a.batch_id = p_batch
    on conflict (id) do nothing;

    insert into public.order_events
    select (jsonb_populate_record(null::public.order_events,
      (to_jsonb(a) - 'batch_id')
      || case when a.created_by is not null
             and not exists (select 1 from auth.users u where u.id = a.created_by)
           then jsonb_build_object('created_by', null) else '{}'::jsonb end
    )).*
    from archive.order_events a where a.batch_id = p_batch
    on conflict (id) do nothing;

    insert into public.payments
    select (jsonb_populate_record(null::public.payments, to_jsonb(a) - 'batch_id')).*
    from archive.payments a where a.batch_id = p_batch
    on conflict (id) do nothing;

    -- Reviews only where their product still exists (ratings recalc via trigger).
    insert into public.reviews
    select (jsonb_populate_record(null::public.reviews, to_jsonb(a) - 'batch_id')).*
    from archive.reviews a
    where a.batch_id = p_batch
      and exists (select 1 from public.products p where p.id = a.product_id)
    on conflict do nothing;

    alter table public.order_events enable trigger order_events_notify;

    delete from archive.orders       where batch_id = p_batch;
    delete from archive.order_items  where batch_id = p_batch;
    delete from archive.order_events where batch_id = p_batch;
    delete from archive.payments     where batch_id = p_batch;
    delete from archive.reviews      where batch_id = p_batch;

  elsif b.kind = 'stock' then
    update public.inventory i
      set stock_qty = a.stock_qty
      from archive.inventory a
      where a.batch_id = p_batch and a.variant_id = i.variant_id and a.size = i.size;
    get diagnostics v_n = row_count;
    delete from archive.inventory where batch_id = p_batch;

  elsif b.kind = 'messages' then
    insert into public.telegram_messages
    select (jsonb_populate_record(null::public.telegram_messages, to_jsonb(a) - 'batch_id')).*
    from archive.telegram_messages a where a.batch_id = p_batch
    on conflict (id) do nothing;
    get diagnostics v_n = row_count;
    delete from archive.telegram_messages where batch_id = p_batch;

  elsif b.kind = 'discounts' then
    insert into public.discounts
    select (jsonb_populate_record(null::public.discounts, to_jsonb(a) - 'batch_id')).*
    from archive.discounts a where a.batch_id = p_batch
    on conflict do nothing;
    get diagnostics v_n = row_count;
    delete from archive.discounts where batch_id = p_batch;
  end if;

  update archive.batches set restored_at = now() where id = p_batch;
  return jsonb_build_object('kind', b.kind, 'restored', v_n);
end $$;
grant execute on function public.admin_restore_batch(text, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- List batches (admin only; viewing needs no code).
-- ---------------------------------------------------------------------------
create or replace function public.admin_list_archive()
returns table (id uuid, kind text, label text, item_count int, created_at timestamptz, restored_at timestamptz)
  language sql stable security definer set search_path = public as $$
  select b.id, b.kind, b.label, b.item_count, b.created_at, b.restored_at
  from archive.batches b
  where public.is_admin()
  order by b.created_at desc;
$$;
grant execute on function public.admin_list_archive() to authenticated;
