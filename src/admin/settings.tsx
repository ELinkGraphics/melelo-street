import React, { useEffect, useState } from 'react';
import { Save, Loader2, Store, Landmark, Truck, CheckCircle2, Wallet, KeyRound, Mail, Send, Star, ScrollText } from 'lucide-react';
import { requireSupabase } from '../lib/supabase';
import { PageScaffold } from './ui';

type SettingsForm = {
  store_name: string;
  contact_email: string;
  contact_phone: string;
  bank: string;
  bank_name: string;
  bank_account: string;
  shipping_flat: number;
  free_ship_threshold: string; // keep as string for optional field UX
  currency: string;
  chapa_enabled: boolean;
  email_enabled: boolean;
  email_from: string;
  site_url: string;
  telegram_enabled: boolean;
  telegram_bot_username: string;
  telegram_admin_chat_id: string;
  payment_reminder_minutes: number;
  payment_expiry_hours: number;
  review_reward_percent: number;
  review_reminder_days: number;
  legal_privacy: string;
  legal_terms: string;
  legal_returns: string;
  social_instagram: string;
  social_twitter: string;
  social_tiktok: string;
};

// The seed data used '#' placeholders — treat them as empty.
const realUrl = (v: unknown) => (typeof v === 'string' && v.trim() && v.trim() !== '#') ? v.trim() : '';

// Horizontal tab layout — one settings area on screen at a time.
type SettingsTab = 'store' | 'payments' | 'shipping' | 'email' | 'telegram' | 'reviews' | 'legal';
const TABS: { key: SettingsTab; label: string; icon: React.ElementType }[] = [
  { key: 'store', label: 'Store', icon: Store },
  { key: 'payments', label: 'Payments', icon: Wallet },
  { key: 'shipping', label: 'Shipping', icon: Truck },
  { key: 'email', label: 'Email', icon: Mail },
  { key: 'telegram', label: 'Telegram', icon: Send },
  { key: 'reviews', label: 'Reviews', icon: Star },
  { key: 'legal', label: 'Legal', icon: ScrollText },
];

const input = 'w-full bg-white/5 border border-white/15 rounded-xl px-3 py-2.5 text-sm outline-none focus:border-orange-500 transition-colors placeholder:text-zinc-500';

export function SettingsPage() {
  const [form, setForm] = useState<SettingsForm | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [tab, setTab] = useState<SettingsTab>('store');

  useEffect(() => {
    requireSupabase().from('settings').select('*').eq('id', 1).maybeSingle().then(({ data, error }) => {
      if (error) { setErr(error.message); return; }
      const s = data as any;
      setForm({
        store_name: s?.store_name ?? 'Melelo Brands',
        contact_email: s?.contact_email ?? '',
        contact_phone: s?.contact_phone ?? '',
        bank: s?.bank_details?.bank ?? '',
        bank_name: s?.bank_details?.name ?? '',
        bank_account: s?.bank_details?.account ?? '',
        shipping_flat: Number(s?.shipping_flat ?? 0),
        free_ship_threshold: s?.free_ship_threshold != null ? String(s.free_ship_threshold) : '',
        currency: s?.currency ?? 'USD',
        chapa_enabled: Boolean(s?.chapa_enabled),
        email_enabled: Boolean(s?.email_enabled),
        email_from: s?.email_from ?? 'Melelo Brands <onboarding@resend.dev>',
        // Prefill with this deployment's own origin so email links work out of the box.
        site_url: s?.site_url ?? window.location.origin,
        telegram_enabled: Boolean(s?.telegram_enabled),
        telegram_bot_username: s?.telegram_bot_username ?? '',
        telegram_admin_chat_id: s?.telegram_admin_chat_id ?? '',
        payment_reminder_minutes: Number(s?.payment_reminder_minutes ?? 30),
        payment_expiry_hours: Number(s?.payment_expiry_hours ?? 24),
        review_reward_percent: Number(s?.review_reward_percent ?? 10),
        review_reminder_days: Number(s?.review_reminder_days ?? 3),
        legal_privacy: s?.legal?.privacy ?? '',
        legal_terms: s?.legal?.terms ?? '',
        legal_returns: s?.legal?.returns ?? '',
        social_instagram: realUrl(s?.socials?.instagram),
        social_twitter: realUrl(s?.socials?.twitter),
        social_tiktok: realUrl(s?.socials?.tiktok),
      });
    });
  }, []);

  const patch = (p: Partial<SettingsForm>) => { setSaved(false); setForm(f => f ? { ...f, ...p } : f); };

  // The Chapa switch persists immediately (optimistic, reverts on failure) —
  // users expect a toggle to apply on click, not after a separate Save.
  const [togglingChapa, setTogglingChapa] = useState(false);
  const toggleChapa = async () => {
    if (!form || togglingChapa) return;
    const next = !form.chapa_enabled;
    setTogglingChapa(true); setErr(null);
    setForm(f => f ? { ...f, chapa_enabled: next } : f);
    const { error } = await requireSupabase().from('settings').update({ chapa_enabled: next }).eq('id', 1);
    if (error) {
      setForm(f => f ? { ...f, chapa_enabled: !next } : f); // revert
      setErr(`Could not update the Chapa toggle: ${error.message}`);
    }
    setTogglingChapa(false);
  };

  // Telegram switch — same instant-save pattern as Chapa.
  const [togglingTg, setTogglingTg] = useState(false);
  const toggleTelegram = async () => {
    if (!form || togglingTg) return;
    const next = !form.telegram_enabled;
    setTogglingTg(true); setErr(null);
    setForm(f => f ? { ...f, telegram_enabled: next } : f);
    const { error } = await requireSupabase().from('settings').update({ telegram_enabled: next }).eq('id', 1);
    if (error) {
      setForm(f => f ? { ...f, telegram_enabled: !next } : f); // revert
      setErr(`Could not update the Telegram toggle: ${error.message}`);
    }
    setTogglingTg(false);
  };

  // Email notifications switch — same instant-save pattern as Chapa.
  const [togglingEmail, setTogglingEmail] = useState(false);
  const toggleEmail = async () => {
    if (!form || togglingEmail) return;
    const next = !form.email_enabled;
    setTogglingEmail(true); setErr(null);
    setForm(f => f ? { ...f, email_enabled: next } : f);
    const { error } = await requireSupabase().from('settings').update({ email_enabled: next }).eq('id', 1);
    if (error) {
      setForm(f => f ? { ...f, email_enabled: !next } : f); // revert
      setErr(`Could not update the email toggle: ${error.message}`);
    }
    setTogglingEmail(false);
  };

  const save = async () => {
    if (!form) return;
    setBusy(true); setErr(null); setSaved(false);
    try {
      const { error } = await requireSupabase().from('settings').upsert({
        id: 1,
        store_name: form.store_name.trim() || 'Melelo Brands',
        contact_email: form.contact_email.trim() || null,
        contact_phone: form.contact_phone.trim() || null,
        bank_details: { bank: form.bank.trim(), name: form.bank_name.trim(), account: form.bank_account.trim() },
        shipping_flat: form.shipping_flat,
        free_ship_threshold: form.free_ship_threshold.trim() === '' ? null : Number(form.free_ship_threshold),
        currency: form.currency.trim() || 'USD',
        chapa_enabled: form.chapa_enabled,
        email_enabled: form.email_enabled,
        email_from: form.email_from.trim() || null,
        site_url: form.site_url.trim() || null,
        telegram_enabled: form.telegram_enabled,
        telegram_bot_username: form.telegram_bot_username.trim().replace(/^@/, '') || null,
        telegram_admin_chat_id: form.telegram_admin_chat_id.trim() || null,
        payment_reminder_minutes: Math.max(0, Math.round(form.payment_reminder_minutes) || 0),
        payment_expiry_hours: Math.max(0, Math.round(form.payment_expiry_hours) || 0),
        review_reward_percent: Math.min(100, Math.max(0, Math.round(form.review_reward_percent) || 0)),
        review_reminder_days: Math.max(0, Math.round(form.review_reminder_days) || 0),
        legal: {
          privacy: form.legal_privacy.trim(),
          terms: form.legal_terms.trim(),
          returns: form.legal_returns.trim(),
        },
        socials: {
          instagram: form.social_instagram.trim(),
          twitter: form.social_twitter.trim(),
          tiktok: form.social_tiktok.trim(),
        },
      });
      if (error) throw error;
      setSaved(true);
    } catch (e: any) { setErr(e.message ?? String(e)); }
    finally { setBusy(false); }
  };

  return (
    <PageScaffold
      title="Settings"
      subtitle="Store profile, bank details & shipping — changes apply to checkout immediately"
      actions={
        <button onClick={save} disabled={busy || !form}
          className="inline-flex items-center gap-2 bg-orange-500 text-black font-bold text-sm px-5 py-2.5 rounded-xl hover:bg-orange-400 transition-colors disabled:opacity-50">
          {busy ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />} Save
        </button>
      }
    >
      {err && <div className="mb-4 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">{err}</div>}
      {saved && (
        <div className="mb-4 rounded-xl border border-green-500/30 bg-green-500/10 px-4 py-3 text-sm text-green-300 flex items-center gap-2">
          <CheckCircle2 size={16} /> Saved — the storefront checkout now uses these values.
        </div>
      )}
      {!form ? (
        <p className="text-sm text-zinc-500">Loading…</p>
      ) : (
        <div className="max-w-3xl">
          {/* Tab bar — a green dot marks channels that are switched on */}
          <div className="flex gap-2 mb-5 overflow-x-auto pb-1">
            {TABS.map(t => {
              const on = t.key === 'payments' ? form.chapa_enabled
                : t.key === 'email' ? form.email_enabled
                : t.key === 'telegram' ? form.telegram_enabled
                : null;
              return (
                <button
                  key={t.key}
                  onClick={() => setTab(t.key)}
                  className={`shrink-0 inline-flex items-center gap-2 px-4 py-2 rounded-full text-sm font-semibold transition-colors ${
                    tab === t.key ? 'bg-orange-500 text-black' : 'bg-white/5 text-zinc-300 hover:bg-white/10'
                  }`}
                >
                  <t.icon size={14} />
                  {t.label}
                  {on != null && <span className={`w-1.5 h-1.5 rounded-full ${on ? 'bg-green-400' : tab === t.key ? 'bg-black/30' : 'bg-zinc-600'}`} />}
                </button>
              );
            })}
          </div>

          <div className="space-y-4">
          {/* Store profile */}
          {tab === 'store' && (
          <section className="rounded-2xl border border-white/10 bg-white/[0.03] p-5 space-y-3">
            <h3 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-zinc-400"><Store size={15} /> Store</h3>
            <div>
              <label className="block text-xs text-zinc-500 mb-1.5">Store name</label>
              <input className={input} value={form.store_name} onChange={e => patch({ store_name: e.target.value })} />
            </div>
            <div>
              <label className="block text-xs text-zinc-500 mb-1.5">Contact email</label>
              <input className={input} type="email" value={form.contact_email} onChange={e => patch({ contact_email: e.target.value })} />
            </div>
            <div>
              <label className="block text-xs text-zinc-500 mb-1.5">Contact phone</label>
              <input className={input} value={form.contact_phone} onChange={e => patch({ contact_phone: e.target.value })} />
            </div>
            <div>
              <label className="block text-xs text-zinc-500 mb-1.5">Currency code</label>
              <input className={input} value={form.currency} onChange={e => patch({ currency: e.target.value.toUpperCase() })} maxLength={3} />
              <p className="text-[11px] text-zinc-600 mt-1">Storefront prices, emails and Chapa charges all follow this (e.g. ETB, USD).</p>
            </div>
            <div>
              <label className="block text-xs text-zinc-500 mb-1.5">Instagram URL</label>
              <input className={input} placeholder="https://instagram.com/…" value={form.social_instagram} onChange={e => patch({ social_instagram: e.target.value })} />
            </div>
            <div>
              <label className="block text-xs text-zinc-500 mb-1.5">Twitter / X URL</label>
              <input className={input} placeholder="https://x.com/…" value={form.social_twitter} onChange={e => patch({ social_twitter: e.target.value })} />
            </div>
            <div>
              <label className="block text-xs text-zinc-500 mb-1.5">TikTok URL</label>
              <input className={input} placeholder="https://tiktok.com/@…" value={form.social_tiktok} onChange={e => patch({ social_tiktok: e.target.value })} />
              <p className="text-[11px] text-zinc-600 mt-1">Shown in the storefront's About panel; leave empty to hide a link.</p>
            </div>
          </section>
          )}

          {/* Bank details */}
          {tab === 'payments' && (
          <section className="rounded-2xl border border-white/10 bg-white/[0.03] p-5 space-y-3">
            <h3 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-zinc-400"><Landmark size={15} /> Bank transfer</h3>
            <p className="text-xs text-zinc-500">Shown to customers at checkout for slip payments.</p>
            <div>
              <label className="block text-xs text-zinc-500 mb-1.5">Bank</label>
              <input className={input} value={form.bank} onChange={e => patch({ bank: e.target.value })} />
            </div>
            <div>
              <label className="block text-xs text-zinc-500 mb-1.5">Account name</label>
              <input className={input} value={form.bank_name} onChange={e => patch({ bank_name: e.target.value })} />
            </div>
            <div>
              <label className="block text-xs text-zinc-500 mb-1.5">Account number</label>
              <input className={input} value={form.bank_account} onChange={e => patch({ bank_account: e.target.value })} />
            </div>
          </section>
          )}

          {/* Shipping */}
          {tab === 'shipping' && (
          <section className="rounded-2xl border border-white/10 bg-white/[0.03] p-5 space-y-3">
            <h3 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-zinc-400"><Truck size={15} /> Shipping</h3>
            <p className="text-xs text-zinc-500">Order totals are computed server-side from these values.</p>
            <div>
              <label className="block text-xs text-zinc-500 mb-1.5">Flat rate ($)</label>
              <input className={input} type="number" min={0} step="0.5" value={form.shipping_flat}
                onChange={e => patch({ shipping_flat: Number(e.target.value) })} />
            </div>
            <div>
              <label className="block text-xs text-zinc-500 mb-1.5">Free shipping over ($) — leave empty to disable</label>
              <input className={input} type="number" min={0} step="1" value={form.free_ship_threshold}
                placeholder="e.g. 200" onChange={e => patch({ free_ship_threshold: e.target.value })} />
            </div>
          </section>
          )}

          {/* Chapa payments */}
          {tab === 'payments' && (
          <section className="rounded-2xl border border-white/10 bg-white/[0.03] p-5 space-y-4">
            <div className="flex items-center justify-between gap-4">
              <div>
                <h3 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-zinc-400"><Wallet size={15} /> Chapa payments</h3>
                <p className="text-xs text-zinc-500 mt-1">
                  When on, checkout offers Chapa (cards, telebirr, mobile money). When off, it shows "Coming soon".
                  The switch applies instantly.
                </p>
              </div>
              {/* Toggle — self-saving */}
              <button
                type="button"
                role="switch"
                aria-checked={form.chapa_enabled}
                disabled={togglingChapa}
                onClick={toggleChapa}
                className={`relative shrink-0 w-14 h-8 rounded-full transition-colors disabled:opacity-60 ${form.chapa_enabled ? 'bg-green-500' : 'bg-white/15'}`}
              >
                <span className={`absolute top-1 w-6 h-6 rounded-full bg-white shadow transition-all ${form.chapa_enabled ? 'left-7' : 'left-1'}`} />
              </button>
            </div>
            <div className="flex items-center gap-2 text-xs">
              <span className={`font-semibold uppercase tracking-wider px-2.5 py-1 rounded-full ${form.chapa_enabled ? 'bg-green-500/15 text-green-400' : 'bg-white/10 text-zinc-400'}`}>
                {form.chapa_enabled ? 'Active at checkout' : 'Coming soon at checkout'}
              </span>
            </div>
            <div className="grid sm:grid-cols-2 gap-3 max-w-3xl">
              <div>
                <label className="block text-xs text-zinc-500 mb-1.5">Payment reminder after (minutes, 0 = off)</label>
                <input className={input} type="number" min={0} step={5} value={form.payment_reminder_minutes}
                  onChange={e => patch({ payment_reminder_minutes: Number(e.target.value) })} />
                <p className="text-[11px] text-zinc-600 mt-1">Unpaid Chapa orders get a "complete your payment" nudge (Telegram + email) once.</p>
              </div>
              <div>
                <label className="block text-xs text-zinc-500 mb-1.5">Cancel unpaid after (hours, 0 = never)</label>
                <input className={input} type="number" min={0} step={1} value={form.payment_expiry_hours}
                  onChange={e => patch({ payment_expiry_hours: Number(e.target.value) })} />
                <p className="text-[11px] text-zinc-600 mt-1">Expired orders are cancelled automatically and their reserved stock is released.</p>
              </div>
            </div>
            <ChapaKeyManager />
          </section>
          )}

          {/* Email notifications (Resend) */}
          {tab === 'email' && (
          <section className="rounded-2xl border border-white/10 bg-white/[0.03] p-5 space-y-4">
            <div className="flex items-center justify-between gap-4">
              <div>
                <h3 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-zinc-400"><Mail size={15} /> Email notifications</h3>
                <p className="text-xs text-zinc-500 mt-1">
                  Order receipt at purchase plus an email on every tracking change. New-order alerts go to the
                  <span className="text-zinc-300"> contact email</span> in the Store card. The switch applies instantly.
                </p>
              </div>
              {/* Toggle — self-saving */}
              <button
                type="button"
                role="switch"
                aria-checked={form.email_enabled}
                disabled={togglingEmail}
                onClick={toggleEmail}
                className={`relative shrink-0 w-14 h-8 rounded-full transition-colors disabled:opacity-60 ${form.email_enabled ? 'bg-green-500' : 'bg-white/15'}`}
              >
                <span className={`absolute top-1 w-6 h-6 rounded-full bg-white shadow transition-all ${form.email_enabled ? 'left-7' : 'left-1'}`} />
              </button>
            </div>
            <div className="flex items-center gap-2 text-xs">
              <span className={`font-semibold uppercase tracking-wider px-2.5 py-1 rounded-full ${form.email_enabled ? 'bg-green-500/15 text-green-400' : 'bg-white/10 text-zinc-400'}`}>
                {form.email_enabled ? 'Sending' : 'Off'}
              </span>
            </div>
            <div className="grid sm:grid-cols-2 gap-3 max-w-3xl">
              <div>
                <label className="block text-xs text-zinc-500 mb-1.5">From address (save with Save)</label>
                <input className={input} value={form.email_from} placeholder="Melelo Brands <orders@yourdomain.com>"
                  onChange={e => patch({ email_from: e.target.value })} />
                <p className="text-[11px] text-zinc-600 mt-1">Custom senders need a verified domain in Resend; until then use onboarding@resend.dev.</p>
              </div>
              <div>
                <label className="block text-xs text-zinc-500 mb-1.5">Site URL (used for tracking links in emails)</label>
                <input className={input} value={form.site_url} placeholder="https://your-store-url"
                  onChange={e => patch({ site_url: e.target.value })} />
              </div>
            </div>
            <ResendKeyManager />
          </section>
          )}

          {/* Telegram bot & Mini App */}
          {tab === 'telegram' && (
          <section className="rounded-2xl border border-white/10 bg-white/[0.03] p-5 space-y-4">
            <div className="flex items-center justify-between gap-4">
              <div>
                <h3 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-zinc-400"><Send size={15} /> Telegram</h3>
                <p className="text-xs text-zinc-500 mt-1">
                  Mini App shop, order updates as bot DMs, customer messages in the Messages page,
                  and a new-order alert to your own chat. The switch applies instantly.
                </p>
              </div>
              {/* Toggle — self-saving */}
              <button
                type="button"
                role="switch"
                aria-checked={form.telegram_enabled}
                disabled={togglingTg}
                onClick={toggleTelegram}
                className={`relative shrink-0 w-14 h-8 rounded-full transition-colors disabled:opacity-60 ${form.telegram_enabled ? 'bg-green-500' : 'bg-white/15'}`}
              >
                <span className={`absolute top-1 w-6 h-6 rounded-full bg-white shadow transition-all ${form.telegram_enabled ? 'left-7' : 'left-1'}`} />
              </button>
            </div>
            <div className="flex items-center gap-2 text-xs">
              <span className={`font-semibold uppercase tracking-wider px-2.5 py-1 rounded-full ${form.telegram_enabled ? 'bg-green-500/15 text-green-400' : 'bg-white/10 text-zinc-400'}`}>
                {form.telegram_enabled ? 'Bot active' : 'Off'}
              </span>
            </div>
            <div className="grid sm:grid-cols-2 gap-3 max-w-3xl">
              <div>
                <label className="block text-xs text-zinc-500 mb-1.5">Bot username (save with Save)</label>
                <input className={input} value={form.telegram_bot_username} placeholder="MeleloShopBot"
                  onChange={e => patch({ telegram_bot_username: e.target.value })} />
              </div>
              <div>
                <label className="block text-xs text-zinc-500 mb-1.5">Your admin chat id (new-order alerts)</label>
                <input className={input} value={form.telegram_admin_chat_id} placeholder="send /id to the bot to get it"
                  onChange={e => patch({ telegram_admin_chat_id: e.target.value })} />
              </div>
            </div>
            <TelegramTokenManager />
            <div className="border-t border-white/10 pt-4">
              <p className="text-xs font-semibold uppercase tracking-wider text-zinc-400 mb-2">Setup checklist</p>
              <ol className="text-xs text-zinc-400 space-y-1.5 list-decimal list-inside">
                <li>In Telegram, message <span className="text-zinc-200">@BotFather</span> → <span className="font-mono">/newbot</span> → copy the token here.</li>
                <li>BotFather → <span className="font-mono">/mybots</span> → your bot → <span className="text-zinc-200">Bot Settings → Menu Button</span> → set it to your store URL (the Site URL above).</li>
                <li>Toggle Telegram on, then send <span className="font-mono">/start</span> to your bot — the welcome + shop button should arrive within ~10s.</li>
                <li>Send <span className="font-mono">/id</span> to the bot and paste the number into "admin chat id" for new-order alerts.</li>
                <li>Never configure a webhook for this bot — message polling would stop working.</li>
              </ol>
            </div>
          </section>
          )}

          {/* Reviews & ratings */}
          {tab === 'reviews' && (
          <section className="rounded-2xl border border-white/10 bg-white/[0.03] p-5 space-y-4">
            <div>
              <h3 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-zinc-400"><Star size={15} /> Reviews</h3>
              <p className="text-xs text-zinc-500 mt-1">
                Delivered customers are invited to rate their items (with photos). Reviews go live only after
                you approve them in the <span className="text-zinc-300">Reviews</span> page.
              </p>
            </div>
            <div className="grid sm:grid-cols-2 gap-3 max-w-3xl">
              <div>
                <label className="block text-xs text-zinc-500 mb-1.5">Reward for approved review (%, 0 = off)</label>
                <input className={input} type="number" min={0} max={100} step={5} value={form.review_reward_percent}
                  onChange={e => patch({ review_reward_percent: Number(e.target.value) })} />
                <p className="text-[11px] text-zinc-600 mt-1">Approving a review mints a single-use discount code and sends it to the customer.</p>
              </div>
              <div>
                <label className="block text-xs text-zinc-500 mb-1.5">Review reminder after (days, 0 = off)</label>
                <input className={input} type="number" min={0} step={1} value={form.review_reminder_days}
                  onChange={e => patch({ review_reminder_days: Number(e.target.value) })} />
                <p className="text-[11px] text-zinc-600 mt-1">Delivered orders with no review get one "how's the fit?" nudge (Telegram + email).</p>
              </div>
            </div>
          </section>
          )}

          {/* Legal pages */}
          {tab === 'legal' && (
          <section className="rounded-2xl border border-white/10 bg-white/[0.03] p-5 space-y-4">
            <div>
              <h3 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-zinc-400"><ScrollText size={15} /> Legal pages</h3>
              <p className="text-xs text-zinc-500 mt-1">
                Shown in the storefront's About panel (and the Returns badge on products). Payment providers
                and social shops require these — replace the stubs with your real policies. Save with Save.
              </p>
            </div>
            <div className="grid gap-3 max-w-3xl">
              <div>
                <label className="block text-xs text-zinc-500 mb-1.5">Privacy Policy</label>
                <textarea className={`${input} resize-y`} rows={4} value={form.legal_privacy}
                  onChange={e => patch({ legal_privacy: e.target.value })} />
              </div>
              <div>
                <label className="block text-xs text-zinc-500 mb-1.5">Terms of Service</label>
                <textarea className={`${input} resize-y`} rows={4} value={form.legal_terms}
                  onChange={e => patch({ legal_terms: e.target.value })} />
              </div>
              <div>
                <label className="block text-xs text-zinc-500 mb-1.5">Returns &amp; Shipping</label>
                <textarea className={`${input} resize-y`} rows={4} value={form.legal_returns}
                  onChange={e => patch({ legal_returns: e.target.value })} />
              </div>
            </div>
          </section>
          )}
          </div>
        </div>
      )}
    </PageScaffold>
  );
}

// Write-only Telegram bot token management (private schema, masked status).
function TelegramTokenManager() {
  const [status, setStatus] = useState<{ set: boolean; hint?: string } | null>(null);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const loadStatus = () => {
    requireSupabase().rpc('telegram_secret_status').then(({ data, error }) => {
      if (error) setErr(error.message);
      else setStatus(data as any);
    });
  };
  useEffect(loadStatus, []);

  const saveKey = async () => {
    if (!key.trim()) return;
    setBusy(true); setErr(null);
    const { error } = await requireSupabase().rpc('set_telegram_secret', { p_key: key.trim() });
    setBusy(false);
    if (error) { setErr(error.message); return; }
    setKey('');
    loadStatus();
  };

  return (
    <div className="border-t border-white/10 pt-4 space-y-2">
      <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-zinc-400"><KeyRound size={13} /> Bot token</p>
      {err && <p className="text-xs text-red-400">{err}</p>}
      {status && (
        <p className="text-xs text-zinc-400">
          {status.set
            ? <>Token configured <span className="font-mono text-zinc-300">{status.hint}</span></>
            : 'No token yet — get one from @BotFather.'}
        </p>
      )}
      <div className="flex gap-2 max-w-xl">
        <input
          type="password"
          className="flex-1 bg-white/5 border border-white/15 rounded-xl px-3 py-2.5 text-sm outline-none focus:border-orange-500 transition-colors placeholder:text-zinc-500 font-mono"
          placeholder="123456789:AAxxxxxxxxxxxxxxxxxxxxxxx"
          value={key}
          onChange={e => setKey(e.target.value)}
        />
        <button onClick={saveKey} disabled={busy || !key.trim()}
          className="shrink-0 inline-flex items-center gap-1.5 bg-white/10 border border-white/15 text-sm font-semibold px-4 rounded-xl hover:bg-white hover:text-black transition-colors disabled:opacity-40">
          {busy ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />} {status?.set ? 'Replace token' : 'Save token'}
        </button>
      </div>
      <p className="text-[11px] text-zinc-600">Stored server-side in a private schema — never exposed to the browser or the API after saving.</p>
    </div>
  );
}

// Write-only Resend API key management — stored in the private schema, never
// readable back through the API; only a masked status is shown.
function ResendKeyManager() {
  const [status, setStatus] = useState<{ set: boolean; hint?: string } | null>(null);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const loadStatus = () => {
    requireSupabase().rpc('resend_secret_status').then(({ data, error }) => {
      if (error) setErr(error.message);
      else setStatus(data as any);
    });
  };
  useEffect(loadStatus, []);

  const saveKey = async () => {
    if (!key.trim()) return;
    setBusy(true); setErr(null);
    const { error } = await requireSupabase().rpc('set_resend_secret', { p_key: key.trim() });
    setBusy(false);
    if (error) { setErr(error.message); return; }
    setKey('');
    loadStatus();
  };

  return (
    <div className="border-t border-white/10 pt-4 space-y-2">
      <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-zinc-400"><KeyRound size={13} /> Resend API key</p>
      {err && <p className="text-xs text-red-400">{err}</p>}
      {status && (
        <p className="text-xs text-zinc-400">
          {status.set
            ? <>Key configured <span className="font-mono text-zinc-300">{status.hint}</span></>
            : 'No key configured yet — create one at resend.com → API Keys.'}
        </p>
      )}
      <div className="flex gap-2 max-w-xl">
        <input
          type="password"
          className="flex-1 bg-white/5 border border-white/15 rounded-xl px-3 py-2.5 text-sm outline-none focus:border-orange-500 transition-colors placeholder:text-zinc-500 font-mono"
          placeholder="re_xxxxxxxxxxxxxxxx"
          value={key}
          onChange={e => setKey(e.target.value)}
        />
        <button onClick={saveKey} disabled={busy || !key.trim()}
          className="shrink-0 inline-flex items-center gap-1.5 bg-white/10 border border-white/15 text-sm font-semibold px-4 rounded-xl hover:bg-white hover:text-black transition-colors disabled:opacity-40">
          {busy ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />} {status?.set ? 'Replace key' : 'Save key'}
        </button>
      </div>
      <p className="text-[11px] text-zinc-600">Stored server-side in a private schema — never exposed to the browser or the API after saving.</p>
    </div>
  );
}

// Write-only secret key management — the key is stored in the private schema
// and can never be read back through the API; only a masked status is shown.
function ChapaKeyManager() {
  const [status, setStatus] = useState<{ set: boolean; hint?: string; test_mode?: boolean } | null>(null);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const loadStatus = () => {
    requireSupabase().rpc('chapa_secret_status').then(({ data, error }) => {
      if (error) setErr(error.message);
      else setStatus(data as any);
    });
  };
  useEffect(loadStatus, []);

  const saveKey = async () => {
    if (!key.trim()) return;
    setBusy(true); setErr(null);
    const { error } = await requireSupabase().rpc('set_chapa_secret', { p_key: key.trim() });
    setBusy(false);
    if (error) { setErr(error.message); return; }
    setKey('');
    loadStatus();
  };

  return (
    <div className="border-t border-white/10 pt-4 space-y-2">
      <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-zinc-400"><KeyRound size={13} /> Secret key</p>
      {err && <p className="text-xs text-red-400">{err}</p>}
      {status && (
        <p className="text-xs text-zinc-400">
          {status.set
            ? <>Key configured <span className="font-mono text-zinc-300">{status.hint}</span>{' '}
                <span className={`ml-1 px-2 py-0.5 rounded-full text-[10px] font-bold uppercase ${status.test_mode ? 'bg-amber-500/15 text-amber-400' : 'bg-green-500/15 text-green-400'}`}>
                  {status.test_mode ? 'Test mode' : 'Live'}
                </span></>
            : 'No key configured yet — paste your Chapa secret key (CHASECK_TEST-… for sandbox).'}
        </p>
      )}
      <div className="flex gap-2 max-w-xl">
        <input
          type="password"
          className="flex-1 bg-white/5 border border-white/15 rounded-xl px-3 py-2.5 text-sm outline-none focus:border-orange-500 transition-colors placeholder:text-zinc-500 font-mono"
          placeholder="CHASECK_TEST-xxxxxxxxxxxxxxxx"
          value={key}
          onChange={e => setKey(e.target.value)}
        />
        <button onClick={saveKey} disabled={busy || !key.trim()}
          className="shrink-0 inline-flex items-center gap-1.5 bg-white/10 border border-white/15 text-sm font-semibold px-4 rounded-xl hover:bg-white hover:text-black transition-colors disabled:opacity-40">
          {busy ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />} {status?.set ? 'Replace key' : 'Save key'}
        </button>
      </div>
      <p className="text-[11px] text-zinc-600">Stored server-side in a private schema — it is never exposed to the browser or the API after saving.</p>
    </div>
  );
}
