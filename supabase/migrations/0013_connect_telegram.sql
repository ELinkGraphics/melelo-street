-- ===========================================================================
-- 0013 — Required contact details + connect website orders to Telegram
--
-- 1. place_order v5 — phone AND email are now required for every order (both
--    channels need them: email receipts + the Telegram connect flow below).
-- 2. Telegram deep-link connect: website buyers tap
--    https://t.me/<bot>?start=t<tracking_token> (from the success screen,
--    tracking panel or the order-received email). The bot receives
--    "/start t<token>", matches the order and saves the chat id — from then on
--    the existing notify trigger DMs them like any Telegram buyer.
--    (Bots cannot message people by phone number — Telegram forbids it; the
--    buyer must press Start once, which this flow reduces to a single tap.)
-- 3. get_order_by_token v5 — exposes telegram_linked + the bot username so
--    the storefront can show/hide the connect button.
-- 4. notify_order_event v6 — the "order received" email carries a
--    "💬 Get updates on Telegram" button for unlinked orders.
--
-- Run this whole file in the Supabase SQL editor. Requires 0001–0012.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- place_order v5 — same signature as v4; phone + email now required.
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
  if length(regexp_replace(coalesce(p_phone, ''), '\D', '', 'g')) < 7 then
    raise exception 'A valid phone number is required.';
  end if;
  if coalesce(trim(p_email), '') = '' or trim(p_email) !~ '^\S+@\S+\.\S+$' then
    raise exception 'A valid email address is required.';
  end if;
  if v_method = 'bank_slip' and coalesce(trim(p_slip_path), '') = '' then
    raise exception 'A payment slip is required.';
  end if;
  if v_method = 'chapa' and not exists (select 1 from public.settings where id = 1 and chapa_enabled) then
    raise exception 'Chapa payments are not enabled.';
  end if;

  v_human := 'MLB-' || to_char(now(), 'YYYYMMDD') || '-' || lpad(floor(random() * 1000000)::text, 6, '0');

  insert into public.orders
    (human_id, email, phone, ship_address, subtotal, shipping, total, payment_method, slip_url)
  values
    (v_human, trim(p_email), trim(p_phone),
     trim(p_name) || ', ' || trim(p_address), 0, 0, 0, v_method,
     nullif(trim(p_slip_path), ''))
  returning id, tracking_token into v_order_id, v_token;

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
      raise exception 'This code requires a minimum subtotal of %.', v_disc.min_subtotal;
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
-- telegram_poll v3 — "/start t<token>" links a website order to this chat.
-- Also prints /orders amounts in the store currency.
-- ---------------------------------------------------------------------------
create or replace function public.telegram_poll()
returns void
  language plpgsql security definer set search_path = public as $$
declare
  s          record;
  v_offset   bigint;
  resp       jsonb;
  upd        jsonb;
  v_chat     bigint;
  v_text     text;
  v_from     jsonb;
  v_button   jsonb;
  v_list     text;
  v_sym      text;
  v_payload  text;
  v_tok      uuid;
  v_hid      text;
  v_oid      uuid;
  v_linked   boolean;
  o          record;
begin
  select telegram_enabled, site_url, currency into s from public.settings where id = 1;
  if s is null or not coalesce(s.telegram_enabled, false) then return; end if;
  if not exists (select 1 from private.secrets where k = 'telegram_bot_token') then return; end if;

  v_sym := case upper(coalesce(s.currency, 'USD'))
    when 'USD' then '$' when 'ETB' then 'Br ' when 'EUR' then '€' when 'GBP' then '£'
    else upper(coalesce(s.currency, 'USD')) || ' ' end;

  select last_update_id into v_offset from private.telegram_state where id = 1;
  resp := private.tg_api('getUpdates', jsonb_build_object(
    'offset', coalesce(v_offset, 0) + 1,
    'timeout', 0,
    'allowed_updates', jsonb_build_array('message')));
  if resp is null or not coalesce((resp->>'ok')::boolean, false) then return; end if;

  for upd in select * from jsonb_array_elements(resp->'result') loop
    update private.telegram_state
      set last_update_id = greatest(last_update_id, (upd->>'update_id')::bigint)
      where id = 1;

    v_chat := (upd->'message'->'chat'->>'id')::bigint;
    v_text := upd->'message'->>'text';
    v_from := upd->'message'->'from';
    if v_chat is null or v_text is null then continue; end if;

    if v_text like '/start%' then
      -- Deep-link payload: "t" + tracking_token hex → connect that order here.
      v_linked := false;
      v_payload := nullif(trim(substr(v_text, 7)), '');
      if v_payload ~ '^t[0-9a-fA-F]{32}$' then
        begin
          v_tok := (substr(v_payload, 2, 8) || '-' || substr(v_payload, 10, 4) || '-'
                 || substr(v_payload, 14, 4) || '-' || substr(v_payload, 18, 4) || '-'
                 || substr(v_payload, 22, 12))::uuid;
          update public.orders
            set telegram_chat_id = v_chat,
                telegram_username = v_from->>'username'
            where tracking_token = v_tok
            returning human_id, id into v_hid, v_oid;
          if found then
            v_linked := true;
            perform private.tg_api('sendMessage', jsonb_strip_nulls(jsonb_build_object(
              'chat_id', v_chat,
              'text', '✅ Connected! Updates for order ' || v_hid || ' will arrive in this chat.'
                || e'\n\nCommands:\n/orders — your recent orders',
              'reply_markup', case when coalesce(trim(s.site_url), '') <> ''
                then jsonb_build_object('inline_keyboard', jsonb_build_array(jsonb_build_array(
                  jsonb_build_object('text', '📦 Track order', 'url',
                    rtrim(s.site_url, '/') || '/?track=' || v_oid || ':' || v_tok))))
                else null end)));
          end if;
        exception when others then null; end;
      end if;

      if not v_linked then
        -- Plain /start: welcome + shop button.
        if coalesce(trim(s.site_url), '') <> '' then
          v_button := jsonb_build_object('inline_keyboard', jsonb_build_array(jsonb_build_array(
            case when s.site_url like 'https://%'
              then jsonb_build_object('text', '🛍 Open shop', 'web_app', jsonb_build_object('url', rtrim(s.site_url, '/')))
              else jsonb_build_object('text', '🛍 Open shop', 'url', rtrim(s.site_url, '/'))
            end)));
        else
          v_button := null;
        end if;
        perform private.tg_api('sendMessage', jsonb_strip_nulls(jsonb_build_object(
          'chat_id', v_chat,
          'text', e'Welcome to Melelo Brands! 👋\nBrowse the collection and order right here — your order updates will arrive in this chat.\n\nCommands:\n/orders — your recent orders\n/id — your chat id',
          'reply_markup', v_button)));
      end if;

    elsif v_text = '/id' then
      perform private.tg_api('sendMessage', jsonb_build_object(
        'chat_id', v_chat, 'text', 'Your chat id: ' || v_chat));

    elsif v_text = '/orders' then
      v_list := '';
      for o in
        select human_id, fulfillment_status, total, id, tracking_token
        from public.orders where telegram_chat_id = v_chat
        order by placed_at desc limit 5
      loop
        v_list := v_list || format(e'• %s — %s — %s\n', o.human_id,
          replace(o.fulfillment_status::text, '_', ' '), v_sym || to_char(o.total, 'FM999990.00'));
        if coalesce(trim(s.site_url), '') <> '' then
          v_list := v_list || rtrim(s.site_url, '/') || '/?track=' || o.id || ':' || o.tracking_token || e'\n';
        end if;
        v_list := v_list || e'\n';
      end loop;
      perform private.tg_api('sendMessage', jsonb_build_object(
        'chat_id', v_chat,
        'text', case when v_list = ''
          then 'No orders are linked to this chat yet. Order through the shop button and they''ll show up here.'
          else e'Your recent orders:\n\n' || v_list end));

    else
      insert into public.telegram_messages (chat_id, username, first_name, text, direction)
      values (v_chat, v_from->>'username', coalesce(v_from->>'first_name', ''), v_text, 'in');
      perform private.tg_api('sendMessage', jsonb_build_object(
        'chat_id', v_chat,
        'text', 'Thanks! Your message reached the Melelo team — we''ll reply right here.'));
    end if;
  end loop;
exception when others then
  return; -- polling must never raise into cron logs as failures cascade
end $$;

-- ---------------------------------------------------------------------------
-- get_order_by_token v5 — + telegram_linked / telegram_bot for the connect UI.
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
    'telegram_linked', o.telegram_chat_id is not null,
    'telegram_bot', (
      select case when coalesce(st.telegram_enabled, false)
        then nullif(trim(st.telegram_bot_username), '') else null end
      from public.settings st where st.id = 1
    ),
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
    'reward_percent', (select coalesce(st.review_reward_percent, 0) from public.settings st where st.id = 1),
    'items', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'product_id', i.product_id, 'name', i.name, 'image', i.image, 'size', i.size,
        'color', i.color, 'unit_price', i.unit_price, 'qty', i.qty)), '[]'::jsonb)
      from public.order_items i where i.order_id = o.id
    ),
    'reviews', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'product_id', r.product_id, 'rating', r.rating, 'body', r.body,
        'photos', r.photos, 'status', r.status, 'reward_code', r.reward_code,
        'reviewer_name', r.reviewer_name)), '[]'::jsonb)
      from public.reviews r where r.order_id = o.id
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
-- notify_order_event v6 — "order received" email offers the Telegram connect
-- button when the order isn't linked yet. (Everything else as v5 / 0012.)
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
  v_receipt  text := null;
  v_connect  text := null;
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
         telegram_enabled, telegram_admin_chat_id, telegram_bot_username,
         review_reward_percent, currency
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
    v_receipt := rtrim(s.site_url, '/') || '/?receipt=' || o.id || ':' || o.tracking_token;
  end if;
  if coalesce(s.telegram_enabled, false) and coalesce(trim(s.telegram_bot_username), '') <> ''
     and o.telegram_chat_id is null then
    v_connect := 'https://t.me/' || trim(s.telegram_bot_username)
      || '?start=t' || replace(o.tracking_token::text, '-', '');
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
    v_detail  := 'Your order is confirmed and heading to packing. Your receipt is below — you can also download it any time.';
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
    -- Itemized table: on the initial receipt AND on payment confirmation.
    if new.status in ('pending_approval', 'confirmed') then
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

      -- Payment line on the confirmed receipt.
      if new.status = 'confirmed' then
        v_items := v_items || format(
          '<p style="margin:14px 0 0;color:#a1a1aa;font-size:13px;">Paid via %s · Ref <span style="font-family:monospace;color:#e4e4e7;">%s</span> · %s</p>',
          case when o.payment_method = 'chapa' then 'Chapa' else 'bank transfer' end,
          coalesce(o.chapa_tx_ref, o.human_id),
          to_char(coalesce(o.approved_at, now()), 'Mon DD, YYYY'));
      end if;
    end if;

    if v_track is not null then
      v_cta := format(
        '<a href="%s" style="display:inline-block;margin-top:18px;background:#f97316;color:#000000;text-decoration:none;font-weight:bold;padding:12px 28px;border-radius:999px;">Track your order</a>',
        v_track);
      if new.status = 'confirmed' and v_receipt is not null then
        v_cta := v_cta || format(
          '<a href="%s" style="display:inline-block;margin-top:18px;margin-left:10px;background:#27272a;color:#f97316;text-decoration:none;font-weight:bold;padding:12px 28px;border-radius:999px;border:1px solid #f97316;">🧾 Download receipt</a>',
          v_receipt);
      end if;
      if new.status = 'delivered' then
        v_cta := v_cta || format(
          '<a href="%s" style="display:inline-block;margin-top:18px;margin-left:10px;background:#27272a;color:#f97316;text-decoration:none;font-weight:bold;padding:12px 28px;border-radius:999px;border:1px solid #f97316;">⭐ Rate your items</a>',
          v_review);
      end if;
      if new.status = 'pending_approval' and v_connect is not null then
        v_cta := v_cta || format(
          '<a href="%s" style="display:inline-block;margin-top:18px;margin-left:10px;background:#27272a;color:#38bdf8;text-decoration:none;font-weight:bold;padding:12px 28px;border-radius:999px;border:1px solid #38bdf8;">💬 Get updates on Telegram</a>',
          v_connect);
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
        when new.status = 'confirmed'
          then jsonb_build_array(
            jsonb_build_array(jsonb_build_object('text', '🧾 Receipt', 'url', v_receipt)),
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
