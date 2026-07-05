-- Email notifications (Resend) — order receipt + every fulfillment change.
-- Run after 0006_webp_urls.sql. Safe to re-run.
--
-- Design: every order-lifecycle transition already inserts an order_events row
-- (place_order → 'pending_approval', approve/chapa_confirm → 'confirmed', admin
-- advance → 'packed'/'shipped'/'out_for_delivery'/'delivered', reject/cancel →
-- 'cancelled'). One AFTER INSERT trigger on order_events therefore covers every
-- email moment, no matter which code path made the change.
--
-- Sending uses pg_net (async fire-and-forget): it can never slow down or roll
-- back checkout or an admin action. Failures are visible in net._http_response.
-- The Resend API key lives in private.secrets — same pattern as Chapa.

create extension if not exists pg_net;

-- ---------------------------------------------------------------------------
-- Settings
-- ---------------------------------------------------------------------------
alter table public.settings
  add column if not exists email_enabled boolean not null default false,
  add column if not exists email_from text default 'Melelo Brands <onboarding@resend.dev>',
  add column if not exists site_url text;

-- ---------------------------------------------------------------------------
-- Resend API key management (write-only; never readable through the API)
-- ---------------------------------------------------------------------------
create or replace function public.set_resend_secret(p_key text)
returns void
  language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then
    raise exception 'Admins only.';
  end if;
  if coalesce(trim(p_key), '') = '' then
    delete from private.secrets where k = 'resend_api_key';
  else
    insert into private.secrets (k, v) values ('resend_api_key', trim(p_key))
    on conflict (k) do update set v = excluded.v;
  end if;
end $$;
grant execute on function public.set_resend_secret(text) to authenticated;

create or replace function public.resend_secret_status()
returns jsonb
  language plpgsql stable security definer set search_path = public as $$
declare v_key text;
begin
  if not public.is_admin() then
    raise exception 'Admins only.';
  end if;
  select v into v_key from private.secrets where k = 'resend_api_key';
  if v_key is null then
    return jsonb_build_object('set', false);
  end if;
  return jsonb_build_object('set', true, 'hint', '····' || right(v_key, 4));
end $$;
grant execute on function public.resend_secret_status() to authenticated;

-- ---------------------------------------------------------------------------
-- The trigger: order_events → email(s) via Resend
-- ---------------------------------------------------------------------------
create or replace function public.notify_order_event()
returns trigger
  language plpgsql security definer set search_path = public as $$
declare
  s          record;
  o          public.orders%rowtype;
  v_key      text;
  v_from     text;
  v_track    text := null;
  v_subject  text;
  v_heading  text;
  v_detail   text;
  v_items    text := '';
  v_cta      text := '';
  v_html     text;
begin
  -- Only known lifecycle statuses produce mail.
  if new.status not in ('pending_approval','confirmed','packed','shipped','out_for_delivery','delivered','cancelled') then
    return new;
  end if;

  select email_enabled, email_from, site_url, contact_email, store_name
    into s from public.settings where id = 1;
  if s is null or not coalesce(s.email_enabled, false) then return new; end if;

  select v into v_key from private.secrets where k = 'resend_api_key';
  if v_key is null then return new; end if;

  select * into o from public.orders where id = new.order_id;
  if not found then return new; end if;

  v_from := coalesce(nullif(trim(s.email_from), ''), 'Melelo Brands <onboarding@resend.dev>');
  if coalesce(trim(s.site_url), '') <> '' then
    v_track := rtrim(s.site_url, '/') || '/?track=' || o.id || ':' || o.tracking_token;
  end if;

  -- Copy per status ------------------------------------------------------
  if new.status = 'pending_approval' then
    v_subject := 'Order received — ' || o.human_id;
    v_heading := 'Thanks — we''ve got your order!';
    v_detail  := case when o.payment_method = 'chapa'
      then 'Once your Chapa payment is verified we''ll confirm your order right away.'
      else 'Your bank-transfer slip is being reviewed. We''ll email you the moment payment is approved.' end;
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
    v_detail  := coalesce(new.note, 'If this is unexpected, just reply to this email and we''ll sort it out.');
  end if;

  -- Receipt items + totals (first email only) -----------------------------
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

  -- Customer email (skip silently when the order has none) ----------------
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

  -- New-order alert to the store owner ------------------------------------
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

  return new;
exception when others then
  -- Email must never break checkout or admin actions.
  return new;
end $$;

drop trigger if exists order_events_notify on public.order_events;
create trigger order_events_notify
  after insert on public.order_events
  for each row execute function public.notify_order_event();
