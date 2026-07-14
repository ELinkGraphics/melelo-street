import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Factory, Loader2, Send as SendIcon, X, CalendarDays, CheckCircle2 } from 'lucide-react';
import { requireSupabase } from '../lib/supabase';
import { fmtMoney } from '../lib/currency';

// Vendor job queue: list + drawer with items, one primary status action and
// the shared comment thread. The vendor's writes go exclusively through the
// vendor_update_job / production_comment RPCs (legal transitions enforced
// server-side); everything shown here is a production snapshot — no customer
// data exists in these tables.

export type Job = {
  id: string; human_id: string;
  status: 'sent' | 'accepted' | 'printing' | 'ready' | 'delivered' | 'cancelled';
  due_date: string | null; note: string | null;
  unit_total: number; cost_total: number;
  paid: boolean; created_at: string;
};
export type JobItem = {
  id: string; name: string; color: string; size: string;
  qty: number; image: string | null; unit_cost: number;
};
export type JobEvent = {
  id: string; author: 'admin' | 'vendor'; status: string | null;
  note: string | null; created_at: string;
};

export const JOB_TONE: Record<Job['status'], string> = {
  sent: 'bg-amber-500/15 text-amber-400',
  accepted: 'bg-orange-500/15 text-orange-400',
  printing: 'bg-sky-500/15 text-sky-400',
  ready: 'bg-green-500/15 text-green-400',
  delivered: 'bg-white/10 text-zinc-300',
  cancelled: 'bg-red-500/15 text-red-400',
};

export function JobPill({ status }: { status: Job['status'] }) {
  return (
    <span className={`text-[11px] font-semibold uppercase tracking-wider px-2.5 py-1 rounded-full ${JOB_TONE[status]}`}>
      {status}
    </span>
  );
}

export const fmtWhen = (s: string) =>
  new Date(s).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
export const fmtDue = (s: string) =>
  new Date(s + 'T00:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

const ACTIVE: Job['status'][] = ['sent', 'accepted', 'printing', 'ready'];

// The vendor's single primary action per state (server re-validates).
const NEXT_ACTION: Partial<Record<Job['status'], { to: string; label: string }>> = {
  sent: { to: 'accepted', label: 'Accept job' },
  accepted: { to: 'printing', label: 'Start printing' },
  printing: { to: 'ready', label: 'Mark ready for pickup' },
};

export function JobsPage() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [tab, setTab] = useState<'active' | 'delivered' | 'all'>('active');
  const [openId, setOpenId] = useState<string | null>(null);

  const load = async () => {
    try {
      const { data, error } = await requireSupabase()
        .from('production_jobs').select('*').order('created_at', { ascending: false }).limit(200);
      if (error) throw error;
      setJobs((data ?? []) as Job[]);
      setErr(null);
    } catch (e: any) { setErr(e.message ?? String(e)); }
    finally { setLoading(false); }
  };
  useEffect(() => {
    load();
    const id = window.setInterval(load, 10000);
    return () => window.clearInterval(id);
  }, []);

  const active = jobs.filter(j => ACTIVE.includes(j.status));
  const unpaidDelivered = jobs.filter(j => j.status === 'delivered' && !j.paid)
    .reduce((n, j) => n + Number(j.cost_total), 0);
  const visible = tab === 'active' ? active
    : tab === 'delivered' ? jobs.filter(j => j.status === 'delivered')
    : jobs;
  const open = jobs.find(j => j.id === openId) ?? null;

  return (
    <div className="max-w-4xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight">Production jobs</h1>
        <p className="text-sm text-zinc-400 mt-1">Jobs from Melelo Brands — accept, print, mark ready; we confirm receipt.</p>
      </div>

      {err && <div className="mb-4 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">{err}</div>}

      <div className="grid grid-cols-3 gap-3 mb-6">
        <Stat label="Active jobs" value={String(active.length)} />
        <Stat label="Pieces in production" value={String(active.reduce((n, j) => n + j.unit_total, 0))} />
        <Stat label="Delivered · unpaid" value={fmtMoney(unpaidDelivered)} accent={unpaidDelivered > 0} />
      </div>

      <div className="flex gap-2 mb-4">
        {([['active', 'Active'], ['delivered', 'Delivered'], ['all', 'All']] as const).map(([key, label]) => (
          <button key={key} onClick={() => setTab(key)}
            className={`px-4 py-2 rounded-full text-sm font-semibold transition-colors ${tab === key ? 'bg-orange-500 text-black' : 'bg-white/5 text-zinc-300 hover:bg-white/10'}`}>
            {label}
          </button>
        ))}
      </div>

      {loading ? (
        <p className="text-sm text-zinc-500">Loading…</p>
      ) : visible.length === 0 ? (
        <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-12 flex flex-col items-center text-center gap-3">
          <Factory size={40} className="text-zinc-600" />
          <p className="font-medium">No {tab === 'all' ? '' : tab + ' '}jobs</p>
          <p className="text-sm text-zinc-500 max-w-sm">New production jobs from Melelo will appear here — you'll also get a Telegram message.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {visible.map(j => (
            <button key={j.id} onClick={() => setOpenId(j.id)}
              className="w-full text-left rounded-2xl border border-white/10 bg-white/[0.03] hover:bg-white/[0.06] transition-colors p-4 flex flex-wrap items-center gap-x-4 gap-y-2">
              <span className="font-mono text-sm font-semibold">{j.human_id}</span>
              <JobPill status={j.status} />
              {j.status === 'delivered' && (
                <span className={`text-[11px] font-semibold uppercase tracking-wider px-2.5 py-1 rounded-full ${j.paid ? 'bg-green-500/15 text-green-400' : 'bg-amber-500/15 text-amber-400'}`}>
                  {j.paid ? 'Paid' : 'Awaiting payment'}
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
              {j.note && <span className="w-full text-xs text-zinc-500 truncate">{j.note}</span>}
            </button>
          ))}
        </div>
      )}

      {open && <JobDrawer job={open} role="vendor" onClose={() => setOpenId(null)} onChanged={load} />}
    </div>
  );
}

// Admin-only inline unit-cost editor (RLS admin-all covers the direct update).
function CostInput({ value, onCommit }: { value: number; onCommit: (v: number) => void }) {
  const [v, setV] = useState(String(value));
  useEffect(() => { setV(String(value)); }, [value]);
  return (
    <input
      type="number" min={0} step="0.5" value={v}
      onChange={e => setV(e.target.value)}
      onBlur={() => { const n = Math.max(0, Number(v) || 0); if (n !== value) onCommit(n); }}
      className="w-20 bg-white/5 border border-white/15 rounded-lg px-2 py-1 text-right text-sm outline-none focus:border-orange-500 tabular-nums"
    />
  );
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className={`rounded-2xl border p-4 ${accent ? 'border-orange-500/40 bg-orange-500/10' : 'border-white/10 bg-white/[0.03]'}`}>
      <p className="text-[11px] uppercase tracking-wider text-zinc-400">{label}</p>
      <p className="text-xl font-bold mt-1.5 leading-none tabular-nums">{value}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Job drawer — shared by the vendor app and Admin → Production (role prop
// switches which actions render; data access is enforced by RLS/RPC anyway).
// ---------------------------------------------------------------------------
export function JobDrawer({
  job, role, onClose, onChanged, adminActions,
}: {
  job: Job;
  role: 'vendor' | 'admin';
  onClose: () => void;
  onChanged: () => void;
  adminActions?: React.ReactNode;
}) {
  const [items, setItems] = useState<JobItem[]>([]);
  const [events, setEvents] = useState<JobEvent[]>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  const loadDetail = async () => {
    const sb = requireSupabase();
    const [it, ev] = await Promise.all([
      sb.from('production_job_items').select('*').eq('job_id', job.id).order('name'),
      sb.from('production_events').select('*').eq('job_id', job.id).order('created_at'),
    ]);
    setItems((it.data ?? []) as JobItem[]);
    setEvents((ev.data ?? []) as JobEvent[]);
  };
  useEffect(() => {
    loadDetail();
    const id = window.setInterval(loadDetail, 10000);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job.id]);
  useEffect(() => { bottomRef.current?.scrollIntoView({ block: 'end' }); }, [events.length]);

  const advance = async (to: string, label: string) => {
    if (!window.confirm(`${label} — ${job.human_id}?`)) return;
    setBusy(true); setErr(null);
    const { error } = await requireSupabase().rpc('vendor_update_job', { p_id: job.id, p_status: to });
    setBusy(false);
    if (error) { setErr(error.message); return; }
    onChanged(); loadDetail();
  };

  const comment = async () => {
    if (!draft.trim() || busy) return;
    setBusy(true); setErr(null);
    const { error } = await requireSupabase().rpc('production_comment', { p_id: job.id, p_note: draft.trim() });
    setBusy(false);
    if (error) { setErr(error.message); return; }
    setDraft('');
    loadDetail();
  };

  const action = role === 'vendor' ? NEXT_ACTION[job.status] : undefined;
  const mySide = role; // thread alignment

  return (
    <div className="fixed inset-0 z-[60] flex justify-end">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className="relative w-full max-w-xl bg-zinc-950 border-l border-white/10 h-full flex flex-col">
        <header className="h-16 shrink-0 flex items-center gap-3 px-5 border-b border-white/10">
          <h2 className="font-mono font-semibold">{job.human_id}</h2>
          <JobPill status={job.status} />
          {job.paid && <span className="inline-flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wider text-green-400"><CheckCircle2 size={12} /> Paid</span>}
          <button onClick={onClose} aria-label="Close" className="ml-auto"><X size={20} className="text-zinc-400 hover:text-white" /></button>
        </header>

        <div className="flex-1 overflow-y-auto p-5 space-y-5">
          {err && <div className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">{err}</div>}

          <div className="flex flex-wrap gap-x-5 gap-y-1 text-sm text-zinc-400">
            {job.due_date && <span className="inline-flex items-center gap-1.5"><CalendarDays size={14} /> Due {fmtDue(job.due_date)}</span>}
            <span>{job.unit_total} piece(s)</span>
            <span className="font-semibold text-white">{fmtMoney(Number(job.cost_total))}</span>
          </div>
          {job.note && <p className="text-sm text-zinc-300 bg-white/5 rounded-xl px-3.5 py-2.5">{job.note}</p>}

          {/* Items */}
          <div className="rounded-2xl border border-white/10 overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-white/5 text-zinc-400 text-xs uppercase tracking-wider">
                <tr>
                  <th className="text-left font-medium px-4 py-2.5">Item</th>
                  <th className="text-center font-medium px-2 py-2.5">Qty</th>
                  <th className="text-right font-medium px-4 py-2.5">Unit</th>
                  <th className="text-right font-medium px-4 py-2.5">Total</th>
                </tr>
              </thead>
              <tbody>
                {items.map(it => (
                  <tr key={it.id} className="border-t border-white/5">
                    <td className="px-4 py-2.5">
                      <span className="flex items-center gap-3">
                        <span className="w-10 h-10 rounded-lg bg-black/40 overflow-hidden flex items-center justify-center shrink-0">
                          {it.image && <img src={it.image} alt="" loading="lazy" decoding="async" className="w-full h-full object-contain" />}
                        </span>
                        <span>
                          {it.name}
                          <span className="block text-xs text-zinc-500">{it.color} · {it.size}</span>
                        </span>
                      </span>
                    </td>
                    <td className="px-2 py-2.5 text-center font-semibold">{it.qty}</td>
                    <td className="px-4 py-2.5 text-right text-zinc-400">
                      {role === 'admin'
                        ? <CostInput value={Number(it.unit_cost)} onCommit={async v => {
                            await requireSupabase().from('production_job_items').update({ unit_cost: v }).eq('id', it.id);
                            loadDetail(); onChanged();
                          }} />
                        : fmtMoney(Number(it.unit_cost))}
                    </td>
                    <td className="px-4 py-2.5 text-right font-semibold">{fmtMoney(Number(it.unit_cost) * it.qty)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Thread */}
          <div>
            <p className="text-xs font-semibold uppercase tracking-wider text-zinc-400 mb-2">Thread</p>
            <div className="space-y-2">
              {events.map(ev => (
                <div key={ev.id} className={`flex ${ev.author === mySide ? 'justify-end' : 'justify-start'}`}>
                  <div className={`max-w-[80%] rounded-2xl px-3.5 py-2 text-sm whitespace-pre-wrap break-words ${
                    ev.author === mySide ? 'bg-orange-500 text-black rounded-br-sm' : 'bg-white/10 text-zinc-100 rounded-bl-sm'
                  }`}>
                    {ev.status && <span className="block text-[10px] font-bold uppercase tracking-wider opacity-70">{ev.status}</span>}
                    {ev.note}
                    <span className={`block text-[10px] mt-1 ${ev.author === mySide ? 'text-black/50' : 'text-zinc-500'}`}>
                      {ev.author} · {fmtWhen(ev.created_at)}
                    </span>
                  </div>
                </div>
              ))}
              <div ref={bottomRef} />
            </div>
          </div>
        </div>

        <footer className="shrink-0 border-t border-white/10 p-4 space-y-3">
          {action && (
            <button onClick={() => advance(action.to, action.label)} disabled={busy}
              className="w-full bg-orange-500 text-black py-3 rounded-full font-bold uppercase tracking-wide text-sm hover:bg-orange-400 transition-colors disabled:opacity-50">
              {action.label}
            </button>
          )}
          {adminActions}
          <div className="flex gap-2">
            <input
              value={draft}
              onChange={e => setDraft(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); comment(); } }}
              placeholder="Write a message…"
              className="flex-1 bg-white/5 border border-white/15 rounded-xl px-3 py-2.5 text-sm outline-none focus:border-orange-500 transition-colors placeholder:text-zinc-500"
            />
            <button onClick={comment} disabled={busy || !draft.trim()}
              className="shrink-0 inline-flex items-center gap-1.5 bg-white/10 text-white font-bold text-sm px-4 rounded-xl hover:bg-white/20 transition-colors disabled:opacity-40">
              {busy ? <Loader2 size={15} className="animate-spin" /> : <SendIcon size={15} />}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
