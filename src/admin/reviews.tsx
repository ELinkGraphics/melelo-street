import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Star, RefreshCw, Loader2, Check, X, Trash2, Ticket } from 'lucide-react';
import { requireSupabase } from '../lib/supabase';
import { PageScaffold, EmptyState } from './ui';

type Review = {
  id: string;
  order_id: string;
  product_id: string;
  rating: number;
  body: string | null;
  photos: string[];
  reviewer_name: string | null;
  status: 'pending' | 'approved' | 'rejected';
  reward_code: string | null;
  created_at: string;
  product: { name: string } | null;
  order: { human_id: string } | null;
};

type Tab = 'pending' | 'approved' | 'rejected';

const fmtDate = (s: string) =>
  new Date(s).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

function Stars({ value }: { value: number }) {
  return (
    <div className="flex items-center gap-0.5 text-orange-400">
      {[1, 2, 3, 4, 5].map(n => (
        <Star key={n} size={14} fill={n <= value ? 'currentColor' : 'none'}
          className={n <= value ? '' : 'text-zinc-600'} />
      ))}
    </div>
  );
}

export function ReviewsPage() {
  const [rows, setRows] = useState<Review[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('pending');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [lightbox, setLightbox] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const { data, error } = await requireSupabase()
        .from('reviews')
        .select('*, product:products(name), order:orders(human_id)')
        .order('created_at', { ascending: false })
        .limit(300);
      if (error) throw error;
      setRows((data ?? []) as Review[]);
      setErr(null);
    } catch (e: any) { setErr(e.message ?? String(e)); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => {
    load();
    const id = window.setInterval(load, 10000);
    return () => window.clearInterval(id);
  }, [load]);

  const counts = useMemo(() => {
    const c = { pending: 0, approved: 0, rejected: 0 };
    for (const r of rows) c[r.status] += 1;
    return c;
  }, [rows]);
  const visible = rows.filter(r => r.status === tab);

  const moderate = async (r: Review, approve: boolean) => {
    setBusyId(r.id); setErr(null);
    const { error } = await requireSupabase().rpc('approve_review', { p_id: r.id, p_approve: approve });
    setBusyId(null);
    if (error) { setErr(error.message); return; }
    load();
  };

  const remove = async (r: Review) => {
    if (!window.confirm('Delete this review permanently?')) return;
    setBusyId(r.id); setErr(null);
    const { error } = await requireSupabase().from('reviews').delete().eq('id', r.id);
    setBusyId(null);
    if (error) { setErr(error.message); return; }
    load();
  };

  const TABS: { key: Tab; label: string }[] = [
    { key: 'pending', label: `Pending${counts.pending ? ` (${counts.pending})` : ''}` },
    { key: 'approved', label: `Approved${counts.approved ? ` (${counts.approved})` : ''}` },
    { key: 'rejected', label: `Rejected${counts.rejected ? ` (${counts.rejected})` : ''}` },
  ];

  return (
    <PageScaffold
      title="Reviews"
      subtitle={counts.pending > 0
        ? `${counts.pending} review${counts.pending > 1 ? 's' : ''} awaiting approval`
        : 'Customer product reviews — approved ones show on the storefront'}
      actions={
        <button onClick={load} className="inline-flex items-center gap-2 text-sm font-semibold text-zinc-300 hover:text-white px-3 py-2 rounded-xl hover:bg-white/10 transition-colors">
          <RefreshCw size={15} /> Refresh
        </button>
      }
    >
      {err && <div className="mb-4 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">{err}</div>}

      <div className="flex gap-2 mb-5">
        {TABS.map(t => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`px-4 py-2 rounded-full text-sm font-semibold transition-colors ${
              tab === t.key ? 'bg-orange-500 text-black' : 'bg-white/5 text-zinc-300 hover:bg-white/10'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {loading ? (
        <p className="text-sm text-zinc-500">Loading…</p>
      ) : visible.length === 0 ? (
        <EmptyState icon={Star} title={`No ${tab} reviews`}
          hint={tab === 'pending'
            ? 'When delivered customers rate their items, new reviews land here for approval.'
            : 'Nothing here yet.'} />
      ) : (
        <div className="space-y-3">
          {visible.map(r => (
            <div key={r.id} className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <Stars value={r.rating} />
                <span className="font-semibold text-sm">{r.product?.name ?? 'Deleted product'}</span>
                <span className="text-xs text-zinc-500">
                  by {r.reviewer_name || 'Verified buyer'} · <span className="font-mono">{r.order?.human_id ?? '—'}</span> · {fmtDate(r.created_at)}
                </span>
                {r.reward_code && (
                  <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-orange-300 bg-orange-500/10 border border-orange-500/30 rounded-full px-2 py-0.5">
                    <Ticket size={11} /> {r.reward_code}
                  </span>
                )}
              </div>

              {r.body && <p className="text-sm text-zinc-300 mt-2.5 leading-relaxed whitespace-pre-wrap">{r.body}</p>}

              {r.photos?.length > 0 && (
                <div className="flex gap-2 mt-3">
                  {r.photos.map(url => (
                    <button key={url} onClick={() => setLightbox(url)}
                      className="w-16 h-16 rounded-lg overflow-hidden bg-black/40 border border-white/10 hover:border-orange-500/60 transition-colors">
                      <img src={url} alt="" loading="lazy" decoding="async" className="w-full h-full object-cover" />
                    </button>
                  ))}
                </div>
              )}

              <div className="flex items-center gap-2 mt-4">
                {r.status !== 'approved' && (
                  <button onClick={() => moderate(r, true)} disabled={busyId === r.id}
                    className="inline-flex items-center gap-1.5 bg-emerald-500 text-black font-bold text-xs uppercase tracking-wide px-4 py-2 rounded-full hover:bg-emerald-400 transition-colors disabled:opacity-50">
                    {busyId === r.id ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />} Approve
                  </button>
                )}
                {r.status !== 'rejected' && (
                  <button onClick={() => moderate(r, false)} disabled={busyId === r.id}
                    className="inline-flex items-center gap-1.5 bg-white/10 text-zinc-200 font-bold text-xs uppercase tracking-wide px-4 py-2 rounded-full hover:bg-white/20 transition-colors disabled:opacity-50">
                    <X size={13} /> Reject
                  </button>
                )}
                <button onClick={() => remove(r)} disabled={busyId === r.id}
                  className="ml-auto inline-flex items-center gap-1.5 text-xs font-semibold text-zinc-500 hover:text-red-400 px-3 py-2 transition-colors disabled:opacity-50">
                  <Trash2 size={13} /> Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {lightbox && (
        <div className="fixed inset-0 z-[100] bg-black/90 flex items-center justify-center p-6 cursor-zoom-out" onClick={() => setLightbox(null)}>
          <img src={lightbox} alt="" className="max-w-full max-h-full rounded-xl object-contain" />
        </div>
      )}
    </PageScaffold>
  );
}
