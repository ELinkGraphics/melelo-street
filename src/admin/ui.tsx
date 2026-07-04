import React, { useState } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import {
  LayoutDashboard, ShoppingBag, Wallet, Shirt, Boxes, Users, Ticket,
  Settings as SettingsIcon, BarChart3, LogOut, Bell, Search, Menu, X, Loader2,
} from 'lucide-react';

// Sidebar navigation config. Paths are ABSOLUTE on purpose: relative links inside
// a splat-mounted (/admin/*) descendant <Routes> resolve against the currently
// matched path and accumulate (e.g. /admin/products/inventory/orders).
type NavItem = { to: string; label: string; icon: React.ElementType; end?: boolean };
export const NAV: NavItem[] = [
  { to: '/admin', end: true, label: 'Overview', icon: LayoutDashboard },
  { to: '/admin/orders', label: 'Orders', icon: ShoppingBag },
  { to: '/admin/payments', label: 'Payments', icon: Wallet },
  { to: '/admin/products', label: 'Catalog', icon: Shirt },
  { to: '/admin/inventory', label: 'Inventory', icon: Boxes },
  { to: '/admin/customers', label: 'Customers', icon: Users },
  { to: '/admin/discounts', label: 'Discounts', icon: Ticket },
  { to: '/admin/reports', label: 'Reports', icon: BarChart3 },
  { to: '/admin/settings', label: 'Settings', icon: SettingsIcon },
];

export function FullscreenLoader({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="min-h-[100dvh] bg-zinc-950 text-white flex flex-col items-center justify-center gap-3">
      <Loader2 className="animate-spin text-orange-400" size={28} />
      <p className="text-sm text-zinc-400">{label}</p>
    </div>
  );
}

// Consistent page frame: title, optional subtitle/actions, then children.
export function PageScaffold({
  title, subtitle, actions, children,
}: { title: string; subtitle?: string; actions?: React.ReactNode; children?: React.ReactNode }) {
  return (
    <div>
      <div className="flex items-start justify-between gap-4 mb-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
          {subtitle && <p className="text-sm text-zinc-400 mt-1">{subtitle}</p>}
        </div>
        {actions}
      </div>
      {children}
    </div>
  );
}

export function EmptyState({ icon: Icon, title, hint }: { icon: React.ElementType; title: string; hint?: string }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-12 flex flex-col items-center text-center gap-3">
      <Icon size={40} className="text-zinc-600" />
      <p className="font-medium text-white">{title}</p>
      {hint && <p className="text-sm text-zinc-500 max-w-sm">{hint}</p>}
    </div>
  );
}

export function StatCard({ label, value, sub, accent }: { label: string; value: string; sub?: string; accent?: boolean }) {
  return (
    <div className={`rounded-2xl border p-5 ${accent ? 'border-orange-500/40 bg-orange-500/10' : 'border-white/10 bg-white/[0.03]'}`}>
      <p className="text-xs uppercase tracking-wider text-zinc-400">{label}</p>
      <p className="text-2xl font-bold mt-2 leading-none">{value}</p>
      {sub && <p className="text-xs text-zinc-500 mt-1.5">{sub}</p>}
    </div>
  );
}

function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <nav className="flex flex-col gap-1 p-3">
      {NAV.map(({ to, label, icon: Icon, end }) => (
        <NavLink
          key={label}
          to={to}
          end={end ?? false}
          onClick={onNavigate}
          className={({ isActive }) =>
            `flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-colors ${
              isActive ? 'bg-orange-500 text-black' : 'text-zinc-300 hover:bg-white/10 hover:text-white'
            }`
          }
        >
          <Icon size={18} />
          {label}
        </NavLink>
      ))}
    </nav>
  );
}

export function AdminLayout({ email, onSignOut }: { email?: string; onSignOut: () => void }) {
  const [drawer, setDrawer] = useState(false);
  return (
    <div className="min-h-[100dvh] bg-zinc-950 text-white flex">
      {/* Desktop sidebar */}
      <aside className="hidden md:flex md:flex-col w-60 shrink-0 border-r border-white/10 bg-zinc-950">
        <div className="flex items-center gap-2 px-5 h-16 border-b border-white/10">
          <img src="/logo.png" alt="Melelo" className="h-6 object-contain" />
          <span className="text-xs font-semibold uppercase tracking-[0.2em] text-zinc-400">Admin</span>
        </div>
        <Sidebar />
        <button
          onClick={onSignOut}
          className="mt-auto m-3 flex items-center gap-2 px-3 py-2.5 rounded-xl text-sm font-medium text-zinc-400 hover:bg-white/10 hover:text-white transition-colors"
        >
          <LogOut size={18} /> Sign out
        </button>
      </aside>

      {/* Mobile drawer */}
      {drawer && (
        <div className="md:hidden fixed inset-0 z-50 flex">
          <div className="absolute inset-0 bg-black/60" onClick={() => setDrawer(false)} />
          <aside className="relative w-64 max-w-[80%] bg-zinc-950 border-r border-white/10 flex flex-col">
            <div className="flex items-center justify-between px-5 h-16 border-b border-white/10">
              <span className="text-xs font-semibold uppercase tracking-[0.2em] text-zinc-400">Admin</span>
              <button onClick={() => setDrawer(false)} aria-label="Close menu"><X size={20} /></button>
            </div>
            <Sidebar onNavigate={() => setDrawer(false)} />
            <button
              onClick={onSignOut}
              className="mt-auto m-3 flex items-center gap-2 px-3 py-2.5 rounded-xl text-sm font-medium text-zinc-400 hover:bg-white/10 hover:text-white"
            >
              <LogOut size={18} /> Sign out
            </button>
          </aside>
        </div>
      )}

      {/* Main column */}
      <div className="flex-1 min-w-0 flex flex-col">
        <header className="h-16 border-b border-white/10 flex items-center gap-3 px-4 md:px-8 sticky top-0 bg-zinc-950/90 backdrop-blur z-40">
          <button className="md:hidden" onClick={() => setDrawer(true)} aria-label="Open menu"><Menu size={22} /></button>
          <div className="flex-1 flex items-center gap-2 max-w-md rounded-full bg-white/5 border border-white/10 px-3 py-2 text-sm text-zinc-400">
            <Search size={16} />
            <input placeholder="Search orders, products…" className="bg-transparent outline-none w-full placeholder:text-zinc-500 text-white" />
          </div>
          <button className="relative text-zinc-400 hover:text-white transition-colors" aria-label="Notifications">
            <Bell size={20} />
          </button>
          <div className="hidden sm:flex flex-col items-end leading-tight">
            <span className="text-xs text-zinc-400">Signed in</span>
            <span className="text-xs font-medium truncate max-w-[180px]">{email}</span>
          </div>
        </header>
        <main className="flex-1 p-4 md:p-8 overflow-y-auto">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
