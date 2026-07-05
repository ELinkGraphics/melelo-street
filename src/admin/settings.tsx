import React, { useEffect, useState } from 'react';
import { Save, Loader2, Store, Landmark, Truck, CheckCircle2, Wallet, KeyRound, Mail } from 'lucide-react';
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
};

const input = 'w-full bg-white/5 border border-white/15 rounded-xl px-3 py-2.5 text-sm outline-none focus:border-orange-500 transition-colors placeholder:text-zinc-500';

export function SettingsPage() {
  const [form, setForm] = useState<SettingsForm | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

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
        <div className="grid lg:grid-cols-3 gap-4 max-w-5xl">
          {/* Store profile */}
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
            </div>
          </section>

          {/* Bank details */}
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

          {/* Shipping */}
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

          {/* Chapa payments */}
          <section className="rounded-2xl border border-white/10 bg-white/[0.03] p-5 space-y-4 lg:col-span-3">
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
            <ChapaKeyManager />
          </section>

          {/* Email notifications (Resend) */}
          <section className="rounded-2xl border border-white/10 bg-white/[0.03] p-5 space-y-4 lg:col-span-3">
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
        </div>
      )}
    </PageScaffold>
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
