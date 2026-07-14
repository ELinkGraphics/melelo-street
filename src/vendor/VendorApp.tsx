import React, { useEffect, useState } from 'react';
import { Loader2, LogOut, ShieldCheck, Factory } from 'lucide-react';
import { supabase, isSupabaseConfigured } from '../lib/supabase';
import { setCurrencyCode } from '../lib/currency';
import { JobsPage } from './jobs';

// Production-partner dashboard (/vendor). Same Supabase auth as the admin,
// gated on profiles.role === 'vendor'. The vendor can read ONLY the
// production tables (RLS) — no customer or revenue data exists here.

type AuthState = {
  status: 'loading' | 'signedout' | 'signedin';
  user: { id: string; email?: string } | null;
  isVendor: boolean;
};

function useVendorAuth() {
  const [state, setState] = useState<AuthState>({ status: 'loading', user: null, isVendor: false });

  useEffect(() => {
    const sb = supabase;
    if (!sb) { setState({ status: 'signedout', user: null, isVendor: false }); return; }
    let alive = true;

    const evaluate = async (session: { user?: { id: string; email?: string } } | null) => {
      if (!session?.user) {
        if (alive) setState({ status: 'signedout', user: null, isVendor: false });
        return;
      }
      const user = { id: session.user.id, email: session.user.email };
      const { data } = await sb.from('profiles').select('role').eq('id', user.id).maybeSingle();
      if (alive) setState({ status: 'signedin', user, isVendor: (data as any)?.role === 'vendor' });
    };

    sb.auth.getSession().then(({ data }) => evaluate(data.session));
    const { data: sub } = sb.auth.onAuthStateChange((_e, session) => evaluate(session));
    return () => { alive = false; sub.subscription.unsubscribe(); };
  }, []);

  const signOut = async () => { await supabase?.auth.signOut(); };
  return { ...state, signOut };
}

export default function VendorApp() {
  const auth = useVendorAuth();

  // Same store currency as the admin/storefront so cost figures match.
  const [currencyReady, setCurrencyReady] = useState(false);
  useEffect(() => {
    const sb = supabase;
    if (!sb) { setCurrencyReady(true); return; }
    sb.from('settings').select('currency').eq('id', 1).maybeSingle().then(({ data }) => {
      const c = (data as any)?.currency;
      if (c) setCurrencyCode(c);
      setCurrencyReady(true);
    });
  }, []);

  if (!isSupabaseConfigured) return <Shell><p className="text-sm text-zinc-400">Supabase is not configured.</p></Shell>;
  if (auth.status === 'loading' || !currencyReady) {
    return (
      <div className="admin-root min-h-[100dvh] bg-zinc-950 text-white flex flex-col items-center justify-center gap-3">
        <Loader2 className="animate-spin text-orange-400" size={28} />
        <p className="text-sm text-zinc-400">Checking access…</p>
      </div>
    );
  }
  if (auth.status === 'signedout') return <Login />;
  if (!auth.isVendor) return <NotAuthorized email={auth.user?.email} onSignOut={auth.signOut} />;

  return (
    <div className="admin-root min-h-[100dvh] bg-zinc-950 text-white flex flex-col">
      <header className="h-16 shrink-0 border-b border-white/10 flex items-center gap-3 px-4 md:px-8 sticky top-0 bg-zinc-950/90 backdrop-blur z-40">
        <img src="/logo.webp" alt="Melelo" className="h-6 object-contain" />
        <span className="inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-[0.2em] text-zinc-400">
          <Factory size={13} /> Production
        </span>
        <div className="ml-auto flex items-center gap-3">
          <span className="hidden sm:block text-xs text-zinc-400 truncate max-w-[180px]">{auth.user?.email}</span>
          <button onClick={auth.signOut} className="inline-flex items-center gap-1.5 text-sm font-medium text-zinc-400 hover:text-white transition-colors">
            <LogOut size={16} /> Sign out
          </button>
        </div>
      </header>
      <main className="flex-1 p-4 md:p-8 overflow-y-auto">
        <JobsPage />
      </main>
    </div>
  );
}

// ---------------------------------------------------------------------------
function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="admin-root min-h-[100dvh] bg-zinc-950 text-white flex items-center justify-center p-6">
      <div className="w-full max-w-sm">
        <div className="flex items-center justify-center gap-2 mb-8">
          <img src="/logo.webp" alt="Melelo" className="h-7 object-contain" />
          <span className="text-xs font-semibold uppercase tracking-[0.25em] text-zinc-400">Production</span>
        </div>
        {children}
      </div>
    </div>
  );
}

function Login() {
  const [email, setEmail] = useState('');
  const [pw, setPw] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!supabase) return;
    setBusy(true); setErr(null);
    const { error } = await supabase.auth.signInWithPassword({ email, password: pw });
    setBusy(false);
    if (error) setErr(error.message);
  };

  const field = 'w-full bg-white/5 border border-white/15 rounded-xl px-4 py-3 text-base outline-none focus:border-orange-500 transition-colors placeholder:text-zinc-500';

  return (
    <Shell>
      <form onSubmit={submit} className="rounded-2xl border border-white/10 bg-white/[0.03] p-6 space-y-4">
        <div>
          <h1 className="text-xl font-bold">Vendor sign in</h1>
          <p className="text-sm text-zinc-400 mt-1">Production partner access.</p>
        </div>
        {err && <p className="text-sm text-red-400 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2">{err}</p>}
        <input className={field} type="email" placeholder="Email" autoComplete="username" value={email} onChange={e => setEmail(e.target.value)} required />
        <input className={field} type="password" placeholder="Password" autoComplete="current-password" value={pw} onChange={e => setPw(e.target.value)} required />
        <button disabled={busy} className="w-full bg-orange-500 text-white py-3 rounded-full font-bold uppercase tracking-wide text-sm hover:bg-orange-400 transition-colors disabled:opacity-50 flex items-center justify-center gap-2">
          {busy && <Loader2 size={16} className="animate-spin" />} Sign in
        </button>
        <p className="text-[11px] text-zinc-400 leading-relaxed">
          Account details are provided by the Melelo team.
        </p>
      </form>
    </Shell>
  );
}

function NotAuthorized({ email, onSignOut }: { email?: string; onSignOut: () => void }) {
  return (
    <Shell>
      <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-6 text-center space-y-4">
        <ShieldCheck size={40} className="text-amber-400 mx-auto" />
        <div>
          <h1 className="text-lg font-bold">Not authorized</h1>
          <p className="text-sm text-zinc-400 mt-1">
            <span className="text-white">{email}</span> is signed in but isn't a vendor account.
            Ask the Melelo team to grant access.
          </p>
        </div>
        <button onClick={onSignOut} className="inline-flex items-center gap-2 text-sm font-semibold text-zinc-300 hover:text-white">
          <LogOut size={16} /> Sign out
        </button>
      </div>
    </Shell>
  );
}
