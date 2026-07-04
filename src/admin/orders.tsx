import React, { useCallback, useEffect, useState } from 'react';
import {
  ShoppingBag, X, Loader2, BadgeCheck, XCircle, Landmark, ArrowRight, Ban, Search,
} from 'lucide-react';
import { requireSupabase } from '../lib/supabase';
import { PageScaffold, EmptyState } from './ui';
import { StatusPill } from './pages';
import type { DbOrder, DbOrderItem, DbOrderEvent, FulfillmentStatus } from '../lib/types';

const money = (n: number) => `$${Number(n).toFixed(2)}`;
const fmtDateTime = (s: string) =>
  new Date(s).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

// Fulfillment pipeline after payment approval.
const FLOW: FulfillmentStatus[] = ['confirmed', 'packed', 'shipped', 'out_for_delivery', 'delivered'];
const LABELS: Record<string, string> = {
  pending_approval: 'Payment approval', confirmed: 'Confirmed', packed: 'Packed',
  shipped: 'Shipped', out_for_delivery: 'Out for delivery', delivered: 'Delivered', cancelled: 'Cancelled',
};

type Tab = 'all' | 'pending' | 'active' | 'delivered' | 'cancelled';
const TABS: { id: Tab; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'pending', label: 'Pending approval' },
  { id: 'active', label: 'In progress' },
  { id: 'delivered', label: 'Delivered' },
  { id: 'cancelled', label: 'Cancelled' },
];

function matchesTab(o: DbOrder, tab: Tab): boolean {
  switch (tab) {
    case 'pending': return o.fulfillment_status === 'pending_approval';
    case 'active': return ['confirmed', 'packed', 'shipped', 'out_for_delivery'].includes(o.fulfillment_status);
    case 'delivered': return o.fulfillment_status === 'delivered';
    case 'cancelled': return o.fulfillment_status === 'cancelled';
    default: return true;
  }
}

export function OrdersPage() {
  const [rows, setRows] = useState<DbOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('all');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<DbOrder | null>(null);

  const load = useCallback(async () => {
    setErr(null);
    try {
      const { data, error } = await requireSupabase()
        .from('orders')
        .select('*, items:order_items(*)')
        .order('placed_at', { ascending: false })
        .limit(300);
      if (error) throw error;
      setRows((data ?? []) as DbOrder[]);
    } catch (e: any) { setErr(e.message ?? String(e)); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const q = query.trim().toLowerCase();
  const filtered = rows.filter(o =>
    matchesTab(o, tab) &&
    (!q || o.human_id.toLowerCase().includes(q) || (o.ship_address ?? '').toLowerCase().includes(q)));

  const pendingCount = rows.filter(o => o.fulfillment_status === 'pending_approval').length;

  return (
    <PageScaffold title="Orders" subtitle={pendingCount > 0 ? `${pendingCount} awaiting payment approval` : 'All caught up'}>
      {err && <div className="mb-4 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">{err}</div>}

      {/* Tabs + search */}
      <div className="flex flex-wrap items-center gap-2 mb-4">
        {TABS.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)}
            className={`px-3.5 py-1.5 rounded-full text-xs font-semibold transition-colors ${tab === t.id ? 'bg-orange-500 text-black' : 'bg-white/5 text-zinc-300 hover:bg-white/10'}`}>
            {t.label}
            {t.id === 'pending' && pendingCount > 0 && <span className="ml-1.5">({pendingCount})</span>}
          </button>
        ))}
        <div className="ml-auto flex items-center gap-2 rounded-full bg-white/5 border border-white/10 px-3 py-1.5 text-sm">
          <Search size={14} className="text-zinc-500" />
          <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Order ID or address…"
            className="bg-transparent outline-none w-44 placeholder:text-zinc-500" />
        </div>
      </div>

      {loading ? (
        <p className="text-sm text-zinc-500">Loading…</p>
      ) : filtered.length === 0 ? (
        <EmptyState icon={ShoppingBag} title="No orders here" hint={tab === 'all' ? 'Orders placed on the storefront appear here in real money terms.' : 'Nothing matches this filter.'} />
      ) : (
        <div className="rounded-2xl border border-white/10 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-white/5 text-zinc-400 text-xs uppercase tracking-wider">
              <tr>
                <th className="text-left font-medium px-4 py-3">Order</th>
                <th className="text-left font-medium px-4 py-3 hidden md:table-cell">Customer</th>
                <th className="text-left font-medium px-4 py-3 hidden sm:table-cell">Placed</th>
                <th className="text-left font-medium px-4 py-3">Total</th>
                <th className="text-left font-medium px-4 py-3">Status</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(o => (
                <tr key={o.id} onClick={() => setSelected(o)} className="border-t border-white/5 hover:bg-white/[0.04] cursor-pointer">
                  <td className="px-4 py-3 font-mono text-xs">{o.human_id}</td>
                  <td className="px-4 py-3 text-zinc-300 hidden md:table-cell max-w-[220px] truncate">{o.ship_address ?? '—'}</td>
                  <td className="px-4 py-3 text-zinc-400 hidden sm:table-cell">{fmtDateTime(o.placed_at)}</td>
                  <td className="px-4 py-3 font-semibold">{money(o.total)}</td>
                  <td className="px-4 py-3"><StatusPill status={o.fulfillment_status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {selected && (
        <OrderDrawer
          order={selected}
          onClose={() => setSelected(null)}
          onChanged={async () => { await load(); }}
          refreshSelected={(id) => {
            // keep the drawer in sync after an action
            requireSupabase().from('orders').select('*, items:order_items(*)').eq('id', id).single()
              .then(({ data }) => { if (data) setSelected(data as DbOrder); });
          }}
        />
      )}
    </PageScaffold>
  );
}

// ---------------------------------------------------------------------------
// Detail drawer with actions
// ---------------------------------------------------------------------------
function OrderDrawer({
  order, onClose, onChanged, refreshSelected,
}: {
  order: DbOrder;
  onClose: () => void;
  onChanged: () => Promise<void>;
  refreshSelected: (id: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [slipUrl, setSlipUrl] = useState<string | null>(null);
  const [events, setEvents] = useState<DbOrderEvent[]>([]);

  const items: DbOrderItem[] = (order as any).items ?? [];
  const pendingApproval = order.fulfillment_status === 'pending_approval' && order.payment_status === 'pending';
  const cancelled = order.fulfillment_status === 'cancelled';
  const delivered = order.fulfillment_status === 'delivered';
  const flowIdx = FLOW.indexOf(order.fulfillment_status as FulfillmentStatus);
  const nextStep = flowIdx >= 0 && flowIdx < FLOW.length - 1 ? FLOW[flowIdx + 1] : null;

  // Signed URL for the private slip image.
  useEffect(() => {
    let alive = true;
    setSlipUrl(null);
    if (order.slip_url) {
      requireSupabase().storage.from('payment-slips').createSignedUrl(order.slip_url, 3600)
        .then(({ data }) => { if (alive) setSlipUrl(data?.signedUrl ?? null); });
    }
    return () => { alive = false; };
  }, [order.id, order.slip_url]);

  // Event timeline.
  useEffect(() => {
    let alive = true;
    requireSupabase().from('order_events').select('*').eq('order_id', order.id).order('created_at')
      .then(({ data }) => { if (alive) setEvents((data ?? []) as DbOrderEvent[]); });
    return () => { alive = false; };
  }, [order.id, order.fulfillment_status]);

  const act = async (fn: () => Promise<void>) => {
    setBusy(true); setErr(null);
    try { await fn(); await onChanged(); refreshSelected(order.id); }
    catch (e: any) { setErr(e.message ?? String(e)); }
    finally { setBusy(false); }
  };

  const sb = () => requireSupabase();

  const addEvent = async (status: string, note: string) => {
    await sb().from('order_events').insert({ order_id: order.id, status, note });
  };

  // Stock was reserved at placement — give it back on reject/cancel.
  const restoreStock = async () => {
    for (const it of items) {
      if ((it as any).variant_id) {
        await sb().rpc('adjust_stock', { p_variant: (it as any).variant_id, p_size: it.size, p_delta: it.qty });
      }
    }
  };

  const approve = () => act(async () => {
    const { error } = await sb().from('orders').update({
      payment_status: 'paid', fulfillment_status: 'confirmed', approved_at: new Date().toISOString(),
    }).eq('id', order.id);
    if (error) throw error;
    await addEvent('confirmed', 'Payment approved — order confirmed');
  });

  const reject = () => act(async () => {
    const { error } = await sb().from('orders').update({
      payment_status: 'failed', fulfillment_status: 'cancelled',
    }).eq('id', order.id);
    if (error) throw error;
    await restoreStock();
    await addEvent('cancelled', 'Payment slip rejected — stock released');
  });

  const advance = (to: FulfillmentStatus) => act(async () => {
    const { error } = await sb().from('orders').update({ fulfillment_status: to }).eq('id', order.id);
    if (error) throw error;
    await addEvent(to, `Marked as ${LABELS[to].toLowerCase()}`);
  });

  const cancel = () => act(async () => {
    const { error } = await sb().from('orders').update({ fulfillment_status: 'cancelled' }).eq('id', order.id);
    if (error) throw error;
    // Only restore if stock wasn't already released by a payment rejection.
    if (order.payment_status !== 'failed') await restoreStock();
    await addEvent('cancelled', 'Order cancelled by admin — stock released');
  });

  return (
    <div className="fixed inset-0 z-[60] flex justify-end">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className="relative w-full max-w-xl bg-zinc-950 border-l border-white/10 h-full flex flex-col">
        <header className="h-16 shrink-0 flex items-center justify-between px-5 border-b border-white/10">
          <div className="flex items-center gap-3">
            <h2 className="font-mono text-sm">{order.human_id}</h2>
            <StatusPill status={order.fulfillment_status} />
          </div>
          <button onClick={onClose} aria-label="Close"><X size={20} className="text-zinc-400 hover:text-white" /></button>
        </header>

        <div className="flex-1 overflow-y-auto p-5 space-y-6">
          {err && <div className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">{err}</div>}

          {/* Customer + payment summary */}
          <section className="grid sm:grid-cols-2 gap-3">
            <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
              <p className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1.5">Ship to</p>
              <p className="text-sm text-zinc-200">{order.ship_address ?? '—'}</p>
              {order.phone && <p className="text-sm text-zinc-400 mt-1">{order.phone}</p>}
              <p className="text-xs text-zinc-500 mt-2">Placed {fmtDateTime(order.placed_at)}</p>
            </div>
            <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
              <p className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1.5">Payment</p>
              <p className="text-sm text-zinc-200 flex items-center gap-1.5">
                <Landmark size={14} className="text-orange-400" />
                {order.payment_method === 'chapa' ? 'Chapa' : 'Bank transfer slip'}
              </p>
              <p className={`text-xs mt-1 font-semibold ${order.payment_status === 'paid' ? 'text-green-400' : order.payment_status === 'failed' ? 'text-red-400' : 'text-amber-400'}`}>
                {order.payment_status}
              </p>
              <p className="text-sm font-bold mt-2">{money(order.total)} <span className="text-xs font-normal text-zinc-500">({money(order.subtotal)} + {money(order.shipping)} ship)</span></p>
            </div>
          </section>

          {/* Slip */}
          {order.slip_url && (
            <section>
              <p className="text-xs font-semibold uppercase tracking-wider text-zinc-400 mb-2">Payment slip</p>
              {slipUrl ? (
                <a href={slipUrl} target="_blank" rel="noreferrer" className="block w-40 rounded-xl overflow-hidden border border-white/10 hover:border-orange-500 transition-colors">
                  <img src={slipUrl} alt="Payment slip" className="w-full object-cover" />
                </a>
              ) : (
                <div className="w-40 h-24 rounded-xl bg-white/5 flex items-center justify-center"><Loader2 size={16} className="animate-spin text-zinc-500" /></div>
              )}
            </section>
          )}

          {/* Actions */}
          {!cancelled && !delivered && (
            <section className="flex flex-wrap gap-2">
              {pendingApproval && (
                <>
                  <button onClick={approve} disabled={busy}
                    className="inline-flex items-center gap-1.5 bg-green-500 text-black text-sm font-bold px-4 py-2.5 rounded-full hover:bg-green-400 transition-colors disabled:opacity-50">
                    <BadgeCheck size={16} /> Approve payment
                  </button>
                  <button onClick={reject} disabled={busy}
                    className="inline-flex items-center gap-1.5 border border-red-500/50 text-red-400 text-sm font-bold px-4 py-2.5 rounded-full hover:bg-red-500/10 transition-colors disabled:opacity-50">
                    <XCircle size={16} /> Reject
                  </button>
                </>
              )}
              {nextStep && order.payment_status === 'paid' && (
                <button onClick={() => advance(nextStep)} disabled={busy}
                  className="inline-flex items-center gap-1.5 bg-orange-500 text-black text-sm font-bold px-4 py-2.5 rounded-full hover:bg-orange-400 transition-colors disabled:opacity-50">
                  <ArrowRight size={16} /> Mark {LABELS[nextStep].toLowerCase()}
                </button>
              )}
              {!pendingApproval && (
                <button onClick={cancel} disabled={busy}
                  className="inline-flex items-center gap-1.5 border border-white/15 text-zinc-300 text-sm font-semibold px-4 py-2.5 rounded-full hover:border-red-500/50 hover:text-red-400 transition-colors disabled:opacity-50">
                  <Ban size={16} /> Cancel order
                </button>
              )}
              {busy && <Loader2 size={18} className="animate-spin text-orange-400 self-center" />}
            </section>
          )}

          {/* Items */}
          <section>
            <p className="text-xs font-semibold uppercase tracking-wider text-zinc-400 mb-2">Items</p>
            <div className="space-y-2">
              {items.map(it => (
                <div key={it.id} className="flex items-center gap-3 rounded-xl border border-white/10 bg-white/[0.03] p-3">
                  <div className="w-12 h-12 rounded-lg bg-black/40 overflow-hidden flex items-center justify-center shrink-0">
                    {it.image && <img src={it.image} alt="" className="w-full h-full object-contain" />}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{it.name}</p>
                    <p className="text-xs text-zinc-400">Size {it.size} · {it.color} · ×{it.qty}</p>
                  </div>
                  <span className="text-sm font-semibold">{money(Number(it.unit_price) * it.qty)}</span>
                </div>
              ))}
            </div>
          </section>

          {/* Timeline */}
          <section>
            <p className="text-xs font-semibold uppercase tracking-wider text-zinc-400 mb-2">Timeline</p>
            <div className="space-y-2">
              {events.map(e => (
                <div key={e.id} className="flex items-start gap-3 text-sm">
                  <span className="mt-1.5 w-2 h-2 rounded-full bg-orange-500 shrink-0" />
                  <div>
                    <p className="text-zinc-200">{LABELS[e.status] ?? e.status}{e.note ? <span className="text-zinc-500"> — {e.note}</span> : null}</p>
                    <p className="text-xs text-zinc-500">{fmtDateTime(e.created_at)}</p>
                  </div>
                </div>
              ))}
              {events.length === 0 && <p className="text-sm text-zinc-500">No events yet.</p>}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
