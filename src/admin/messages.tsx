import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MessageCircle, Send, Loader2, RefreshCw } from 'lucide-react';
import { requireSupabase } from '../lib/supabase';
import { PageScaffold, EmptyState } from './ui';

type Msg = {
  id: string;
  chat_id: number;
  username: string | null;
  first_name: string | null;
  text: string;
  direction: 'in' | 'out';
  read: boolean;
  created_at: string;
};

type Thread = {
  chatId: number;
  name: string;
  username: string | null;
  last: Msg;
  unread: number;
  messages: Msg[];
};

const fmtTime = (s: string) =>
  new Date(s).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

function groupThreads(rows: Msg[]): Thread[] {
  const map = new Map<number, Thread>();
  // rows arrive newest-first; build threads then sort each ascending for display.
  for (const m of rows) {
    const t = map.get(m.chat_id) ?? {
      chatId: m.chat_id,
      name: m.first_name || m.username || String(m.chat_id),
      username: m.username,
      last: m,
      unread: 0,
      messages: [],
    };
    if (m.first_name && (t.name === String(t.chatId) || !t.name)) t.name = m.first_name;
    if (m.direction === 'in' && !m.read) t.unread += 1;
    if (m.created_at > t.last.created_at) t.last = m;
    t.messages.push(m);
    map.set(m.chat_id, t);
  }
  for (const t of map.values()) t.messages.sort((a, b) => a.created_at.localeCompare(b.created_at));
  return [...map.values()].sort((a, b) => b.last.created_at.localeCompare(a.last.created_at));
}

export function MessagesPage() {
  const [rows, setRows] = useState<Msg[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      const { data, error } = await requireSupabase()
        .from('telegram_messages')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(500);
      if (error) throw error;
      setRows((data ?? []) as Msg[]);
      setErr(null);
    } catch (e: any) { setErr(e.message ?? String(e)); }
    finally { setLoading(false); }
  }, []);

  // Initial load + light polling (the bot poller runs every 10s server-side).
  useEffect(() => {
    load();
    const id = window.setInterval(load, 10000);
    return () => window.clearInterval(id);
  }, [load]);

  const threads = useMemo(() => groupThreads(rows), [rows]);
  const thread = threads.find(t => t.chatId === selected) ?? null;

  // Opening a thread marks its inbound messages read.
  useEffect(() => {
    if (!thread || thread.unread === 0) return;
    requireSupabase()
      .from('telegram_messages')
      .update({ read: true })
      .eq('chat_id', thread.chatId).eq('direction', 'in').eq('read', false)
      .then(() => load());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);

  useEffect(() => { bottomRef.current?.scrollIntoView({ block: 'end' }); }, [thread?.messages.length, selected]);

  const send = async () => {
    if (!thread || !draft.trim() || sending) return;
    setSending(true); setErr(null);
    const { error } = await requireSupabase().rpc('telegram_send', { p_chat_id: thread.chatId, p_text: draft.trim() });
    setSending(false);
    if (error) { setErr(error.message); return; }
    setDraft('');
    load();
  };

  const totalUnread = threads.reduce((n, t) => n + t.unread, 0);

  return (
    <PageScaffold
      title="Messages"
      subtitle={totalUnread > 0 ? `${totalUnread} unread from Telegram` : 'Customer messages from the Telegram bot'}
      actions={
        <button onClick={load} className="inline-flex items-center gap-2 text-sm font-semibold text-zinc-300 hover:text-white px-3 py-2 rounded-xl hover:bg-white/10 transition-colors">
          <RefreshCw size={15} /> Refresh
        </button>
      }
    >
      {err && <div className="mb-4 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">{err}</div>}

      {loading ? (
        <p className="text-sm text-zinc-500">Loading…</p>
      ) : threads.length === 0 ? (
        <EmptyState icon={MessageCircle} title="No messages yet"
          hint="When customers message your Telegram bot, their conversations appear here. Make sure Telegram is enabled in Settings." />
      ) : (
        <div className="grid md:grid-cols-[280px_1fr] gap-4 h-[calc(100dvh-220px)] min-h-[420px]">
          {/* Thread list */}
          <div className="rounded-2xl border border-white/10 overflow-y-auto">
            {threads.map(t => (
              <button
                key={t.chatId}
                onClick={() => setSelected(t.chatId)}
                className={`w-full text-left px-4 py-3 border-b border-white/5 transition-colors ${selected === t.chatId ? 'bg-orange-500/10' : 'hover:bg-white/[0.04]'}`}
              >
                <div className="flex items-center justify-between gap-2">
                  <p className="font-medium text-sm truncate">{t.name}</p>
                  {t.unread > 0 && (
                    <span className="shrink-0 bg-orange-500 text-black text-[10px] font-bold min-w-[18px] h-[18px] px-1 flex items-center justify-center rounded-full">{t.unread}</span>
                  )}
                </div>
                <p className="text-xs text-zinc-500 truncate mt-0.5">
                  {t.last.direction === 'out' ? 'You: ' : ''}{t.last.text}
                </p>
              </button>
            ))}
          </div>

          {/* Thread view */}
          {!thread ? (
            <div className="rounded-2xl border border-white/10 flex items-center justify-center text-sm text-zinc-500">
              Select a conversation
            </div>
          ) : (
            <div className="rounded-2xl border border-white/10 flex flex-col min-h-0">
              <header className="px-4 py-3 border-b border-white/10 shrink-0">
                <p className="font-semibold text-sm">{thread.name}</p>
                <p className="text-[11px] text-zinc-500">
                  {thread.username ? `@${thread.username} · ` : ''}chat {thread.chatId}
                </p>
              </header>
              <div className="flex-1 overflow-y-auto p-4 space-y-2">
                {thread.messages.map(m => (
                  <div key={m.id} className={`flex ${m.direction === 'out' ? 'justify-end' : 'justify-start'}`}>
                    <div className={`max-w-[75%] rounded-2xl px-3.5 py-2 text-sm whitespace-pre-wrap break-words ${
                      m.direction === 'out'
                        ? 'bg-orange-500 text-black rounded-br-sm'
                        : 'bg-white/10 text-zinc-100 rounded-bl-sm'
                    }`}>
                      {m.text}
                      <div className={`text-[10px] mt-1 ${m.direction === 'out' ? 'text-black/50' : 'text-zinc-500'}`}>{fmtTime(m.created_at)}</div>
                    </div>
                  </div>
                ))}
                <div ref={bottomRef} />
              </div>
              <div className="p-3 border-t border-white/10 shrink-0 flex gap-2">
                <input
                  value={draft}
                  onChange={e => setDraft(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
                  placeholder="Reply on Telegram…"
                  className="flex-1 bg-white/5 border border-white/15 rounded-xl px-3 py-2.5 text-sm outline-none focus:border-orange-500 transition-colors placeholder:text-zinc-500"
                />
                <button onClick={send} disabled={sending || !draft.trim()}
                  className="shrink-0 inline-flex items-center gap-1.5 bg-orange-500 text-black font-bold text-sm px-4 rounded-xl hover:bg-orange-400 transition-colors disabled:opacity-40">
                  {sending ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </PageScaffold>
  );
}
