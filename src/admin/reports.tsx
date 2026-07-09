import React, { useEffect, useMemo, useState } from 'react';
import { Download, BarChart3 } from 'lucide-react';
import { requireSupabase } from '../lib/supabase';
import { PageScaffold, EmptyState } from './ui';
import { Bars, HBarList, ChartCard, SERIES_1, SERIES_2, type BarDatum } from './charts';

import { fmtMoney as money } from '../lib/currency';

type Row = {
  id: string; human_id: string; total: number; placed_at: string;
  payment_method: 'chapa' | 'bank_slip';
  payment_status: string; fulfillment_status: string; ship_address: string | null;
  items: { name: string; qty: number; unit_price: number; product: { category: { name: string } | null } | null }[];
};

const RANGES = [
  { days: 7, label: '7 days' },
  { days: 30, label: '30 days' },
  { days: 90, label: '90 days' },
];

const FUNNEL: { key: string; label: string }[] = [
  { key: 'pending_approval', label: 'Payment approval' },
  { key: 'confirmed', label: 'Confirmed' },
  { key: 'packed', label: 'Packed' },
  { key: 'shipped', label: 'Shipped' },
  { key: 'out_for_delivery', label: 'Out for delivery' },
  { key: 'delivered', label: 'Delivered' },
];

export function ReportsPage() {
  const [days, setDays] = useState(30);
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    const since = new Date(Date.now() - days * 86400000).toISOString();
    requireSupabase()
      .from('orders')
      .select('id,human_id,total,placed_at,payment_method,payment_status,fulfillment_status,ship_address,items:order_items(name,qty,unit_price,product:products(category:categories(name)))')
      .gte('placed_at', since)
      .order('placed_at')
      .then(({ data, error }) => {
        if (error) setErr(error.message);
        else setRows((data ?? []) as unknown as Row[]);
        setLoading(false);
      });
  }, [days]);

  const paid = useMemo(() => rows.filter(r => r.payment_status === 'paid'), [rows]);

  // Revenue by day (paid orders only), with zero-filled days.
  const byDay: BarDatum[] = useMemo(() => {
    const map = new Map<string, number>();
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86400000);
      map.set(d.toISOString().slice(0, 10), 0);
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
  }, [paid, days]);

  // Payment method split (paid revenue).
  const byMethod = useMemo(() => {
    const sum = (m: Row['payment_method']) => paid.filter(o => o.payment_method === m).reduce((n, o) => n + Number(o.total), 0);
    return [
      { label: 'Bank transfer slip', value: Math.round(sum('bank_slip')), color: SERIES_1 },
      { label: 'Chapa', value: Math.round(sum('chapa')), color: SERIES_2 },
    ];
  }, [paid]);

  // Fulfillment funnel — how many orders have reached at least each stage.
  const funnel = useMemo(() => {
    const reached = (idx: number) => rows.filter(r => {
      const i = FUNNEL.findIndex(f => f.key === r.fulfillment_status);
      return i >= idx;
    }).length;
    return FUNNEL.map((f, i) => ({ label: f.label, value: i === 0 ? rows.filter(r => r.fulfillment_status !== 'cancelled').length : reached(i) }));
  }, [rows]);

  // Product & category league tables (paid orders).
  const { byProduct, byCategory } = useMemo(() => {
    const prod = new Map<string, { qty: number; revenue: number }>();
    const cat = new Map<string, { qty: number; revenue: number }>();
    for (const o of paid) {
      for (const it of o.items ?? []) {
        const rev = Number(it.unit_price) * it.qty;
        const p = prod.get(it.name) ?? { qty: 0, revenue: 0 };
        p.qty += it.qty; p.revenue += rev; prod.set(it.name, p);
        const cname = it.product?.category?.name ?? 'Uncategorised';
        const cg = cat.get(cname) ?? { qty: 0, revenue: 0 };
        cg.qty += it.qty; cg.revenue += rev; cat.set(cname, cg);
      }
    }
    const sort = (m: Map<string, { qty: number; revenue: number }>) =>
      [...m.entries()].sort((a, b) => b[1].revenue - a[1].revenue);
    return { byProduct: sort(prod), byCategory: sort(cat) };
  }, [paid]);

  const exportCsv = () => {
    const head = 'order,placed_at,total,payment_method,payment_status,fulfillment_status,address';
    const esc = (s: string) => `"${s.replace(/"/g, '""')}"`;
    const lines = rows.map(o =>
      [o.human_id, o.placed_at, o.total, o.payment_method, o.payment_status, o.fulfillment_status, esc(o.ship_address ?? '')].join(','));
    const blob = new Blob([[head, ...lines].join('\n')], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `melelo-orders-${days}d.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const revenue = paid.reduce((n, o) => n + Number(o.total), 0);

  return (
    <PageScaffold
      title="Reports"
      subtitle={`${money(revenue)} paid revenue · ${rows.length} orders in range`}
      actions={
        <div className="flex items-center gap-2">
          {RANGES.map(r => (
            <button key={r.days} onClick={() => setDays(r.days)}
              className={`px-3.5 py-1.5 rounded-full text-xs font-semibold transition-colors ${days === r.days ? 'bg-orange-500 text-black' : 'bg-white/5 text-zinc-300 hover:bg-white/10'}`}>
              {r.label}
            </button>
          ))}
          <button onClick={exportCsv} disabled={rows.length === 0}
            className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-xs font-semibold bg-white/5 text-zinc-300 hover:bg-white/10 transition-colors disabled:opacity-40">
            <Download size={13} /> CSV
          </button>
        </div>
      }
    >
      {err && <div className="mb-4 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">{err}</div>}
      {loading ? (
        <p className="text-sm text-zinc-500">Loading…</p>
      ) : rows.length === 0 ? (
        <EmptyState icon={BarChart3} title="No orders in this range" hint="Reports fill in as orders come through the storefront." />
      ) : (
        <div className="grid lg:grid-cols-2 gap-4">
          <div className="lg:col-span-2">
            <ChartCard title="Paid revenue by day" sub={`Last ${days} days`}>
              <Bars data={byDay} money />
            </ChartCard>
          </div>

          <ChartCard title="Revenue by payment method" sub="Paid orders">
            <HBarList rows={byMethod} money />
          </ChartCard>

          <ChartCard title="Fulfillment funnel" sub="Orders that reached each stage (cancelled excluded)">
            <HBarList rows={funnel} />
          </ChartCard>

          <ChartCard title="Top products" sub="Paid revenue">
            <table className="w-full text-sm">
              <tbody>
                {byProduct.slice(0, 8).map(([name, v]) => (
                  <tr key={name} className="border-b border-white/5 last:border-0">
                    <td className="py-2 font-medium">{name}</td>
                    <td className="py-2 text-zinc-400 text-right">×{v.qty}</td>
                    <td className="py-2 font-semibold text-right w-24">{money(v.revenue)}</td>
                  </tr>
                ))}
                {byProduct.length === 0 && <tr><td className="py-4 text-zinc-500 text-center">No paid sales yet.</td></tr>}
              </tbody>
            </table>
          </ChartCard>

          <ChartCard title="Sales by category" sub="Paid revenue">
            <HBarList rows={byCategory.map(([name, v]) => ({ label: name, value: Math.round(v.revenue), sub: `×${v.qty}` }))} money />
          </ChartCard>
        </div>
      )}
    </PageScaffold>
  );
}
