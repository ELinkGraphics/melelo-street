import React, { useEffect, useState } from 'react';
import { Routes, Route } from 'react-router-dom';
import { ShieldCheck, LogOut, Loader2, Database } from 'lucide-react';
import { supabase, isSupabaseConfigured } from '../lib/supabase';
import { AdminLayout, FullscreenLoader } from './ui';
import { Overview, Payments } from './pages';
import { ProductsPage } from './products';
import { OrdersPage } from './orders';
import { InventoryPage } from './inventory';
import { CustomersPage } from './customers';
import { DiscountsPage } from './discounts';
import { ReportsPage } from './reports';
import { SettingsPage } from './settings';
import { StorefrontPage } from './storefront';
import { MessagesPage } from './messages';
import { ReviewsPage } from './reviews';

type AuthState = {
  status: 'loading' | 'signedout' | 'signedin';
  user: { id: string; email?: string } | null;
  isAdmin: boolean;
};

function useAdminAuth() {
  const [state, setState] = useState<AuthState>({ status: 'loading', user: null, isAdmin: false });

  useEffect(() => {
    const sb = supabase;
    if (!sb) { setState({ status: 'signedout', user: null, isAdmin: false }); return; }
    let alive = true;

    const evaluate = async (session: { user?: { id: string; email?: string } } | null) => {
      if (!session?.user) {
        if (alive) setState({ status: 'signedout', user: null, isAdmin: false });
        return;
      }
      const user = { id: session.user.id, email: session.user.email };
      const { data } = await sb.from('profiles').select('role').eq('id', user.id).maybeSingle();
      if (alive) setState({ status: 'signedin', user, isAdmin: (data as any)?.role === 'admin' });
    };

    sb.auth.getSession().then(({ data }) => evaluate(data.session));
    const { data: sub } = sb.auth.onAuthStateChange((_e, session) => evaluate(session));
    return () => { alive = false; sub.subscription.unsubscribe(); };
  }, []);

  const signOut = async () => { await supabase?.auth.signOut(); };
  return { ...state, signOut };
}

export default function AdminApp() {
  const auth = useAdminAuth();

  if (!isSupabaseConfigured) return <SetupNotice />;
  if (auth.status === 'loading') return <FullscreenLoader label="Checking access…" />;
  if (auth.status === 'signedout') return <Login />;
  if (!auth.isAdmin) return <NotAuthorized email={auth.user?.email} onSignOut={auth.signOut} />;

  return (
    <Routes>
      <Route element={<AdminLayout email={auth.user?.email} onSignOut={auth.signOut} />}>
        <Route index element={<Overview />} />
        <Route path="orders" element={<OrdersPage />} />
        <Route path="payments" element={<Payments />} />
        <Route path="products" element={<ProductsPage />} />
        <Route path="inventory" element={<InventoryPage />} />
        <Route path="customers" element={<CustomersPage />} />
        <Route path="messages" element={<MessagesPage />} />
        <Route path="reviews" element={<ReviewsPage />} />
        <Route path="discounts" element={<DiscountsPage />} />
        <Route path="reports" element={<ReportsPage />} />
        <Route path="storefront" element={<StorefrontPage />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="*" element={<Overview />} />
      </Route>
    </Routes>
  );
}

// ---------------------------------------------------------------------------
function AuthShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-[100dvh] bg-zinc-950 text-white flex items-center justify-center p-6">
      <div className="w-full max-w-sm">
        <div className="flex items-center justify-center gap-2 mb-8">
          <img src="/logo.webp" alt="Melelo" className="h-7 object-contain" />
          <span className="text-xs font-semibold uppercase tracking-[0.25em] text-zinc-400">Admin</span>
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
    <AuthShell>
      <form onSubmit={submit} className="rounded-2xl border border-white/10 bg-white/[0.03] p-6 space-y-4">
        <div>
          <h1 className="text-xl font-bold">Sign in</h1>
          <p className="text-sm text-zinc-400 mt-1">Owner access to the dashboard.</p>
        </div>
        {err && <p className="text-sm text-red-400 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2">{err}</p>}
        <input className={field} type="email" placeholder="Email" autoComplete="username" value={email} onChange={e => setEmail(e.target.value)} required />
        <input className={field} type="password" placeholder="Password" autoComplete="current-password" value={pw} onChange={e => setPw(e.target.value)} required />
        <button disabled={busy} className="w-full bg-orange-500 text-white py-3 rounded-full font-bold uppercase tracking-wide text-sm hover:bg-orange-400 transition-colors disabled:opacity-50 flex items-center justify-center gap-2">
          {busy && <Loader2 size={16} className="animate-spin" />} Sign in
        </button>
        <p className="text-[11px] text-zinc-500 leading-relaxed">
          First time? Create the owner account in Supabase → Authentication, then run the promote-to-admin
          SQL at the bottom of <span className="font-mono">0001_init.sql</span>.
        </p>
      </form>
    </AuthShell>
  );
}

function NotAuthorized({ email, onSignOut }: { email?: string; onSignOut: () => void }) {
  return (
    <AuthShell>
      <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-6 text-center space-y-4">
        <ShieldCheck size={40} className="text-amber-400 mx-auto" />
        <div>
          <h1 className="text-lg font-bold">Not authorized</h1>
          <p className="text-sm text-zinc-400 mt-1">
            <span className="text-white">{email}</span> is signed in but isn’t an admin. Promote this
            account with the SQL at the bottom of <span className="font-mono">0001_init.sql</span>.
          </p>
        </div>
        <button onClick={onSignOut} className="inline-flex items-center gap-2 text-sm font-semibold text-zinc-300 hover:text-white">
          <LogOut size={16} /> Sign out
        </button>
      </div>
    </AuthShell>
  );
}

function SetupNotice() {
  return (
    <AuthShell>
      <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-6 space-y-4">
        <Database size={36} className="text-orange-400" />
        <div>
          <h1 className="text-lg font-bold">Connect Supabase</h1>
          <p className="text-sm text-zinc-400 mt-1">The dashboard needs a Supabase project.</p>
        </div>
        <ol className="text-sm text-zinc-300 space-y-2 list-decimal list-inside">
          <li>Create a project at supabase.com.</li>
          <li>Run <span className="font-mono text-xs">supabase/migrations/0001_init.sql</span> in the SQL editor.</li>
          <li>Set <span className="font-mono text-xs">VITE_SUPABASE_URL</span> and <span className="font-mono text-xs">VITE_SUPABASE_ANON_KEY</span> in <span className="font-mono text-xs">.env</span>.</li>
          <li>Restart the dev server.</li>
        </ol>
      </div>
    </AuthShell>
  );
}
