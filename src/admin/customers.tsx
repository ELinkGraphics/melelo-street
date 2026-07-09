import React, { useEffect, useMemo, useState } from 'react';
import { Users, X, Search, Phone } from 'lucide-react';
import { requireSupabase } from '../lib/supabase';
import { PageScaffold, EmptyState } from './ui';
import { StatusPill } from './pages';
import type { DbOrder } from '../lib/types';

import { fmtMoney as money } from '../lib/currency';
const fmtDate = (s: string) => new Date(s).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

type Customer = {
  key: string;
  name: string;
  phone: string | null;
  orders: DbOrder[];
  lifetime: number;   // paid revenue
  pending: number;    // awaiting approval
  lastAt: string;
};

// Guests have no accounts — identity is derived from orders: phone number when
// present, otherwise the "Name, address" string captured at checkout.
function aggregate(orders: DbOrder[]): Customer[] {
  const map = new Map<string, Customer>();
  for (const o of orders) {
    const key = o.phone?.trim() || (o.ship_address ?? 'unknown');
    const name = (o.ship_address ?? '').split(',')[0].trim() || 'Guest';
    const c = map.get(key) ?? { key, name, phone: o.phone, orders: [], lifetime: 0, pending: 0, lastAt: o.placed_at };
    c.orders.push(o);
    if (o.payment_status === 'paid') c.lifetime += Number(o.total);
    if (o.fulfillment_status === 'pending_approval') c.pending += 1;
    if (o.placed_at > c.lastAt) c.lastAt = o.placed_at;
    map.set(key, c);
  }
  return [...map.values()].sort((a, b) => b.lifetime - a.lifetime || b.lastAt.localeCompare(a.lastAt));
}

export function CustomersPage() {
  const [orders, setOrders] = useState<DbOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<Customer | null>(null);

  useEffect(() => {
    requireSupabase().from('orders').select('*').order('placed_at', { ascending: false }).limit(500)
      .then(({ data, error }) => {
        if (error) setErr(error.message);
        else setOrders((data ?? []) as DbOrder[]);
        setLoading(false);
      });
  }, []);

  const customers = useMemo(() => aggregate(orders), [orders]);
  const q = query.trim().toLowerCase();
  const filtered = customers.filter(c =>
    !q || c.name.toLowerCase().includes(q) || (c.phone ?? '').toLowerCase().includes(q));

  return (
    <PageScaffold title="Customers" subtitle={`${customers.length} unique shopper(s), ranked by lifetime value`}>
      {err && <div className="mb-4 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">{err}</div>}

      <div className="flex mb-4">
        <div className="ml-auto flex items-center gap-2 rounded-full bg-white/5 border border-white/10 px-3 py-1.5 text-sm">
          <Search size={14} className="text-zinc-500" />
          <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Name or phone…"
            className="bg-transparent outline-none w-44 placeholder:text-zinc-500" />
        </div>
      </div>

      {loading ? (
        <p className="text-sm text-zinc-500">Loading…</p>
      ) : filtered.length === 0 ? (
        <EmptyState icon={Users} title="No customers yet" hint="Shoppers appear here after their first order." />
      ) : (
        <div className="rounded-2xl border border-white/10 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-white/5 text-zinc-400 text-xs uppercase tracking-wider">
              <tr>
                <th className="text-left font-medium px-4 py-3">Customer</th>
                <th className="text-left font-medium px-4 py-3 hidden sm:table-cell">Phone</th>
                <th className="text-left font-medium px-4 py-3">Orders</th>
                <th className="text-left font-medium px-4 py-3">Lifetime value</th>
                <th className="text-left font-medium px-4 py-3 hidden md:table-cell">Last order</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(c => (
                <tr key={c.key} onClick={() => setSelected(c)} className="border-t border-white/5 hover:bg-white/[0.04] cursor-pointer">
                  <td className="px-4 py-3 font-medium">{c.name}</td>
                  <td className="px-4 py-3 text-zinc-400 hidden sm:table-cell">{c.phone ?? '—'}</td>
                  <td className="px-4 py-3">
                    {c.orders.length}
                    {c.pending > 0 && <span className="ml-2 text-[11px] font-semibold text-amber-400">{c.pending} pending</span>}
                  </td>
                  <td className="px-4 py-3 font-semibold">{money(c.lifetime)}</td>
                  <td className="px-4 py-3 text-zinc-400 hidden md:table-cell">{fmtDate(c.lastAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {selected && (
        <div className="fixed inset-0 z-[60] flex justify-end">
          <div className="absolute inset-0 bg-black/60" onClick={() => setSelected(null)} />
          <div className="relative w-full max-w-md bg-zinc-950 border-l border-white/10 h-full flex flex-col">
            <header className="h-16 shrink-0 flex items-center justify-between px-5 border-b border-white/10">
              <div>
                <h2 className="font-semibold">{selected.name}</h2>
                {selected.phone && <p className="text-xs text-zinc-400 flex items-center gap-1"><Phone size={11} /> {selected.phone}</p>}
              </div>
              <button onClick={() => setSelected(null)} aria-label="Close"><X size={20} className="text-zinc-400 hover:text-white" /></button>
            </header>
            <div className="p-5 grid grid-cols-2 gap-3 border-b border-white/10">
              <div className="rounded-xl bg-white/[0.04] p-3">
                <p className="text-[10px] uppercase tracking-wider text-zinc-500">Lifetime value</p>
                <p className="text-lg font-bold mt-0.5">{money(selected.lifetime)}</p>
              </div>
              <div className="rounded-xl bg-white/[0.04] p-3">
                <p className="text-[10px] uppercase tracking-wider text-zinc-500">Orders</p>
                <p className="text-lg font-bold mt-0.5">{selected.orders.length}</p>
              </div>
            </div>
            <div className="flex-1 overflow-y-auto p-5 space-y-2">
              {selected.orders.map(o => (
                <div key={o.id} className="rounded-xl border border-white/10 bg-white/[0.03] p-3 flex items-center justify-between gap-3">
                  <div>
                    <p className="font-mono text-xs text-zinc-400">{o.human_id}</p>
                    <p className="text-sm font-medium mt-0.5">{fmtDate(o.placed_at)} · {money(o.total)}</p>
                  </div>
                  <StatusPill status={o.fulfillment_status} />
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </PageScaffold>
  );
}
