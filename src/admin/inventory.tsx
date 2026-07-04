import React, { useCallback, useEffect, useState } from 'react';
import { Boxes, Minus, Plus, AlertTriangle, Search } from 'lucide-react';
import { requireSupabase } from '../lib/supabase';
import { PageScaffold, EmptyState } from './ui';

type Row = {
  id: string;
  size: string;
  stock_qty: number;
  low_stock_threshold: number;
  variant: { id: string; color_name: string; color_hex: string; product: { id: string; name: string } };
};

export function InventoryPage() {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [lowOnly, setLowOnly] = useState(false);
  const [query, setQuery] = useState('');
  const [savingId, setSavingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setErr(null);
    try {
      const { data, error } = await requireSupabase()
        .from('inventory')
        .select('id,size,stock_qty,low_stock_threshold,variant:product_variants!inner(id,color_name,color_hex,product:products!inner(id,name))')
        .order('size');
      if (error) throw error;
      const sorted = ((data ?? []) as unknown as Row[]).sort((a, b) =>
        a.variant.product.name.localeCompare(b.variant.product.name) ||
        a.variant.color_name.localeCompare(b.variant.color_name) ||
        'SMLX'.indexOf(a.size[0]) - 'SMLX'.indexOf(b.size[0]));
      setRows(sorted);
    } catch (e: any) { setErr(e.message ?? String(e)); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  // Optimistic set with server write; reverts on failure.
  const setStock = async (row: Row, qty: number) => {
    const next = Math.max(0, qty);
    setSavingId(row.id);
    const prevRows = rows;
    setRows(rs => rs.map(r => r.id === row.id ? { ...r, stock_qty: next } : r));
    const { error } = await requireSupabase().from('inventory').update({ stock_qty: next }).eq('id', row.id);
    if (error) { setErr(error.message); setRows(prevRows); }
    setSavingId(null);
  };

  const q = query.trim().toLowerCase();
  const filtered = rows.filter(r =>
    (!lowOnly || r.stock_qty <= r.low_stock_threshold) &&
    (!q || r.variant.product.name.toLowerCase().includes(q) || r.variant.color_name.toLowerCase().includes(q)));
  const lowCount = rows.filter(r => r.stock_qty <= r.low_stock_threshold).length;

  return (
    <PageScaffold
      title="Inventory"
      subtitle={lowCount > 0 ? `${lowCount} size(s) at or below their low-stock threshold` : 'Stock levels are healthy'}
    >
      {err && <div className="mb-4 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">{err}</div>}

      <div className="flex flex-wrap items-center gap-2 mb-4">
        <button onClick={() => setLowOnly(false)}
          className={`px-3.5 py-1.5 rounded-full text-xs font-semibold transition-colors ${!lowOnly ? 'bg-orange-500 text-black' : 'bg-white/5 text-zinc-300 hover:bg-white/10'}`}>
          All
        </button>
        <button onClick={() => setLowOnly(true)}
          className={`inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-xs font-semibold transition-colors ${lowOnly ? 'bg-amber-500 text-black' : 'bg-white/5 text-zinc-300 hover:bg-white/10'}`}>
          <AlertTriangle size={12} /> Low stock {lowCount > 0 && `(${lowCount})`}
        </button>
        <div className="ml-auto flex items-center gap-2 rounded-full bg-white/5 border border-white/10 px-3 py-1.5 text-sm">
          <Search size={14} className="text-zinc-500" />
          <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Product or color…"
            className="bg-transparent outline-none w-44 placeholder:text-zinc-500" />
        </div>
      </div>

      {loading ? (
        <p className="text-sm text-zinc-500">Loading…</p>
      ) : filtered.length === 0 ? (
        <EmptyState icon={Boxes} title={lowOnly ? 'Nothing is low on stock' : 'No inventory rows'} hint={lowOnly ? 'All sizes are above their thresholds.' : 'Add products with variants to track stock.'} />
      ) : (
        <div className="rounded-2xl border border-white/10 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-white/5 text-zinc-400 text-xs uppercase tracking-wider">
              <tr>
                <th className="text-left font-medium px-4 py-3">Product</th>
                <th className="text-left font-medium px-4 py-3">Color</th>
                <th className="text-left font-medium px-4 py-3">Size</th>
                <th className="text-left font-medium px-4 py-3">Stock</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(r => {
                const low = r.stock_qty <= r.low_stock_threshold;
                return (
                  <tr key={r.id} className={`border-t border-white/5 ${low ? 'bg-amber-500/[0.04]' : ''}`}>
                    <td className="px-4 py-2.5 font-medium">{r.variant.product.name}</td>
                    <td className="px-4 py-2.5">
                      <span className="inline-flex items-center gap-2 text-zinc-300">
                        <span className="w-3.5 h-3.5 rounded-full border border-white/20 inline-block" style={{ backgroundColor: r.variant.color_hex }} />
                        {r.variant.color_name}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-zinc-300">{r.size}</td>
                    <td className="px-4 py-2.5">
                      <div className="flex items-center gap-2">
                        <button onClick={() => setStock(r, r.stock_qty - 1)} disabled={savingId === r.id || r.stock_qty === 0}
                          aria-label="Decrease stock"
                          className="w-7 h-7 rounded-lg bg-white/5 hover:bg-white/15 flex items-center justify-center text-zinc-300 disabled:opacity-30 transition-colors"><Minus size={13} /></button>
                        <input
                          type="number" min={0} value={r.stock_qty}
                          onChange={e => setStock(r, Number(e.target.value))}
                          className={`w-16 text-center bg-white/5 border rounded-lg py-1 text-sm outline-none focus:border-orange-500 ${low ? 'border-amber-500/50 text-amber-300' : 'border-white/15'}`}
                        />
                        <button onClick={() => setStock(r, r.stock_qty + 1)} disabled={savingId === r.id}
                          aria-label="Increase stock"
                          className="w-7 h-7 rounded-lg bg-white/5 hover:bg-white/15 flex items-center justify-center text-zinc-300 transition-colors"><Plus size={13} /></button>
                        {low && <AlertTriangle size={14} className="text-amber-400" />}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </PageScaffold>
  );
}
