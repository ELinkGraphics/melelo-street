import React, { useCallback, useEffect, useState } from 'react';
import { Ticket, Plus, X, Save, Trash2, Loader2 } from 'lucide-react';
import { requireSupabase } from '../lib/supabase';
import { PageScaffold, EmptyState } from './ui';
import type { DbDiscount } from '../lib/types';

const money = (n: number) => `$${Number(n).toFixed(2)}`;
const input = 'w-full bg-white/5 border border-white/15 rounded-xl px-3 py-2.5 text-sm outline-none focus:border-orange-500 transition-colors placeholder:text-zinc-500';

type Form = {
  id?: string;
  code: string;
  type: 'percent' | 'fixed';
  value: number;
  min_subtotal: number;
  starts_at: string;   // yyyy-mm-dd or ''
  ends_at: string;
  usage_limit: string; // '' = unlimited
  active: boolean;
};

const emptyForm = (): Form => ({
  code: '', type: 'percent', value: 10, min_subtotal: 0,
  starts_at: '', ends_at: '', usage_limit: '', active: true,
});

const toForm = (d: DbDiscount): Form => ({
  id: d.id, code: d.code, type: d.type, value: Number(d.value),
  min_subtotal: Number(d.min_subtotal),
  starts_at: d.starts_at ? d.starts_at.slice(0, 10) : '',
  ends_at: d.ends_at ? d.ends_at.slice(0, 10) : '',
  usage_limit: d.usage_limit != null ? String(d.usage_limit) : '',
  active: d.active,
});

function describeValue(d: DbDiscount) {
  return d.type === 'percent' ? `${Number(d.value)}% off` : `${money(Number(d.value))} off`;
}

function isLive(d: DbDiscount): boolean {
  const now = Date.now();
  if (!d.active) return false;
  if (d.starts_at && new Date(d.starts_at).getTime() > now) return false;
  if (d.ends_at && new Date(d.ends_at).getTime() < now) return false;
  if (d.usage_limit != null && d.used_count >= d.usage_limit) return false;
  return true;
}

export function DiscountsPage() {
  const [rows, setRows] = useState<DbDiscount[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState<Form | null>(null);

  const load = useCallback(async () => {
    setErr(null);
    try {
      const { data, error } = await requireSupabase().from('discounts').select('*').order('code');
      if (error) throw error;
      setRows((data ?? []) as DbDiscount[]);
    } catch (e: any) { setErr(e.message ?? String(e)); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const toggleActive = async (d: DbDiscount) => {
    const { error } = await requireSupabase().from('discounts').update({ active: !d.active }).eq('id', d.id);
    if (error) setErr(error.message); else load();
  };

  return (
    <PageScaffold
      title="Discounts"
      subtitle="Codes customers can apply at checkout"
      actions={
        <button onClick={() => setEditing(emptyForm())}
          className="inline-flex items-center gap-2 bg-orange-500 text-black font-semibold text-sm px-4 py-2.5 rounded-xl hover:bg-orange-400 transition-colors">
          <Plus size={16} /> New code
        </button>
      }
    >
      {err && <div className="mb-4 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">{err}</div>}
      {loading ? (
        <p className="text-sm text-zinc-500">Loading…</p>
      ) : rows.length === 0 ? (
        <EmptyState icon={Ticket} title="No discount codes" hint="Create a code like WELCOME10 — customers enter it at checkout and the server applies it." />
      ) : (
        <div className="rounded-2xl border border-white/10 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-white/5 text-zinc-400 text-xs uppercase tracking-wider">
              <tr>
                <th className="text-left font-medium px-4 py-3">Code</th>
                <th className="text-left font-medium px-4 py-3">Discount</th>
                <th className="text-left font-medium px-4 py-3 hidden sm:table-cell">Min. subtotal</th>
                <th className="text-left font-medium px-4 py-3 hidden md:table-cell">Used</th>
                <th className="text-left font-medium px-4 py-3">Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(d => (
                <tr key={d.id} onClick={() => setEditing(toForm(d))} className="border-t border-white/5 hover:bg-white/[0.04] cursor-pointer">
                  <td className="px-4 py-3 font-mono font-semibold">{d.code}</td>
                  <td className="px-4 py-3">{describeValue(d)}</td>
                  <td className="px-4 py-3 text-zinc-400 hidden sm:table-cell">{Number(d.min_subtotal) > 0 ? money(Number(d.min_subtotal)) : '—'}</td>
                  <td className="px-4 py-3 text-zinc-400 hidden md:table-cell">{d.used_count}{d.usage_limit != null ? ` / ${d.usage_limit}` : ''}</td>
                  <td className="px-4 py-3" onClick={e => { e.stopPropagation(); toggleActive(d); }}>
                    <span className={`text-[11px] font-semibold uppercase px-2 py-1 rounded-full cursor-pointer ${isLive(d) ? 'bg-green-500/15 text-green-400' : 'bg-white/10 text-zinc-400'}`}>
                      {isLive(d) ? 'Live' : d.active ? 'Scheduled/limit' : 'Off'}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editing && <DiscountEditor form={editing} onClose={() => setEditing(null)} onChanged={load} />}
    </PageScaffold>
  );
}

function DiscountEditor({ form: initial, onClose, onChanged }: { form: Form; onClose: () => void; onChanged: () => void }) {
  const [form, setForm] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const patch = (p: Partial<Form>) => setForm(f => ({ ...f, ...p }));

  const save = async () => {
    setBusy(true); setErr(null);
    try {
      if (!form.code.trim()) throw new Error('Code is required.');
      if (form.value <= 0) throw new Error('Value must be positive.');
      if (form.type === 'percent' && form.value > 100) throw new Error('Percent cannot exceed 100.');
      const payload = {
        code: form.code.trim().toUpperCase(),
        type: form.type,
        value: form.value,
        min_subtotal: form.min_subtotal,
        starts_at: form.starts_at ? new Date(form.starts_at + 'T00:00:00').toISOString() : null,
        ends_at: form.ends_at ? new Date(form.ends_at + 'T23:59:59').toISOString() : null,
        usage_limit: form.usage_limit.trim() === '' ? null : Number(form.usage_limit),
        active: form.active,
      };
      const sb = requireSupabase();
      const { error } = form.id
        ? await sb.from('discounts').update(payload).eq('id', form.id)
        : await sb.from('discounts').insert(payload);
      if (error) throw error;
      onChanged(); onClose();
    } catch (e: any) { setErr(e.message ?? String(e)); }
    finally { setBusy(false); }
  };

  const remove = async () => {
    if (!form.id || !confirm('Delete this discount code?')) return;
    setBusy(true);
    const { error } = await requireSupabase().from('discounts').delete().eq('id', form.id);
    if (error) { setErr(error.message); setBusy(false); return; }
    onChanged(); onClose();
  };

  return (
    <div className="fixed inset-0 z-[60] flex justify-end">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className="relative w-full max-w-md bg-zinc-950 border-l border-white/10 h-full flex flex-col">
        <header className="h-16 shrink-0 flex items-center justify-between px-5 border-b border-white/10">
          <h2 className="font-semibold">{form.id ? 'Edit code' : 'New code'}</h2>
          <button onClick={onClose} aria-label="Close"><X size={20} className="text-zinc-400 hover:text-white" /></button>
        </header>
        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          {err && <div className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">{err}</div>}
          <div>
            <label className="block text-xs text-zinc-500 mb-1.5">Code</label>
            <input className={`${input} font-mono uppercase`} placeholder="WELCOME10" value={form.code}
              onChange={e => patch({ code: e.target.value.toUpperCase() })} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-zinc-500 mb-1.5">Type</label>
              <select className={input} value={form.type} onChange={e => patch({ type: e.target.value as Form['type'] })}>
                <option value="percent" className="bg-zinc-900">Percent off</option>
                <option value="fixed" className="bg-zinc-900">Fixed amount off</option>
              </select>
            </div>
            <div>
              <label className="block text-xs text-zinc-500 mb-1.5">{form.type === 'percent' ? 'Percent (%)' : 'Amount ($)'}</label>
              <input className={input} type="number" min={0} value={form.value} onChange={e => patch({ value: Number(e.target.value) })} />
            </div>
          </div>
          <div>
            <label className="block text-xs text-zinc-500 mb-1.5">Minimum subtotal ($)</label>
            <input className={input} type="number" min={0} value={form.min_subtotal} onChange={e => patch({ min_subtotal: Number(e.target.value) })} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-zinc-500 mb-1.5">Starts (optional)</label>
              <input className={input} type="date" value={form.starts_at} onChange={e => patch({ starts_at: e.target.value })} />
            </div>
            <div>
              <label className="block text-xs text-zinc-500 mb-1.5">Ends (optional)</label>
              <input className={input} type="date" value={form.ends_at} onChange={e => patch({ ends_at: e.target.value })} />
            </div>
          </div>
          <div>
            <label className="block text-xs text-zinc-500 mb-1.5">Usage limit (empty = unlimited)</label>
            <input className={input} type="number" min={1} placeholder="e.g. 100" value={form.usage_limit}
              onChange={e => patch({ usage_limit: e.target.value })} />
          </div>
          <label className="flex items-center gap-2 text-sm text-zinc-300 cursor-pointer">
            <input type="checkbox" checked={form.active} onChange={e => patch({ active: e.target.checked })} />
            Active
          </label>
        </div>
        <footer className="shrink-0 border-t border-white/10 p-4 flex items-center gap-3">
          {form.id && (
            <button onClick={remove} disabled={busy} className="inline-flex items-center gap-1.5 text-sm font-semibold text-red-400 hover:text-red-300 disabled:opacity-50">
              <Trash2 size={16} /> Delete
            </button>
          )}
          <button onClick={save} disabled={busy}
            className="ml-auto inline-flex items-center gap-2 bg-orange-500 text-black font-bold text-sm px-5 py-2.5 rounded-xl hover:bg-orange-400 transition-colors disabled:opacity-50">
            {busy ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />} Save
          </button>
        </footer>
      </div>
    </div>
  );
}
