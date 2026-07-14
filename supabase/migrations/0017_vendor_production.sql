-- ===========================================================================
-- 0017 — Vendor production dashboard
--
-- Melelo's production partner (blanks + printing) gets his own dashboard at
-- /vendor. The admin batches PAID orders into a production job (aggregated
-- items + art + due date + unit cost); the vendor advances it
-- Accepted → Printing → Ready and talks on a per-job thread; the ADMIN alone
-- confirms Delivered (receipt of goods) and marks jobs Paid (settlement).
-- Both sides get Telegram DMs on the other's actions.
--
-- Privacy: the vendor role can read ONLY the production tables — job items
-- are snapshots (product/color/size/qty/art), so no customer name, address,
-- phone or email is ever visible to him. No policies elsewhere change.
--
-- Run this whole file in the Supabase SQL editor. Requires 0001–0016.
--
-- Vendor onboarding (run AFTER this file, as separate statements):
--   1. Supabase Dashboard → Authentication → Add user (email + password).
--   2. update public.profiles set role = 'vendor' where id = '<that user uuid>';
--   3. Admin → Settings → Telegram: set "Vendor chat id" (he sends /id to the bot).
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Role
-- ---------------------------------------------------------------------------
alter type user_role add value if not exists 'vendor';

-- NOTE: compares role::text — the enum value added above cannot be used as a
-- literal inside this same transaction.
create or replace function public.is_vendor() returns boolean
  language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role::text = 'vendor');
$$;

-- ---------------------------------------------------------------------------
-- Schema
-- ---------------------------------------------------------------------------
do $$ begin
  create type production_status as enum
    ('sent','accepted','printing','ready','delivered','cancelled');
exception when duplicate_object then null; end $$;

create table if not exists public.production_jobs (
  id           uuid primary key default gen_random_uuid(),
  human_id     text unique not null,
  status       production_status not null default 'sent',
  due_date     date,
  note         text,
  unit_total   int not null default 0,
  cost_total   numeric(10,2) not null default 0,
  paid         boolean not null default false,
  paid_at      timestamptz,
  accepted_at  timestamptz,
  ready_at     timestamptz,
  delivered_at timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
drop trigger if exists production_jobs_set_updated_at on public.production_jobs;
create trigger production_jobs_set_updated_at before update on public.production_jobs
  for each row execute function public.set_updated_at();

create table if not exists public.production_job_items (
  id         uuid primary key default gen_random_uuid(),
  job_id     uuid not null references public.production_jobs(id) on delete cascade,
  order_id   uuid references public.orders(id) on delete set null,
  product_id uuid references public.products(id) on delete set null,
  name       text not null,
  color      text not null,
  size       text not null,
  qty        int not null check (qty > 0),
  image      text,
  unit_cost  numeric(10,2) not null default 0
);
create index if not exists production_job_items_job_idx on public.production_job_items(job_id);

create table if not exists public.production_events (
  id         uuid primary key default gen_random_uuid(),
  job_id     uuid not null references public.production_jobs(id) on delete cascade,
  author     text not null check (author in ('admin','vendor')),
  status     text,
  note       text,
  created_at timestamptz not null default now()
);
create index if not exists production_events_job_idx on public.production_events(job_id);

alter table public.orders add column if not exists production_job_id uuid
  references public.production_jobs(id) on delete set null;

alter table public.settings add column if not exists vendor_telegram_chat_id text;

-- Job totals always reflect the lines (admin can edit unit costs inline).
create or replace function public.refresh_job_totals()
returns trigger
  language plpgsql security definer set search_path = public as $$
declare
  v_job uuid := coalesce(new.job_id, old.job_id);
begin
  update public.production_jobs j
    set unit_total = coalesce(sub.units, 0),
        cost_total = coalesce(sub.cost, 0)
    from (
      select sum(qty)::int as units, sum(qty * unit_cost) as cost
      from public.production_job_items where job_id = v_job
    ) sub
    where j.id = v_job;
  return coalesce(new, old);
end $$;
drop trigger if exists production_items_totals on public.production_job_items;
create trigger production_items_totals
  after insert or update or delete on public.production_job_items
  for each row execute function public.refresh_job_totals();

-- ---------------------------------------------------------------------------
-- RLS — admin: everything; vendor: read-only (writes go through RPCs below).
-- ---------------------------------------------------------------------------
alter table public.production_jobs      enable row level security;
alter table public.production_job_items enable row level security;
alter table public.production_events    enable row level security;

do $$
declare t text;
begin
  foreach t in array array['production_jobs','production_job_items','production_events'] loop
    execute format('drop policy if exists "%1$s admin all" on public.%1$s;', t);
    execute format('create policy "%1$s admin all" on public.%1$s for all using (public.is_admin()) with check (public.is_admin());', t);
    execute format('drop policy if exists "%1$s vendor read" on public.%1$s;', t);
    execute format('create policy "%1$s vendor read" on public.%1$s for select using (public.is_vendor());', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- create_production_job — admin batches paid orders into one job.
-- ---------------------------------------------------------------------------
create or replace function public.create_production_job(
  p_order_ids uuid[],
  p_due date default null,
  p_note text default null,
  p_unit_cost numeric default 0
) returns jsonb
  language plpgsql security definer set search_path = public as $$
declare
  o      public.orders%rowtype;
  v_id   uuid;
  v_hid  text;
  v_oid  uuid;
begin
  if not public.is_admin() then raise exception 'Admins only.'; end if;
  if p_order_ids is null or array_length(p_order_ids, 1) is null then
    raise exception 'Select at least one order.';
  end if;

  foreach v_oid in array p_order_ids loop
    select * into o from public.orders where id = v_oid;
    if not found then raise exception 'Order not found.'; end if;
    if o.payment_status <> 'paid' then
      raise exception 'Order % is not paid yet.', o.human_id;
    end if;
    if o.fulfillment_status in ('cancelled','delivered') then
      raise exception 'Order % is %.', o.human_id, o.fulfillment_status;
    end if;
    if o.production_job_id is not null then
      raise exception 'Order % is already in a production job.', o.human_id;
    end if;
  end loop;

  v_hid := 'JOB-' || to_char(now(), 'YYYYMMDD') || '-' || lpad(floor(random() * 10000)::text, 4, '0');
  insert into public.production_jobs (human_id, due_date, note)
  values (v_hid, p_due, nullif(trim(p_note), ''))
  returning id into v_id;

  -- Aggregated snapshot: the vendor sees WHAT to produce, never for whom.
  insert into public.production_job_items (job_id, product_id, name, color, size, qty, image, unit_cost)
  select v_id, i.product_id, i.name, i.color, i.size, sum(i.qty), max(i.image), coalesce(p_unit_cost, 0)
  from public.order_items i
  where i.order_id = any(p_order_ids)
  group by i.product_id, i.name, i.color, i.size;

  update public.orders set production_job_id = v_id where id = any(p_order_ids);

  insert into public.production_events (job_id, author, status, note)
  values (v_id, 'admin', 'sent',
    coalesce(nullif(trim(p_note), ''), 'New production job') ||
    case when p_due is not null then ' · due ' || to_char(p_due, 'Mon DD') else '' end);

  return jsonb_build_object('id', v_id, 'human_id', v_hid);
end $$;
grant execute on function public.create_production_job(uuid[], date, text, numeric) to authenticated;

-- ---------------------------------------------------------------------------
-- vendor_update_job — the vendor's only write path; legal transitions only.
-- ---------------------------------------------------------------------------
create or replace function public.vendor_update_job(p_id uuid, p_status text, p_note text default null)
returns jsonb
  language plpgsql security definer set search_path = public as $$
declare
  j public.production_jobs%rowtype;
begin
  if not public.is_vendor() then raise exception 'Vendor account required.'; end if;

  select * into j from public.production_jobs where id = p_id;
  if not found then raise exception 'Job not found.'; end if;

  if not ((j.status = 'sent'     and p_status = 'accepted') or
          (j.status = 'accepted' and p_status = 'printing') or
          (j.status = 'printing' and p_status = 'ready')) then
    raise exception 'Cannot move a % job to %.', j.status, p_status;
  end if;

  update public.production_jobs
    set status      = p_status::production_status,
        accepted_at = case when p_status = 'accepted' then now() else accepted_at end,
        ready_at    = case when p_status = 'ready'    then now() else ready_at end
    where id = p_id;

  insert into public.production_events (job_id, author, status, note)
  values (p_id, 'vendor', p_status, nullif(trim(p_note), ''));

  return jsonb_build_object('status', p_status);
end $$;
grant execute on function public.vendor_update_job(uuid, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- production_comment — thread message from either side (author auto-stamped).
-- ---------------------------------------------------------------------------
create or replace function public.production_comment(p_id uuid, p_note text)
returns jsonb
  language plpgsql security definer set search_path = public as $$
declare
  v_author text;
begin
  if public.is_admin() then v_author := 'admin';
  elsif public.is_vendor() then v_author := 'vendor';
  else raise exception 'Not allowed.'; end if;

  if coalesce(trim(p_note), '') = '' then raise exception 'Empty message.'; end if;
  if not exists (select 1 from public.production_jobs where id = p_id) then
    raise exception 'Job not found.';
  end if;

  insert into public.production_events (job_id, author, note)
  values (p_id, v_author, trim(p_note));
  return jsonb_build_object('ok', true);
end $$;
grant execute on function public.production_comment(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- Admin-side job actions
-- ---------------------------------------------------------------------------
-- Receipt of goods: only the admin can say "Delivered".
create or replace function public.admin_receive_job(p_id uuid)
returns jsonb
  language plpgsql security definer set search_path = public as $$
declare
  j public.production_jobs%rowtype;
begin
  if not public.is_admin() then raise exception 'Admins only.'; end if;
  select * into j from public.production_jobs where id = p_id;
  if not found then raise exception 'Job not found.'; end if;
  if j.status in ('delivered','cancelled') then
    raise exception 'Job is already %.', j.status;
  end if;

  update public.production_jobs
    set status = 'delivered', delivered_at = now() where id = p_id;
  insert into public.production_events (job_id, author, status, note)
  values (p_id, 'admin', 'delivered', 'Goods received — thank you');
  return jsonb_build_object('ok', true);
end $$;
grant execute on function public.admin_receive_job(uuid) to authenticated;

-- Optional follow-up: advance the job's confirmed orders to "packed"
-- (customers get their normal Packed notification via notify_order_event).
create or replace function public.job_orders_packed(p_id uuid)
returns jsonb
  language plpgsql security definer set search_path = public as $$
declare
  o record;
  v_n int := 0;
begin
  if not public.is_admin() then raise exception 'Admins only.'; end if;
  if not exists (select 1 from public.production_jobs where id = p_id and status = 'delivered') then
    raise exception 'Mark the job delivered first.';
  end if;

  for o in
    select id from public.orders
    where production_job_id = p_id and fulfillment_status = 'confirmed'
  loop
    update public.orders set fulfillment_status = 'packed' where id = o.id;
    insert into public.order_events (order_id, status, note)
    values (o.id, 'packed', 'Marked as packed');
    v_n := v_n + 1;
  end loop;
  return jsonb_build_object('packed', v_n);
end $$;
grant execute on function public.job_orders_packed(uuid) to authenticated;

create or replace function public.job_mark_paid(p_id uuid, p_paid boolean)
returns jsonb
  language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Admins only.'; end if;
  update public.production_jobs
    set paid = p_paid, paid_at = case when p_paid then now() else null end
    where id = p_id;
  if not found then raise exception 'Job not found.'; end if;
  insert into public.production_events (job_id, author, note)
  values (p_id, 'admin', case when p_paid then '💵 Payment sent — job marked paid' else 'Job marked unpaid' end);
  return jsonb_build_object('paid', p_paid);
end $$;
grant execute on function public.job_mark_paid(uuid, boolean) to authenticated;

create or replace function public.admin_cancel_job(p_id uuid)
returns jsonb
  language plpgsql security definer set search_path = public as $$
declare
  j public.production_jobs%rowtype;
begin
  if not public.is_admin() then raise exception 'Admins only.'; end if;
  select * into j from public.production_jobs where id = p_id;
  if not found then raise exception 'Job not found.'; end if;
  if j.status = 'delivered' then raise exception 'Delivered jobs cannot be cancelled.'; end if;

  update public.production_jobs set status = 'cancelled' where id = p_id;
  update public.orders set production_job_id = null where production_job_id = p_id;
  insert into public.production_events (job_id, author, status, note)
  values (p_id, 'admin', 'cancelled', 'Job cancelled');
  return jsonb_build_object('ok', true);
end $$;
grant execute on function public.admin_cancel_job(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Telegram fan-out: admin actions DM the vendor; vendor actions DM the admin.
-- ---------------------------------------------------------------------------
create or replace function public.notify_production_event()
returns trigger
  language plpgsql security definer set search_path = public as $$
declare
  s       record;
  j       public.production_jobs%rowtype;
  v_token text;
  v_chat  text;
  v_url   text;
  v_text  text;
  v_emoji text;
begin
  select telegram_enabled, telegram_admin_chat_id, vendor_telegram_chat_id, site_url
    into s from public.settings where id = 1;
  if s is null or not coalesce(s.telegram_enabled, false) then return new; end if;
  select v into v_token from private.secrets where k = 'telegram_bot_token';
  if v_token is null then return new; end if;

  select * into j from public.production_jobs where id = new.job_id;
  if not found then return new; end if;

  -- Cross-notify: the actor's counterpart gets the DM.
  if new.author = 'admin' then
    v_chat := nullif(trim(s.vendor_telegram_chat_id), '');
    v_url  := case when coalesce(trim(s.site_url), '') <> '' then rtrim(s.site_url, '/') || '/vendor' else null end;
  else
    v_chat := nullif(trim(s.telegram_admin_chat_id), '');
    v_url  := case when coalesce(trim(s.site_url), '') <> '' then rtrim(s.site_url, '/') || '/admin/production' else null end;
  end if;
  if v_chat is null then return new; end if;

  v_emoji := case new.status
    when 'sent' then '🧵' when 'accepted' then '✅' when 'printing' then '🖨'
    when 'ready' then '📦' when 'delivered' then '🤝' when 'cancelled' then '❌'
    else '💬' end;

  v_text := v_emoji || ' ' || j.human_id
    || case when new.status is not null then ' — ' || new.status else '' end
    || e'\n' || coalesce(new.note, '')
    || e'\n' || j.unit_total || ' piece(s)'
    || case when j.due_date is not null then ' · due ' || to_char(j.due_date, 'Mon DD') else '' end;

  perform net.http_post(
    url := 'https://api.telegram.org/bot' || v_token || '/sendMessage',
    body := jsonb_strip_nulls(jsonb_build_object(
      'chat_id', v_chat,
      'text', v_text,
      'reply_markup', case when v_url is not null
        then jsonb_build_object('inline_keyboard', jsonb_build_array(jsonb_build_array(
          jsonb_build_object('text', '🧵 Open production', 'url', v_url))))
        else null end)),
    headers := jsonb_build_object('Content-Type', 'application/json'));

  return new;
exception when others then
  return new; -- notifications must never block production actions
end $$;

drop trigger if exists production_events_notify on public.production_events;
create trigger production_events_notify
  after insert on public.production_events
  for each row execute function public.notify_production_event();
