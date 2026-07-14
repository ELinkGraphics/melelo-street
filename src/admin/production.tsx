import React, { useEffect, useState } from 'react';
import { Factory, Loader2, Plus, CalendarDays } from 'lucide-react';
import { requireSupabase } from '../lib/supabase';
import { fmtMoney } from '../lib/currency';
import { PageScaffold, EmptyState } from './ui';
import { JobDrawer, JobPill, fmtDue, type Job } from '../vendor/jobs';

// Admin → Production: batch paid orders into a job for the vendor, follow the
// queue, confirm receipt (Delivered), push linked orders to "packed", settle
// (mark paid). The drawer (items, thread, inline unit costs) is shared with
// the vendor app — role="admin" unlocks the admin affordances.

type PendingOrder = {
  id: string; human_id: string; placed_at: string; total: number;
  fulfillment_status: string;
};

const input = 'bg-white/5 border border-white/15 rounded-xl px-3 py-2.5 text-sm outline-none focus:border-orange-500 transition-colors placeholder:text-zinc-500';

export function ProductionPage() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [pending, setPending] = useState<PendingOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  // New-job form
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [due, setDue] = useState('');
  const [note, setNote] = useState('');
  const [unitCost, setUnitCost] = useState('');
  const [creating, setCreating] = useState(false);

  const load = async () => {
    try {
      const sb = requireSupabase();
      const [j, o] = await Promise.all([
        sb.from('production_jobs').select('*').order('created_at', { ascending: false }).limit(200),
        sb.from('orders')
          .select('id,human_id,placed_at,total,fulfillment_status')
          .eq('payment_status', 'paid')
          .is('production_job_id', null)
          .not('fulfillment_status', 'in', '("cancelled","delivered")')
          .order('placed_at'),
      ]);
      if (j.error) throw j.error;
      if (o.error) throw o.error;
      setJobs((j.data ?? []) as Job[]);
      setPending((o.data ?? []) as PendingOrder[]);
      setErr(null);
    } catch (e: any) { setErr(e.message ?? String(e)); }
    finally { setLoading(false); }
  };
  useEffect(() => {
    load();
    const id = window.setInterval(load, 10000);
    return () => window.clearInterval(id);
  }, []);

  const toggle = (id: string) => setSel(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const createJob = async () => {
    if (sel.size === 0 || creating) return;
    setCreating(true); setErr(null);
    const { data, error } = await requireSupabase().rpc('create_production_job', {
      p_order_ids: [...sel],
      p_due: due || null,
      p_note: note.trim() || null,
      p_unit_cost: Math.max(0, Number(unitCost) || 0),
    });
    setCreating(false);
    if (error) { setErr(error.message); return; }
    setSel(new Set()); setDue(''); setNote(''); setUnitCost('');
    await load();
    setOpenId((data as any)?.id ?? null);
  };

  const unpaidDelivered = jobs.filter(j => j.status === 'delivered' && !j.paid)
    .reduce((n, j) => n + Number(j.cost_total), 0);
  const open = jobs.find(j => j.id === openId) ?? null;

  return (
    <PageScaffold
      title="Production"
      subtitle={unpaidDelivered > 0
        ? `Owed to vendor for delivered jobs: ${fmtMoney(unpaidDelivered)}`
        : 'Send paid orders to your production partner and track the work'}
    >
      {err && <div className="mb-4 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">{err}</div>}

      {/* New job — paid orders not yet in production */}
      <section className="rounded-2xl border border-white/10 bg-white/[0.03] p-5 mb-6">
        <h3 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-zinc-400 mb-1">
          <Plus size={15} /> New production job
        </h3>
        <p className="text-xs text-zinc-400 mb-4">Select paid orders to bundle — the vendor sees aggregated items only (never customer details).</p>

        {pending.length === 0 ? (
          <p className="text-sm text-zinc-500">No paid orders are waiting for production.</p>
        ) : (
          <>
            <div className="rounded-xl border border-white/10 overflow-x-auto mb-4 max-h-64 overflow-y-auto">
              <table className="w-full text-sm">
                <tbody>
                  {pending.map(o => (
                    <tr key={o.id} onClick={() => toggle(o.id)}
                      className="border-b border-white/5 last:border-0 hover:bg-white/[0.04] cursor-pointer">
                      <td className="px-4 py-2.5 w-10">
                        <input type="checkbox" readOnly checked={sel.has(o.id)} className="accent-orange-500" />
                      </td>
                      <td className="px-2 py-2.5 font-mono text-xs">{o.human_id}</td>
                      <td className="px-4 py-2.5 text-zinc-400 hidden sm:table-cell">{new Date(o.placed_at).toLocaleDateString()}</td>
                      <td className="px-4 py-2.5 text-right font-semibold">{fmtMoney(Number(o.total))}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex flex-wrap items-end gap-3">
              <div>
                <label className="block text-xs text-zinc-400 mb-1.5">Due date</label>
                <input type="date" className={input} value={due} onChange={e => setDue(e.target.value)} />
              </div>
              <div>
                <label className="block text-xs text-zinc-400 mb-1.5">Unit cost (per piece)</label>
                <input type="number" min={0} step="0.5" placeholder="e.g. 120" className={`${input} w-32`} value={unitCost} onChange={e => setUnitCost(e.target.value)} />
              </div>
              <div className="flex-1 min-w-[180px]">
                <label className="block text-xs text-zinc-400 mb-1.5">Note to vendor</label>
                <input className={`${input} w-full`} placeholder="e.g. rush batch — event on Saturday" value={note} onChange={e => setNote(e.target.value)} />
              </div>
              <button onClick={createJob} disabled={sel.size === 0 || creating}
                className="inline-flex items-center gap-2 bg-orange-500 text-black font-bold text-sm px-5 py-2.5 rounded-xl hover:bg-orange-400 transition-colors disabled:opacity-40">
                {creating ? <Loader2 size={15} className="animate-spin" /> : <Factory size={15} />}
                Send {sel.size > 0 ? `${sel.size} order(s)` : ''} to production
              </button>
            </div>
          </>
        )}
      </section>

      {/* Jobs */}
      {loading ? (
        <p className="text-sm text-zinc-500">Loading…</p>
      ) : jobs.length === 0 ? (
        <EmptyState icon={Factory} title="No production jobs yet"
          hint="Bundle paid orders above and your vendor gets the job (plus a Telegram message) instantly." />
      ) : (
        <div className="space-y-3">
          {jobs.map(j => (
            <button key={j.id} onClick={() => setOpenId(j.id)}
              className="w-full text-left rounded-2xl border border-white/10 bg-white/[0.03] hover:bg-white/[0.06] transition-colors p-4 flex flex-wrap items-center gap-x-4 gap-y-2">
              <span className="font-mono text-sm font-semibold">{j.human_id}</span>
              <JobPill status={j.status} />
              {j.status === 'delivered' && (
                <span className={`text-[11px] font-semibold uppercase tracking-wider px-2.5 py-1 rounded-full ${j.paid ? 'bg-green-500/15 text-green-400' : 'bg-amber-500/15 text-amber-400'}`}>
                  {j.paid ? 'Paid' : 'Unpaid'}
                </span>
              )}
              <span className="ml-auto flex items-center gap-4 text-sm">
                {j.due_date && (
                  <span className="inline-flex items-center gap-1.5 text-zinc-400 text-xs">
                    <CalendarDays size={13} /> due {fmtDue(j.due_date)}
                  </span>
                )}
                <span className="text-zinc-300">{j.unit_total} pcs</span>
                <span className="font-semibold">{fmtMoney(Number(j.cost_total))}</span>
              </span>
            </button>
          ))}
        </div>
      )}

      {open && (
        <JobDrawer
          job={open}
          role="admin"
          onClose={() => setOpenId(null)}
          onChanged={load}
          adminActions={<AdminJobActions job={open} onChanged={load} />}
        />
      )}
    </PageScaffold>
  );
}

function AdminJobActions({ job, onChanged }: { job: Job; onChanged: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const run = async (fn: string, confirmText: string | null, params: Record<string, unknown> = {}) => {
    if (confirmText && !window.confirm(confirmText)) return;
    setBusy(fn); setMsg(null);
    const { data, error } = await requireSupabase().rpc(fn, { p_id: job.id, ...params });
    setBusy(null);
    if (error) { setMsg(error.message); return; }
    if (fn === 'job_orders_packed') setMsg(`${(data as any)?.packed ?? 0} order(s) marked packed — customers notified.`);
    onChanged();
  };

  const active = !['delivered', 'cancelled'].includes(job.status);
  const btn = 'flex-1 min-w-[150px] inline-flex items-center justify-center gap-1.5 border font-semibold text-xs uppercase tracking-wide px-3 py-2.5 rounded-full transition-colors disabled:opacity-40';

  return (
    <div className="space-y-2">
      {msg && <p className="text-xs text-zinc-300 bg-white/5 rounded-lg px-3 py-2">{msg}</p>}
      <div className="flex flex-wrap gap-2">
        {active && (
          <button disabled={busy !== null} className={`${btn} border-green-500/40 text-green-300 hover:bg-green-500/15`}
            onClick={() => run('admin_receive_job', `Confirm you received the goods for ${job.human_id}?`)}>
            {busy === 'admin_receive_job' ? <Loader2 size={13} className="animate-spin" /> : null} Mark delivered
          </button>
        )}
        {job.status === 'delivered' && (
          <>
            <button disabled={busy !== null} className={`${btn} border-orange-500/40 text-orange-300 hover:bg-orange-500/15`}
              onClick={() => run('job_orders_packed', 'Advance this job’s confirmed orders to "packed"? Customers are notified.')}>
              {busy === 'job_orders_packed' ? <Loader2 size={13} className="animate-spin" /> : null} Mark orders packed
            </button>
            <button disabled={busy !== null} className={`${btn} ${job.paid ? 'border-white/20 text-zinc-300 hover:bg-white/10' : 'border-green-500/40 text-green-300 hover:bg-green-500/15'}`}
              onClick={() => run('job_mark_paid', job.paid ? 'Mark this job as UNPAID?' : `Mark ${fmtMoney(Number(job.cost_total))} as paid to the vendor?`, { p_paid: !job.paid })}>
              {busy === 'job_mark_paid' ? <Loader2 size={13} className="animate-spin" /> : null} {job.paid ? 'Mark unpaid' : 'Mark paid'}
            </button>
          </>
        )}
        {active && (
          <button disabled={busy !== null} className={`${btn} border-red-500/40 text-red-300 hover:bg-red-500/15`}
            onClick={() => run('admin_cancel_job', `Cancel ${job.human_id}? Its orders return to the production queue.`)}>
            {busy === 'admin_cancel_job' ? <Loader2 size={13} className="animate-spin" /> : null} Cancel job
          </button>
        )}
      </div>
    </div>
  );
}
