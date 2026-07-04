-- Melelo Brands — initial schema, RLS, storage, and seed.
-- Run in the Supabase SQL editor (or `supabase db push`). Idempotent-ish: safe to
-- re-run on a fresh project; seed uses ON CONFLICT DO NOTHING.

-- ---------------------------------------------------------------------------
-- Extensions & enums
-- ---------------------------------------------------------------------------
create extension if not exists pgcrypto;

do $$ begin
  create type product_status as enum ('draft','active','archived');
exception when duplicate_object then null; end $$;
do $$ begin
  create type image_view as enum ('model','product');
exception when duplicate_object then null; end $$;
do $$ begin
  create type payment_method as enum ('chapa','bank_slip');
exception when duplicate_object then null; end $$;
do $$ begin
  create type payment_status as enum ('pending','paid','failed','refunded');
exception when duplicate_object then null; end $$;
do $$ begin
  create type fulfillment_status as enum
    ('pending_approval','confirmed','packed','shipped','out_for_delivery','delivered','cancelled');
exception when duplicate_object then null; end $$;
do $$ begin
  create type discount_type as enum ('percent','fixed');
exception when duplicate_object then null; end $$;
do $$ begin
  create type user_role as enum ('admin','customer');
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
-- NOTE: public.is_admin() is defined further down, right after the profiles
-- table — a SQL function's body is validated at creation time and it references
-- public.profiles, so that table must exist first.
create or replace function public.set_updated_at() returns trigger
  language plpgsql as $$
begin new.updated_at = now(); return new; end $$;

-- ---------------------------------------------------------------------------
-- Catalog
-- ---------------------------------------------------------------------------
create table if not exists public.categories (
  id   uuid primary key default gen_random_uuid(),
  slug text unique not null,
  name text not null,
  sort int not null default 0
);

create table if not exists public.products (
  id            uuid primary key default gen_random_uuid(),
  category_id   uuid not null references public.categories(id) on delete restrict,
  slug          text unique not null,
  name          text not null,
  description   text,
  base_price    numeric(10,2) not null default 0,
  status        product_status not null default 'draft',
  is_bestseller boolean not null default false,
  rating        numeric(2,1),
  review_count  int default 0,
  created_at    timestamptz not null default now()
);
create index if not exists products_category_idx on public.products(category_id);
create index if not exists products_status_idx on public.products(status);

create table if not exists public.product_variants (
  id         uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products(id) on delete cascade,
  color_name text not null,
  color_hex  text not null,
  sku        text
);
create index if not exists variants_product_idx on public.product_variants(product_id);

create table if not exists public.product_images (
  id         uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products(id) on delete cascade,
  variant_id uuid references public.product_variants(id) on delete cascade,
  view       image_view not null,
  url        text not null,
  alt        text,
  sort       int not null default 0
);
create index if not exists images_product_idx on public.product_images(product_id);

create table if not exists public.inventory (
  id                  uuid primary key default gen_random_uuid(),
  variant_id          uuid not null references public.product_variants(id) on delete cascade,
  size                text not null,
  stock_qty           int not null default 0,
  low_stock_threshold int not null default 3,
  unique (variant_id, size)
);

-- ---------------------------------------------------------------------------
-- People
-- ---------------------------------------------------------------------------
create table if not exists public.profiles (
  id        uuid primary key references auth.users(id) on delete cascade,
  full_name text,
  phone     text,
  role      user_role not null default 'customer'
);

-- Admin check — defined here (after profiles exists) because its SQL body is
-- validated at creation time. Used by RLS policies and storage policies below.
create or replace function public.is_admin() returns boolean
  language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role = 'admin');
$$;

-- Auto-create a profile row for each new auth user.
create or replace function public.handle_new_user() returns trigger
  language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, full_name, role)
  values (new.id, coalesce(new.raw_user_meta_data->>'full_name',''), 'customer')
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- Orders
-- ---------------------------------------------------------------------------
create table if not exists public.orders (
  id                 uuid primary key default gen_random_uuid(),
  human_id           text unique not null,
  customer_id        uuid references auth.users(id) on delete set null,
  email              text,
  phone              text,
  ship_address       text,
  subtotal           numeric(10,2) not null default 0,
  shipping           numeric(10,2) not null default 0,
  discount           numeric(10,2) not null default 0,
  total              numeric(10,2) not null default 0,
  currency           text not null default 'USD',
  payment_method     payment_method not null,
  payment_status     payment_status not null default 'pending',
  fulfillment_status fulfillment_status not null default 'pending_approval',
  slip_url           text,
  chapa_tx_ref       text,
  approved_at        timestamptz,
  placed_at          timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create index if not exists orders_customer_idx on public.orders(customer_id);
create index if not exists orders_placed_idx on public.orders(placed_at desc);
drop trigger if exists orders_set_updated_at on public.orders;
create trigger orders_set_updated_at before update on public.orders
  for each row execute function public.set_updated_at();

create table if not exists public.order_items (
  id         uuid primary key default gen_random_uuid(),
  order_id   uuid not null references public.orders(id) on delete cascade,
  product_id uuid references public.products(id) on delete set null,
  name       text not null,
  image      text,
  size       text not null,
  color      text not null,
  unit_price numeric(10,2) not null,
  qty        int not null check (qty > 0)
);
create index if not exists order_items_order_idx on public.order_items(order_id);

create table if not exists public.order_events (
  id         uuid primary key default gen_random_uuid(),
  order_id   uuid not null references public.orders(id) on delete cascade,
  status     text not null,
  note       text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists order_events_order_idx on public.order_events(order_id);

create table if not exists public.payments (
  id           uuid primary key default gen_random_uuid(),
  order_id     uuid not null references public.orders(id) on delete cascade,
  provider     text not null,
  provider_ref text,
  amount       numeric(10,2) not null,
  status       payment_status not null default 'pending',
  raw_payload  jsonb,
  created_at   timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Marketing & settings
-- ---------------------------------------------------------------------------
create table if not exists public.discounts (
  id           uuid primary key default gen_random_uuid(),
  code         text unique not null,
  type         discount_type not null,
  value        numeric(10,2) not null,
  min_subtotal numeric(10,2) not null default 0,
  starts_at    timestamptz,
  ends_at      timestamptz,
  usage_limit  int,
  used_count   int not null default 0,
  active       boolean not null default true
);

create table if not exists public.settings (
  id                  int primary key default 1 check (id = 1),
  store_name          text not null default 'Melelo Brands',
  contact_email       text,
  contact_phone       text,
  socials             jsonb,
  bank_details        jsonb,
  shipping_flat       numeric(10,2) not null default 0,
  free_ship_threshold numeric(10,2),
  currency            text not null default 'USD'
);

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
alter table public.categories       enable row level security;
alter table public.products         enable row level security;
alter table public.product_variants enable row level security;
alter table public.product_images   enable row level security;
alter table public.inventory        enable row level security;
alter table public.profiles         enable row level security;
alter table public.orders           enable row level security;
alter table public.order_items      enable row level security;
alter table public.order_events     enable row level security;
alter table public.payments         enable row level security;
alter table public.discounts        enable row level security;
alter table public.settings         enable row level security;

-- Catalog: public read, admin write.
do $$
declare t text;
begin
  foreach t in array array['categories','products','product_variants','product_images','inventory'] loop
    execute format('drop policy if exists "%1$s public read" on public.%1$s;', t);
    execute format('create policy "%1$s public read" on public.%1$s for select using (true);', t);
    execute format('drop policy if exists "%1$s admin write" on public.%1$s;', t);
    execute format('create policy "%1$s admin write" on public.%1$s for all using (public.is_admin()) with check (public.is_admin());', t);
  end loop;
end $$;

-- Settings: public read (bank details / shipping shown at checkout), admin write.
drop policy if exists "settings public read" on public.settings;
create policy "settings public read" on public.settings for select using (true);
drop policy if exists "settings admin write" on public.settings;
create policy "settings admin write" on public.settings for all using (public.is_admin()) with check (public.is_admin());

-- Profiles: self read/update, admin all.
drop policy if exists "profiles self read" on public.profiles;
create policy "profiles self read" on public.profiles for select using (id = auth.uid() or public.is_admin());
drop policy if exists "profiles self update" on public.profiles;
create policy "profiles self update" on public.profiles for update using (id = auth.uid() or public.is_admin());
drop policy if exists "profiles admin all" on public.profiles;
create policy "profiles admin all" on public.profiles for all using (public.is_admin()) with check (public.is_admin());

-- Orders & children: admin full; customers read their own. Order creation goes
-- through the place-order Edge Function (service role), so no public INSERT policy.
drop policy if exists "orders admin all" on public.orders;
create policy "orders admin all" on public.orders for all using (public.is_admin()) with check (public.is_admin());
drop policy if exists "orders customer read" on public.orders;
create policy "orders customer read" on public.orders for select using (customer_id = auth.uid());

drop policy if exists "order_items admin all" on public.order_items;
create policy "order_items admin all" on public.order_items for all using (public.is_admin()) with check (public.is_admin());
drop policy if exists "order_items customer read" on public.order_items;
create policy "order_items customer read" on public.order_items for select
  using (exists (select 1 from public.orders o where o.id = order_id and o.customer_id = auth.uid()));

drop policy if exists "order_events admin all" on public.order_events;
create policy "order_events admin all" on public.order_events for all using (public.is_admin()) with check (public.is_admin());
drop policy if exists "order_events customer read" on public.order_events;
create policy "order_events customer read" on public.order_events for select
  using (exists (select 1 from public.orders o where o.id = order_id and o.customer_id = auth.uid()));

drop policy if exists "payments admin all" on public.payments;
create policy "payments admin all" on public.payments for all using (public.is_admin()) with check (public.is_admin());

-- Discounts: admin only (validation happens server-side).
drop policy if exists "discounts admin all" on public.discounts;
create policy "discounts admin all" on public.discounts for all using (public.is_admin()) with check (public.is_admin());

-- ---------------------------------------------------------------------------
-- Storage buckets & policies
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public) values
  ('product-images','product-images', true),
  ('payment-slips','payment-slips', false)
on conflict (id) do nothing;

drop policy if exists "product images public read" on storage.objects;
create policy "product images public read" on storage.objects
  for select using (bucket_id = 'product-images');
drop policy if exists "product images admin write" on storage.objects;
create policy "product images admin write" on storage.objects
  for all using (bucket_id = 'product-images' and public.is_admin())
  with check (bucket_id = 'product-images' and public.is_admin());

-- Customers upload a slip at checkout (insert), only admins can read them back.
drop policy if exists "slips insert" on storage.objects;
create policy "slips insert" on storage.objects
  for insert with check (bucket_id = 'payment-slips');
drop policy if exists "slips admin read" on storage.objects;
create policy "slips admin read" on storage.objects
  for select using (bucket_id = 'payment-slips' and public.is_admin());

-- ---------------------------------------------------------------------------
-- Seed — reproduces the current bundled catalog + store settings
-- ---------------------------------------------------------------------------
insert into public.settings (id, store_name, contact_email, contact_phone, socials, bank_details, shipping_flat, free_ship_threshold, currency)
values (1, 'Melelo Brands', 'hello@melelobrands.com', NULL,
  '{"instagram":"#","twitter":"#","tiktok":"#"}',
  '{"bank":"Commercial Bank of Ethiopia","name":"Melelo Brands PLC","account":"1000 2345 6789 01"}',
  0, NULL, 'USD')
on conflict (id) do nothing;

insert into public.categories (slug, name, sort) values
  ('tees','T-Shirts',0),
  ('hoodies','Hoodies',1)
on conflict (slug) do nothing;

-- Tees (real per-color art: White/Black × model/product).
do $$
declare
  cat uuid; p uuid; vw uuid; vb uuid;
begin
  select id into cat from public.categories where slug = 'tees';

  -- Comb Out (DesignOne)
  insert into public.products (category_id, slug, name, description, base_price, status, is_bestseller, rating, review_count)
  values (cat, 'comb-out', 'Comb Out',
    'Crafted for the modern explorer. Advanced fabric technology for breathability and comfort without compromising on style.',
    149, 'active', true, 4.9, 128)
  on conflict (slug) do nothing
  returning id into p;
  if p is not null then
    insert into public.product_variants (product_id, color_name, color_hex, sku)
      values (p,'White','#E8E0D6','COMB-WHT') returning id into vw;
    insert into public.product_variants (product_id, color_name, color_hex, sku)
      values (p,'Black','#1A1A1A','COMB-BLK') returning id into vb;
    insert into public.product_images (product_id, variant_id, view, url, alt, sort) values
      (p, vw, 'model',  '/models/Melelo-DesignOne-White-Tshirt-model.png','Comb Out White', 0),
      (p, vw, 'product','/models/Melelo-DesignOne-White-Tshirt.png','Comb Out White flat', 0),
      (p, vb, 'model',  '/models/Melelo-DesignOne-Black-Tshirt-model.png','Comb Out Black', 0),
      (p, vb, 'product','/models/Melelo-DesignOne-Black-Tshirt.png','Comb Out Black flat', 0);
    insert into public.inventory (variant_id, size, stock_qty) values
      (vw,'S',20),(vw,'M',20),(vw,'L',20),(vw,'XL',20),
      (vb,'S',20),(vb,'M',20),(vb,'L',20),(vb,'XL',20);
  end if;

  -- First Class (DesignTwo)
  insert into public.products (category_id, slug, name, description, base_price, status, is_bestseller, rating, review_count)
  values (cat, 'first-class', 'First Class',
    'Crafted for the modern explorer. Advanced fabric technology for breathability and comfort without compromising on style.',
    149, 'active', false, 4.8, 96)
  on conflict (slug) do nothing
  returning id into p;
  if p is not null then
    insert into public.product_variants (product_id, color_name, color_hex, sku)
      values (p,'White','#E8E0D6','FCLS-WHT') returning id into vw;
    insert into public.product_variants (product_id, color_name, color_hex, sku)
      values (p,'Black','#1A1A1A','FCLS-BLK') returning id into vb;
    insert into public.product_images (product_id, variant_id, view, url, alt, sort) values
      (p, vw, 'model',  '/models/Melelo-DesignTwo-White-Tshirt-model.png','First Class White', 0),
      (p, vw, 'product','/models/Melelo-DesignTwo-White-Tshirt.png','First Class White flat', 0),
      (p, vb, 'model',  '/models/Melelo-DesignTwo-Black-Tshirt-model.png','First Class Black', 0),
      (p, vb, 'product','/models/Melelo-DesignTwo-Black-Tshirt.png','First Class Black flat', 0);
    insert into public.inventory (variant_id, size, stock_qty) values
      (vw,'S',20),(vw,'M',20),(vw,'L',20),(vw,'XL',20),
      (vb,'S',20),(vb,'M',20),(vb,'L',20),(vb,'XL',20);
  end if;
end $$;

-- Hoodies (placeholder art shared across the 4-color palette; base images at
-- product level, palette colors as variants without per-color art).
do $$
declare
  cat uuid; p uuid; v uuid; palette text[][] := array[
    array['White','#E8E0D6'], array['Black','#1A1A1A'],
    array['Grey','#9A9A9A'], array['Orange','#C85A17']];
  hoodie record; c text[];
begin
  select id into cat from public.categories where slug = 'hoodies';
  for hoodie in
    select * from (values
      ('tom-cinder-25','Tom Cinder 25','/models/outfit_two_model.png','/models/outfit_one_cloth.png'),
      ('ds1-tech','DS1 Tech','/models/outfit_three_model.png','/models/outfit_two_cloth.png'),
      ('horizon-shell','Horizon Shell','/models/outfit_four_model.png','/models/outfit_three_cloth.png'),
      ('nokturn-layer','Nokturn Layer','/models/outfit_one_model.png','/models/outfit_four_cloth.png')
    ) as h(slug,name,model,cloth)
  loop
    insert into public.products (category_id, slug, name, description, base_price, status)
    values (cat, hoodie.slug, hoodie.name,
      'Layer up. Heavyweight fleece with a relaxed silhouette.', 149, 'active')
    on conflict (slug) do nothing
    returning id into p;
    if p is not null then
      insert into public.product_images (product_id, variant_id, view, url, sort) values
        (p, NULL, 'model',   hoodie.model, 0),
        (p, NULL, 'product', hoodie.cloth, 0);
      foreach c slice 1 in array palette loop
        insert into public.product_variants (product_id, color_name, color_hex)
          values (p, c[1], c[2]) returning id into v;
        insert into public.inventory (variant_id, size, stock_qty) values
          (v,'S',15),(v,'M',15),(v,'L',15),(v,'XL',15);
      end loop;
    end if;
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- After creating the owner auth user (Supabase → Authentication → Add user,
-- or sign up once at /admin), promote it to admin:
--   update public.profiles set role = 'admin' where id =
--     (select id from auth.users where email = 'you@example.com');
-- ---------------------------------------------------------------------------
