import React, { useEffect, useState } from 'react';
import { ShoppingBag, Wallet } from 'lucide-react';
import { requireSupabase } from '../lib/supabase';
import { PageScaffold, EmptyState, StatCard, FullscreenLoader } from './ui';
import { Bars, ChartCard, type BarDatum } from './charts';
import type { DbOrder } from '../lib/types';

// Tiny data-fetch helper for read-only admin views.
function useAsync<T>(fn: () => Promise<T>, deps: React.DependencyList = []) {
  const [state, setState] = useState<{ data?: T; loading: boolean; error?: string }>({ loading: true });
  useEffect(() => {
    let alive = true;
    setState({ loading: true });
    fn()
      .then(data => alive && setState({ data, loading: false }))
      .catch(err => alive && setState({ loading: false, error: err?.message ?? String(err) }));
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return state;
}

const money = (n: number) => `$${n.toFixed(2)}`;

const STATUS_TONE: Record<string, string> = {
  pending_approval: 'bg-amber-500/15 text-amber-400',
  confirmed: 'bg-orange-500/15 text-orange-400',
  packed: 'bg-orange-500/15 text-orange-400',
  shipped: 'bg-sky-500/15 text-sky-400',
  out_for_delivery: 'bg-sky-500/15 text-sky-400',
  delivered: 'bg-green-500/15 text-green-400',
  cancelled: 'bg-red-500/15 text-red-400',
};

export function StatusPill({ status }: { status: string }) {
  return (
    <span className={`text-[11px] font-semibold uppercase tracking-wider px-2.5 py-1 rounded-full ${STATUS_TONE[status] ?? 'bg-white/10 text-zinc-300'}`}>
      {status.replace(/_/g, ' ')}
    </span>
  );
}

// -------------------------------------------------------------------------
// Overview — live KPIs from the orders/inventory tables
// -------------------------------------------------------------------------
export function Overview() {
  const orders = useAsync<DbOrder[]>(async () => {
    const { data, error } = await requireSupabase()
      .from('orders').select('*').order('placed_at', { ascending: false }).limit(200);
    if (error) throw error;
    return (data ?? []) as DbOrder[];
  });
  const lowStock = useAsync<number>(async () => {
    const { data, error } = await requireSupabase()
      .from('inventory').select('stock_qty, low_stock_threshold');
    if (error) throw error;
    return (data ?? []).filter((r: any) => r.stock_qty <= r.low_stock_threshold).length;
  });

  if (orders.loading) return <FullscreenLoader label="Loading dashboard…" />;

  const rows = orders.data ?? [];
  const paid = rows.filter(o => o.payment_status === 'paid');
  const revenue = paid.reduce((n, o) => n + Number(o.total), 0);
  const aov = paid.length ? revenue / paid.length : 0;
  const pending = rows.filter(o => o.fulfillment_status === 'pending_approval').length;

  // Paid revenue per day, last 14 days (zero-filled).
  const trend: BarDatum[] = (() => {
    const map = new Map<string, number>();
    for (let i = 13; i >= 0; i--) {
      map.set(new Date(Date.now() - i * 86400000).toISOString().slice(0, 10), 0);
    }
    for (const o of paid) {
      const key = o.placed_at.slice(0, 10);
      if (map.has(key)) map.set(key, (map.get(key) ?? 0) + Number(o.total));
    }
    return [...map.entries()].map(([iso, v]) => ({
      label: new Date(iso).toLocaleDateString(undefined, { month: 'numeric', day: 'numeric' }),
      sub: new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
      value: Math.round(v),
    }));
  })();

  return (
    <PageScaffold title="Overview" subtitle="Store performance at a glance">
      {orders.error && (
        <div className="mb-6 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">
          Couldn’t load orders: {orders.error}
        </div>
      )}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        <StatCard label="Revenue (paid)" value={money(revenue)} sub={`${paid.length} paid orders`} />
        <StatCard label="Orders" value={String(rows.length)} sub="last 200" />
        <StatCard label="Avg. order value" value={money(aov)} />
        <StatCard label="Pending approval" value={String(pending)} sub={`${lowStock.data ?? 0} low-stock items`} accent={pending > 0} />
      </div>

      <div className="mb-8">
        <ChartCard title="Paid revenue" sub="Last 14 days">
          <Bars data={trend} money height={150} />
        </ChartCard>
      </div>

      <h2 className="text-sm font-semibold uppercase tracking-wider text-zinc-400 mb-3">Recent orders</h2>
      {rows.length === 0 ? (
        <EmptyState icon={ShoppingBag} title="No orders yet" hint="Orders placed on the storefront will show up here." />
      ) : (
        <OrdersTable rows={rows.slice(0, 12)} />
      )}
    </PageScaffold>
  );
}

function OrdersTable({ rows }: { rows: DbOrder[] }) {
  return (
    <div className="rounded-2xl border border-white/10 overflow-hidden">
      <table className="w-full text-sm">
        <thead className="bg-white/5 text-zinc-400 text-xs uppercase tracking-wider">
          <tr>
            <th className="text-left font-medium px-4 py-3">Order</th>
            <th className="text-left font-medium px-4 py-3 hidden sm:table-cell">Placed</th>
            <th className="text-left font-medium px-4 py-3">Total</th>
            <th className="text-left font-medium px-4 py-3">Payment</th>
            <th className="text-left font-medium px-4 py-3">Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(o => (
            <tr key={o.id} className="border-t border-white/5 hover:bg-white/[0.03]">
              <td className="px-4 py-3 font-mono text-xs">{o.human_id}</td>
              <td className="px-4 py-3 text-zinc-400 hidden sm:table-cell">{new Date(o.placed_at).toLocaleDateString()}</td>
              <td className="px-4 py-3 font-semibold">{money(Number(o.total))}</td>
              <td className="px-4 py-3">
                <span className="text-xs text-zinc-300">{o.payment_method === 'chapa' ? 'Chapa' : 'Bank slip'}</span>
                <span className={`ml-2 text-[11px] ${o.payment_status === 'paid' ? 'text-green-400' : 'text-amber-400'}`}>{o.payment_status}</span>
              </td>
              <td className="px-4 py-3"><StatusPill status={o.fulfillment_status} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// -------------------------------------------------------------------------
// Payments — verified gateway transactions (Chapa). Bank-slip approvals live
// in Orders; every verified Chapa payment lands here with its raw reference.
// -------------------------------------------------------------------------
export function Payments() {
  const payments = useAsync<any[]>(async () => {
    const { data, error } = await requireSupabase()
      .from('payments')
      .select('id,provider,provider_ref,amount,status,created_at,order:orders(human_id,ship_address)')
      .order('created_at', { ascending: false })
      .limit(200);
    if (error) throw error;
    return data ?? [];
  });
  const rows = payments.data ?? [];
  return (
    <PageScaffold title="Payments" subtitle="Gateway transactions (bank-slip approvals live in Orders)">
      {payments.error && <div className="mb-4 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">{payments.error}</div>}
      {payments.loading ? (
        <p className="text-sm text-zinc-500">Loading…</p>
      ) : rows.length === 0 ? (
        <EmptyState icon={Wallet} title="No gateway payments yet" hint="Verified Chapa transactions appear here. Enable Chapa in Settings, then pay for an order at checkout." />
      ) : (
        <div className="rounded-2xl border border-white/10 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-white/5 text-zinc-400 text-xs uppercase tracking-wider">
              <tr>
                <th className="text-left font-medium px-4 py-3">Date</th>
                <th className="text-left font-medium px-4 py-3">Order</th>
                <th className="text-left font-medium px-4 py-3 hidden sm:table-cell">Reference</th>
                <th className="text-left font-medium px-4 py-3">Amount</th>
                <th className="text-left font-medium px-4 py-3">Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(p => (
                <tr key={p.id} className="border-t border-white/5 hover:bg-white/[0.03]">
                  <td className="px-4 py-3 text-zinc-400">{new Date(p.created_at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</td>
                  <td className="px-4 py-3 font-mono text-xs">{p.order?.human_id ?? '—'}</td>
                  <td className="px-4 py-3 font-mono text-xs text-zinc-400 hidden sm:table-cell">{p.provider}:{p.provider_ref ?? '—'}</td>
                  <td className="px-4 py-3 font-semibold">{money(Number(p.amount))}</td>
                  <td className="px-4 py-3">
                    <span className={`text-[11px] font-semibold uppercase px-2 py-1 rounded-full ${p.status === 'paid' ? 'bg-green-500/15 text-green-400' : p.status === 'failed' ? 'bg-red-500/15 text-red-400' : 'bg-amber-500/15 text-amber-400'}`}>{p.status}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </PageScaffold>
  );
}
