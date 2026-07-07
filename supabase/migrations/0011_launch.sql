-- ===========================================================================
-- 0011 — Launch readiness
--
-- 1. settings.legal — admin-editable Privacy / Terms / Returns text, shown in
--    the storefront's About panel (seeded with sensible stubs to edit).
-- 2. notify_order_event v4 — notification emails/Telegram print amounts in the
--    store currency (settings.currency) instead of a hard-coded "$", matching
--    what Chapa actually charges (chapa_init already uses settings.currency).
--
-- Run this whole file in the Supabase SQL editor. Requires 0001–0010.
-- ===========================================================================

alter table public.settings add column if not exists legal jsonb;

update public.settings set legal = jsonb_build_object(
  'privacy',
    'We collect only what we need to fulfil your order: your name, delivery address, phone number and email. '
    || 'Payment details are handled by our payment providers and never stored on our servers. '
    || 'We use your contact details to send order confirmations and delivery updates, and we never sell or share your data with third parties for marketing.',
  'terms',
    'All orders are subject to availability and confirmation of payment. Prices are shown in the store currency at checkout. '
    || 'An order is confirmed once payment is verified; you will receive a confirmation with a tracking link by email or Telegram. '
    || 'We reserve the right to cancel orders that cannot be fulfilled — any payment received for a cancelled order is refunded in full.',
  'returns',
    'If something is wrong with your order — wrong size, wrong item or a defect — contact us within 7 days of delivery and we will make it right with an exchange or refund. '
    || 'Items must be unworn and in their original condition. Delivery times and fees are shown at checkout before you pay.'
) where id = 1 and legal is null;

-- ---------------------------------------------------------------------------
-- notify_order_event v4 — same as v3 (0010) with amounts in settings.currency.
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
  v_sym      text;
  v_track    text := null;
  v_review   text := null;
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
         telegram_enabled, telegram_admin_chat_id, review_reward_percent, currency
    into s from public.settings where id = 1;
  if s is null then return new; end if;

  select v into v_key from private.secrets where k = 'resend_api_key';
  select v into v_tg_token from private.secrets where k = 'telegram_bot_token';

  select * into o from public.orders where id = new.order_id;
  if not found then return new; end if;

  -- Currency symbol for every amount shown to humans.
  v_sym := case upper(coalesce(s.currency, 'USD'))
    when 'USD' then '$' when 'ETB' then 'Br ' when 'EUR' then '€' when 'GBP' then '£'
    else upper(coalesce(s.currency, 'USD')) || ' ' end;

  v_from := coalesce(nullif(trim(s.email_from), ''), 'Melelo Brands <onboarding@resend.dev>');
  if coalesce(trim(s.site_url), '') <> '' then
    v_track := rtrim(s.site_url, '/') || '/?track=' || o.id || ':' || o.tracking_token;
    v_review := v_track || '&review=1';
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
    v_detail  := 'Your order has been delivered. Thanks for shopping with us — wear it loud.'
      || ' Tell us what you think — rate your items'
      || case when coalesce(s.review_reward_percent, 0) > 0
           then ' and get ' || s.review_reward_percent || '% off your next order.'
           else '.' end;
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
          || '<td style="padding:10px 0;border-bottom:1px solid #27272a;text-align:right;color:#e4e4e7;white-space:nowrap;">%s</td></tr>',
          i.name, i.color, i.size, i.qty, v_sym || to_char(i.unit_price * i.qty, 'FM999990.00')), ''), '')
        into v_items
        from public.order_items i where i.order_id = o.id;

      v_items := '<table width="100%" cellpadding="0" cellspacing="0" style="margin:18px 0 6px;">'
        || v_items
        || format('<tr><td style="padding:10px 0;color:#a1a1aa;">Subtotal</td><td style="text-align:right;color:#e4e4e7;">%s</td></tr>', v_sym || to_char(o.subtotal, 'FM999990.00'))
        || case when o.discount > 0 then format('<tr><td style="padding:2px 0;color:#a1a1aa;">Discount</td><td style="text-align:right;color:#4ade80;">−%s</td></tr>', v_sym || to_char(o.discount, 'FM999990.00')) else '' end
        || format('<tr><td style="padding:2px 0;color:#a1a1aa;">Shipping</td><td style="text-align:right;color:#e4e4e7;">%s</td></tr>', case when o.shipping = 0 then 'Free' else v_sym || to_char(o.shipping, 'FM999990.00') end)
        || format('<tr><td style="padding:8px 0;color:#ffffff;font-weight:bold;">Total</td><td style="text-align:right;color:#ffffff;font-weight:bold;font-size:18px;">%s</td></tr>', v_sym || to_char(o.total, 'FM999990.00'))
        || '</table>';
    end if;

    if v_track is not null then
      v_cta := format(
        '<a href="%s" style="display:inline-block;margin-top:18px;background:#f97316;color:#000000;text-decoration:none;font-weight:bold;padding:12px 28px;border-radius:999px;">Track your order</a>',
        v_track);
      if new.status = 'delivered' then
        v_cta := v_cta || format(
          '<a href="%s" style="display:inline-block;margin-top:18px;margin-left:10px;background:#27272a;color:#f97316;text-decoration:none;font-weight:bold;padding:12px 28px;border-radius:999px;border:1px solid #f97316;">⭐ Rate your items</a>',
          v_review);
      end if;
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
          'subject', format('New order %s — %s', o.human_id, v_sym || to_char(o.total, 'FM999990.00')),
          'html', format(
            '<!doctype html><body style="margin:0;background:#09090b;padding:32px 16px;font-family:Arial,Helvetica,sans-serif;">'
            || '<table width="520" cellpadding="0" cellspacing="0" style="max-width:520px;width:100%%;background:#18181b;border:1px solid #27272a;border-radius:16px;padding:32px;margin:0 auto;">'
            || '<tr><td>'
            || '<h1 style="margin:0 0 12px;color:#ffffff;font-size:20px;">New order %s</h1>'
            || '<p style="margin:0;color:#a1a1aa;font-size:14px;line-height:1.7;">%s<br>%s · %s payment<br><strong style="color:#ffffff;">Total %s</strong></p>'
            || '%s'
            || '</td></tr></table></body>',
            o.human_id,
            coalesce(o.ship_address, '—'),
            coalesce(o.phone, 'no phone'),
            case when o.payment_method = 'chapa' then 'Chapa' else 'bank-slip' end,
            v_sym || to_char(o.total, 'FM999990.00'),
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
      v_tg_kb := jsonb_build_object('inline_keyboard',
        case when new.status = 'delivered'
          then jsonb_build_array(
            jsonb_build_array(jsonb_build_object('text', '⭐ Rate your items', 'url', v_review)),
            jsonb_build_array(jsonb_build_object('text', '📦 Track order', 'url', v_track)))
          else jsonb_build_array(jsonb_build_array(
            jsonb_build_object('text', '📦 Track order', 'url', v_track)))
        end);
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
          'text', format(e'🛒 New order %s — %s\n%s\n%s · %s payment',
            o.human_id, v_sym || to_char(o.total, 'FM999990.00'),
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
