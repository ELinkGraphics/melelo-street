-- Payment recovery — abandoned Chapa payments: server-side reconciliation,
-- finish-payment reminders, auto-expiry with stock release, and payment retry.
-- Run after 0008_telegram.sql. Safe to re-run.
--
-- Scenarios covered:
--   S1a never paid            → remind (once) → expire + release stock (customer
--                               is informed automatically via the notify trigger)
--   S1b paid but never returned → payment_sweeper re-verifies with Chapa ≤5 min
--   S1c wants to retry        → chapa_init issues a fresh per-attempt tx_ref
--   S2  stale bank-slip review → one-time Telegram nudge to the admin chat

-- ---------------------------------------------------------------------------
-- Settings knobs & order columns
-- ---------------------------------------------------------------------------
alter table public.settings
  add column if not exists payment_reminder_minutes int not null default 30,
  add column if not exists payment_expiry_hours int not null default 24;

alter table public.orders
  add column if not exists reminder_sent_at timestamptz,
  add column if not exists chapa_attempts int not null default 0;

-- ---------------------------------------------------------------------------
-- Shared verify+confirm core — used by chapa_confirm (customer return),
-- chapa_init (pre-check before a retry) and payment_sweeper (reconciliation).
-- Returns true when the order is (now) paid.
-- ---------------------------------------------------------------------------
create or replace function private.chapa_verify_order(p_order_id uuid)
returns boolean
  language plpgsql security definer set search_path = public, extensions as $$
declare
  o        public.orders%rowtype;
  v_secret text;
  v_resp   extensions.http_response;
  v_body   jsonb;
  v_status text;
  v_amount numeric;
begin
  select * into o from public.orders where id = p_order_id;
  if not found then return false; end if;
  if o.payment_status = 'paid' then return true; end if;
  if o.payment_method <> 'chapa' or o.chapa_tx_ref is null then return false; end if;

  select v into v_secret from private.secrets where k = 'chapa_secret_key';
  if v_secret is null then return false; end if;

  v_resp := extensions.http((
    'GET',
    'https://api.chapa.co/v1/transaction/verify/' || o.chapa_tx_ref,
    ARRAY[extensions.http_header('Authorization', 'Bearer ' || v_secret)],
    null, null
  )::extensions.http_request);

  v_body   := v_resp.content::jsonb;
  v_status := coalesce(v_body->'data'->>'status', v_body->>'status');
  v_amount := coalesce((v_body->'data'->>'amount')::numeric, 0);

  if v_resp.status = 200 and v_body->>'status' = 'success' and v_status = 'success'
     and v_amount + 0.01 >= o.total then
    update public.orders
      set payment_status = 'paid',
          fulfillment_status = 'confirmed',
          approved_at = now()
      where id = o.id and payment_status <> 'paid';
    insert into public.payments (order_id, provider, provider_ref, amount, status, raw_payload)
    values (o.id, 'chapa', o.chapa_tx_ref, v_amount, 'paid', v_body);
    -- The order_events insert fires the notify trigger → Telegram + email go out.
    insert into public.order_events (order_id, status, note)
    values (o.id, 'confirmed', 'Chapa payment verified — order confirmed');
    return true;
  end if;
  return false;
exception when others then
  return false;
end $$;

-- ---------------------------------------------------------------------------
-- chapa_confirm v2 — same contract, now delegates to the shared core.
-- ---------------------------------------------------------------------------
create or replace function public.chapa_confirm(p_id uuid, p_token uuid)
returns jsonb
  language plpgsql security definer set search_path = public as $$
declare
  o public.orders%rowtype;
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
  return jsonb_build_object('paid', private.chapa_verify_order(o.id));
end $$;
grant execute on function public.chapa_confirm(uuid, uuid) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- chapa_init v2 — retry-capable. Chapa rejects reused tx_refs, so each attempt
-- gets its own reference (attempt 1 keeps the plain human_id for backward
-- compatibility). Before charging again, the previous attempt is verified so a
-- customer who already paid is never double-charged.
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
  v_n      int;
  v_txref  text;
begin
  select * into o from public.orders where id = p_id and tracking_token = p_token;
  if not found then
    raise exception 'Order not found.';
  end if;
  if o.payment_method <> 'chapa' then
    raise exception 'This order does not use Chapa.';
  end if;
  if o.fulfillment_status = 'cancelled' then
    raise exception 'This order was cancelled. Please place a new order.';
  end if;
  if o.payment_status = 'paid' then
    return jsonb_build_object('already_paid', true);
  end if;

  -- A previous attempt may have succeeded without the customer returning.
  if o.chapa_tx_ref is not null and private.chapa_verify_order(o.id) then
    return jsonb_build_object('already_paid', true);
  end if;

  select v into v_secret from private.secrets where k = 'chapa_secret_key';
  if v_secret is null then
    raise exception 'Chapa is not configured.';
  end if;
  select coalesce(currency, 'ETB') into v_curr from public.settings where id = 1;

  -- Next attempt reference; never reuse the one already sent to Chapa.
  v_n := coalesce(o.chapa_attempts, 0) + 1;
  loop
    v_txref := o.human_id || case when v_n = 1 then '' else '-a' || v_n end;
    exit when o.chapa_tx_ref is null or v_txref <> o.chapa_tx_ref;
    v_n := v_n + 1;
  end loop;

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
      'tx_ref', v_txref,
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

  update public.orders
    set chapa_tx_ref = v_txref, chapa_attempts = v_n
    where id = o.id;

  return jsonb_build_object('checkout_url', v_body->'data'->>'checkout_url');
end $$;
grant execute on function public.chapa_init(uuid, uuid, text) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- get_order_by_token v3 — expose the payment deadline for pending Chapa orders
-- so the storefront can show "reserved until …".
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
-- The sweeper — reconcile, remind, expire (+ admin slip nudge). Every 5 min.
-- ---------------------------------------------------------------------------
create or replace function public.payment_sweeper()
returns void
  language plpgsql security definer set search_path = public as $$
declare
  s          record;
  o          record;
  v_tg_token text;
  v_key      text;
  v_from     text;
  v_track    text;
  v_deadline timestamptz;
  v_text     text;
  v_slips    int;
begin
  select payment_reminder_minutes, payment_expiry_hours, site_url, store_name,
         email_enabled, email_from, telegram_enabled, telegram_admin_chat_id
    into s from public.settings where id = 1;
  if s is null then return; end if;

  select v into v_tg_token from private.secrets where k = 'telegram_bot_token';
  select v into v_key from private.secrets where k = 'resend_api_key';
  v_from := coalesce(nullif(trim(s.email_from), ''), 'Melelo Brands <onboarding@resend.dev>');

  -- ---- Pending Chapa orders: reconcile → expire → remind ------------------
  for o in
    select * from public.orders
    where payment_method = 'chapa'
      and payment_status = 'pending'
      and fulfillment_status = 'pending_approval'
    order by placed_at
    limit 50
  loop
    begin
      -- 1) Reconcile: the customer may have paid without returning to the site.
      if o.chapa_tx_ref is not null and private.chapa_verify_order(o.id) then
        continue;
      end if;

      -- 2) Expire: release the reserved stock and cancel (trigger notifies).
      if coalesce(s.payment_expiry_hours, 0) > 0
         and o.placed_at < now() - make_interval(hours => s.payment_expiry_hours) then
        update public.orders
          set payment_status = 'failed', fulfillment_status = 'cancelled'
          where id = o.id and payment_status = 'pending';
        update public.inventory inv
          set stock_qty = inv.stock_qty + i.qty
          from public.order_items i
          where i.order_id = o.id and i.variant_id = inv.variant_id and i.size = inv.size;
        insert into public.order_events (order_id, status, note)
        values (o.id, 'cancelled', 'Payment window expired — items released');
        continue;
      end if;

      -- 3) Remind once: nudge the customer to finish paying.
      if o.reminder_sent_at is null
         and coalesce(s.payment_reminder_minutes, 0) > 0
         and o.placed_at < now() - make_interval(mins => s.payment_reminder_minutes) then

        v_track := case when coalesce(trim(s.site_url), '') <> ''
          then rtrim(s.site_url, '/') || '/?track=' || o.id || ':' || o.tracking_token
          else null end;
        v_deadline := case when coalesce(s.payment_expiry_hours, 0) > 0
          then o.placed_at + make_interval(hours => s.payment_expiry_hours)
          else null end;
        v_text := 'Your order ' || o.human_id || ' is waiting for payment. Your items are reserved'
          || case when v_deadline is not null
               then ' until ' || to_char(v_deadline, 'Mon DD, HH24:MI') else '' end
          || '. Open your order to complete the Chapa payment.';

        if coalesce(s.telegram_enabled, false) and v_tg_token is not null
           and o.telegram_chat_id is not null then
          perform net.http_post(
            url := 'https://api.telegram.org/bot' || v_tg_token || '/sendMessage',
            body := jsonb_strip_nulls(jsonb_build_object(
              'chat_id', o.telegram_chat_id,
              'text', '⏰ ' || v_text,
              'reply_markup', case when v_track is not null
                then jsonb_build_object('inline_keyboard', jsonb_build_array(jsonb_build_array(
                  jsonb_build_object('text', '💳 Complete payment', 'url', v_track))))
                else null end)),
            headers := jsonb_build_object('Content-Type', 'application/json'));
        end if;

        if coalesce(s.email_enabled, false) and v_key is not null and o.email is not null then
          perform net.http_post(
            url := 'https://api.resend.com/emails',
            body := jsonb_build_object(
              'from', v_from,
              'to', jsonb_build_array(o.email),
              'subject', 'Complete your payment — ' || o.human_id,
              'html', format(
                '<!doctype html><body style="margin:0;background:#09090b;padding:32px 16px;font-family:Arial,Helvetica,sans-serif;">'
                || '<table width="520" cellpadding="0" cellspacing="0" style="max-width:520px;width:100%%;background:#18181b;border:1px solid #27272a;border-radius:16px;padding:32px;margin:0 auto;">'
                || '<tr><td>'
                || '<p style="margin:0 0 4px;color:#f97316;font-size:11px;letter-spacing:2px;text-transform:uppercase;font-weight:bold;">%s</p>'
                || '<h1 style="margin:0 0 12px;color:#ffffff;font-size:24px;">Complete your payment ⏰</h1>'
                || '<p style="margin:0;color:#a1a1aa;font-size:14px;line-height:1.6;">%s</p>'
                || '%s'
                || '<p style="margin:26px 0 0;color:#52525b;font-size:12px;">Order <span style="color:#a1a1aa;font-family:monospace;">%s</span> · %s</p>'
                || '</td></tr></table></body>',
                coalesce(s.store_name, 'Melelo Brands'),
                v_text,
                case when v_track is not null then format(
                  '<a href="%s" style="display:inline-block;margin-top:18px;background:#f97316;color:#000000;text-decoration:none;font-weight:bold;padding:12px 28px;border-radius:999px;">Complete payment</a>',
                  v_track) else '' end,
                o.human_id, coalesce(s.store_name, 'Melelo Brands'))),
            headers := jsonb_build_object(
              'Content-Type', 'application/json',
              'Authorization', 'Bearer ' || v_key));
        end if;

        update public.orders set reminder_sent_at = now() where id = o.id;
      end if;
    exception when others then
      null; -- one bad order must not stop the sweep
    end;
  end loop;

  -- ---- Stale bank-slip reviews: one-time admin nudge -----------------------
  if coalesce(s.telegram_enabled, false) and v_tg_token is not null
     and coalesce(trim(s.telegram_admin_chat_id), '') <> '' then
    select count(*) into v_slips from public.orders
      where payment_method = 'bank_slip' and fulfillment_status = 'pending_approval'
        and reminder_sent_at is null and placed_at < now() - interval '12 hours';
    if v_slips > 0 then
      perform net.http_post(
        url := 'https://api.telegram.org/bot' || v_tg_token || '/sendMessage',
        body := jsonb_build_object(
          'chat_id', s.telegram_admin_chat_id,
          'text', format('🧾 %s bank-slip order(s) have been awaiting review for over 12 hours.', v_slips)
            || case when coalesce(trim(s.site_url), '') <> ''
                 then e'\n' || rtrim(s.site_url, '/') || '/admin/orders' else '' end),
        headers := jsonb_build_object('Content-Type', 'application/json'));
      update public.orders set reminder_sent_at = now()
        where payment_method = 'bank_slip' and fulfillment_status = 'pending_approval'
          and reminder_sent_at is null and placed_at < now() - interval '12 hours';
    end if;
  end if;
exception when others then
  return;
end $$;

-- Schedule every 5 minutes (idempotent).
do $$ begin
  perform cron.unschedule('payment-sweeper');
exception when others then null; end $$;
select cron.schedule('payment-sweeper', '*/5 * * * *', $$select public.payment_sweeper()$$);
