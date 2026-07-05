import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import {
  X, Plus, Minus, Trash2, ShoppingBag, CheckCircle2,
  Package, Truck, MapPin, ChevronLeft, ChevronRight,
  Loader2, ClipboardList, Landmark, Upload, ReceiptText, BadgeCheck, Wallet,
  XCircle,
} from 'lucide-react';
import { supabase } from './lib/supabase';
import { compressImage } from './lib/imageUpload';

// ---------------------------------------------------------------------------
// Types & model
// ---------------------------------------------------------------------------
export interface CartItem {
  uid: string;       // designId + size + color, unique per line
  designId: string;  // product uuid when the catalog is DB-driven
  name: string;
  image: string;
  size: string;
  color: string;
  price: number;
  qty: number;
}

export type PaymentMethod = 'bank_slip' | 'chapa';

// Local stub of a placed order. The server owns the truth; the stub carries the
// (id, token) pair a guest needs to read their order back, plus display snapshots.
export interface OrderStub {
  id: string;        // orders.id (uuid)
  humanId: string;   // MLB-YYYYMMDD-XXXXXX
  token: string;     // tracking_token — secret; grants read access to this order
  total: number;
  placedAt: number;  // ms epoch
  address: string;
  items: CartItem[];
}

// Live order as returned by the get_order_by_token RPC.
export interface LiveOrder {
  id: string;
  human_id: string;
  subtotal: number;
  shipping: number;
  total: number;
  placed_at: string;
  approved_at: string | null;
  payment_status: 'pending' | 'paid' | 'failed' | 'refunded';
  fulfillment_status: 'pending_approval' | 'confirmed' | 'packed' | 'shipped' | 'out_for_delivery' | 'delivered' | 'cancelled';
  payment_method: PaymentMethod;
  address: string;
  items: { name: string; image: string | null; size: string; color: string; unit_price: number; qty: number }[];
  events: { status: string; note: string | null; at: string }[];
}

export type CommerceView =
  | 'closed' | 'cart' | 'checkout' | 'processing' | 'success' | 'account' | 'tracking';

export const UNIT_PRICE = 149;

// Fallback bank details; checkout fetches the live values from settings.
export const BANK_DETAILS = {
  bank: 'Commercial Bank of Ethiopia',
  name: 'Melelo Brands PLC',
  account: '1000 2345 6789 01',
};

// Fulfillment pipeline (mirrors the fulfillment_status enum, minus 'cancelled').
const STATUS_STEPS = [
  { key: 'pending_approval', label: 'Payment approval', icon: ReceiptText },
  { key: 'confirmed', label: 'Order confirmed', icon: BadgeCheck },
  { key: 'packed', label: 'Packed', icon: Package },
  { key: 'shipped', label: 'Shipped', icon: Truck },
  { key: 'out_for_delivery', label: 'Out for delivery', icon: MapPin },
  { key: 'delivered', label: 'Delivered', icon: CheckCircle2 },
] as const;

const stepIndexOf = (status: LiveOrder['fulfillment_status']) =>
  Math.max(0, STATUS_STEPS.findIndex(s => s.key === status));

function fmtMoney(n: number) {
  return `$${n.toFixed(2)}`;
}

function fmtDate(ms: number) {
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

// Fetch one order via its (id, token) pair. Returns null when unavailable.
async function fetchLiveOrder(stub: Pick<OrderStub, 'id' | 'token'>): Promise<LiveOrder | null> {
  if (!supabase) return null;
  const { data, error } = await supabase.rpc('get_order_by_token', { p_id: stub.id, p_token: stub.token });
  if (error || !data) return null;
  return data as LiveOrder;
}

// ---------------------------------------------------------------------------
// State hook — single source of truth for cart, order stubs and the overlay view
// ---------------------------------------------------------------------------
export interface Commerce {
  cart: CartItem[];
  orders: OrderStub[];
  view: CommerceView;
  setView: (v: CommerceView) => void;
  activeOrderId: string | null;
  cartCount: number;
  cartTotal: number;
  addToCart: (item: Omit<CartItem, 'uid'>) => void;
  updateQty: (uid: string, delta: number) => void;
  removeItem: (uid: string) => void;
  submitOrder: (info: {
    name: string; address: string; phone: string; email: string;
    method: PaymentMethod; slipFile: File | null; discountCode?: string;
  }) => Promise<void>;
  lastError: string | null;
  openCart: () => void;
  openAccount: () => void;
  openTracking: (orderId: string) => void;
}

export function useCommerce(): Commerce {
  const [cart, setCart] = useState<CartItem[]>(() => load('mlb_cart', []));
  // v2 key: v1 held fully-simulated orders with an incompatible shape.
  const [orders, setOrders] = useState<OrderStub[]>(() => load('mlb_orders_v2', []));
  const [view, setView] = useState<CommerceView>('closed');
  const [activeOrderId, setActiveOrderId] = useState<string | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);

  useEffect(() => { try { localStorage.setItem('mlb_cart', JSON.stringify(cart)); } catch { /* quota */ } }, [cart]);
  useEffect(() => { try { localStorage.setItem('mlb_orders_v2', JSON.stringify(orders)); } catch { /* quota */ } }, [orders]);

  const cartCount = cart.reduce((n, i) => n + i.qty, 0);
  const cartTotal = cart.reduce((n, i) => n + i.qty * i.price, 0);

  const addToCart: Commerce['addToCart'] = (item) => {
    const uid = `${item.designId}-${item.size}-${item.color}`;
    setCart(prev => {
      const existing = prev.find(i => i.uid === uid);
      if (existing) {
        return prev.map(i => i.uid === uid ? { ...i, qty: i.qty + item.qty } : i);
      }
      return [...prev, { ...item, uid }];
    });
  };

  const updateQty: Commerce['updateQty'] = (uid, delta) => {
    setCart(prev => prev
      .map(i => i.uid === uid ? { ...i, qty: i.qty + delta } : i)
      .filter(i => i.qty > 0));
  };

  const removeItem: Commerce['removeItem'] = (uid) => {
    setCart(prev => prev.filter(i => i.uid !== uid));
  };

  // Real order placement. Bank slip: upload → place_order → success view.
  // Chapa: place_order → chapa_init → redirect to Chapa's hosted checkout.
  const submitOrder: Commerce['submitOrder'] = async ({ name, address, phone, email, method, slipFile, discountCode }) => {
    setLastError(null);
    if (!supabase) {
      setLastError('Ordering is temporarily unavailable — the store backend is not connected.');
      return;
    }
    setView('processing');
    try {
      let path: string | null = null;
      if (method === 'bank_slip') {
        if (!slipFile) throw new Error('A payment slip is required.');
        // Downscale/encode client-side: a multi-MB phone photo uploads in
        // seconds instead of minutes on a slow connection.
        const { blob, ext, contentType } = await compressImage(slipFile, 1600, 0.85);
        path = `${crypto.randomUUID()}.${ext}`;
        const { error: upErr } = await supabase.storage.from('payment-slips').upload(path, blob, { contentType });
        if (upErr) throw new Error(`Slip upload failed: ${upErr.message}`);
      }

      const { data, error } = await supabase.rpc('place_order', {
        p_name: name,
        p_address: address,
        p_phone: phone,
        p_email: email.trim() || null,
        p_slip_path: path,
        p_items: cart.map(i => ({ product_id: i.designId, color: i.color, size: i.size, qty: i.qty })),
        p_discount_code: discountCode?.trim() || null,
        p_payment_method: method,
      });
      if (error) throw new Error(error.message);

      const res = data as { id: string; human_id: string; token: string; total: number };
      const stub: OrderStub = {
        id: res.id,
        humanId: res.human_id,
        token: res.token,
        total: Number(res.total),
        placedAt: Date.now(),
        address: `${name}, ${address}`,
        items: cart,
      };
      setOrders(prev => [stub, ...prev]);
      setCart([]);
      setActiveOrderId(res.id);

      if (method === 'chapa') {
        // Hosted Checkout: get the checkout_url and hand the browser to Chapa.
        // The return_url brings the customer back with ?chapa_order=<id>.
        const returnUrl = `${window.location.origin}/?chapa_order=${res.id}`;
        const { data: init, error: initErr } = await supabase.rpc('chapa_init', {
          p_id: res.id, p_token: res.token, p_return_url: returnUrl,
        });
        if (initErr) throw new Error(initErr.message);
        const url = (init as any)?.checkout_url;
        if (!url) throw new Error('Chapa did not return a checkout link.');
        window.location.href = url;
        return; // navigation takes over
      }

      setView('success');
    } catch (e: any) {
      setLastError(e?.message ?? 'Something went wrong placing your order.');
      setView('checkout');
    }
  };

  // Returning from Chapa's hosted page: confirm the payment server-side, then
  // open tracking for that order. Runs once on mount.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const orderId = params.get('chapa_order');
    if (!orderId) return;
    window.history.replaceState({}, '', window.location.pathname); // clean the URL
    const stub = (load<OrderStub[]>('mlb_orders_v2', [])).find(o => o.id === orderId);
    if (!stub || !supabase) return;
    setActiveOrderId(orderId);
    setView('tracking');
    supabase.rpc('chapa_confirm', { p_id: stub.id, p_token: stub.token }).then(() => {
      // Tracking view polls — the confirmed status appears on its next tick.
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Tracking links from notification emails: /?track=<orderId>:<token>.
  // Works on any device — the (id, token) pair alone grants read access via
  // get_order_by_token, so we mint a local stub and open the tracking view.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const track = params.get('track');
    if (!track) return;
    window.history.replaceState({}, '', window.location.pathname); // clean the URL
    const [id, token] = track.split(':');
    if (!id || !token) return;
    setOrders(prev => prev.some(o => o.id === id)
      ? prev
      : [{ id, humanId: 'Order', token, total: 0, placedAt: Date.now(), address: '', items: [] }, ...prev]);
    setActiveOrderId(id);
    setView('tracking');
    // Backfill the stub's display fields from the live order (also validates the token).
    fetchLiveOrder({ id, token }).then(live => {
      if (!live) return;
      setOrders(prev => prev.map(o => o.id === id
        ? { ...o, humanId: live.human_id, total: Number(live.total), address: live.address, placedAt: new Date(live.placed_at).getTime() }
        : o));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return {
    cart, orders, view, setView, activeOrderId, cartCount, cartTotal,
    addToCart, updateQty, removeItem, submitOrder, lastError,
    openCart: () => setView('cart'),
    openAccount: () => setView('account'),
    openTracking: (orderId) => { setActiveOrderId(orderId); setView('tracking'); },
  };
}

// ---------------------------------------------------------------------------
// Shared UI
// ---------------------------------------------------------------------------
function PanelHeader({ title, onClose, onBack }: { title: string; onClose: () => void; onBack?: () => void }) {
  return (
    <header className="flex items-center gap-3 px-6 py-5 border-b border-white/10 shrink-0">
      {onBack && (
        <button onClick={onBack} aria-label="Back" className="text-white/60 hover:text-white transition-colors -ml-1">
          <ChevronLeft size={22} />
        </button>
      )}
      <h3 className="text-base font-semibold uppercase tracking-[0.2em] flex-1">{title}</h3>
      <button onClick={onClose} aria-label="Close" className="text-white/50 hover:text-white transition-colors">
        <X size={22} />
      </button>
    </header>
  );
}

const stepVariants = {
  initial: { opacity: 0, x: 24 },
  animate: { opacity: 1, x: 0 },
  exit: { opacity: 0, x: -24 },
};

function StatusBadge({ order }: { order: Pick<LiveOrder, 'payment_status' | 'fulfillment_status'> | null }) {
  const base = 'text-[11px] font-semibold uppercase tracking-wider px-2.5 py-1 rounded-full';
  if (!order) return <span className={`${base} bg-white/10 text-zinc-400`}>—</span>;
  if (order.payment_status === 'failed') {
    return <span className={`${base} bg-red-500/15 text-red-400`}>Payment rejected</span>;
  }
  if (order.fulfillment_status === 'cancelled') {
    return <span className={`${base} bg-red-500/15 text-red-400`}>Cancelled</span>;
  }
  const idx = stepIndexOf(order.fulfillment_status);
  const delivered = order.fulfillment_status === 'delivered';
  const awaiting = order.fulfillment_status === 'pending_approval';
  const tone = delivered
    ? 'bg-green-500/15 text-green-400'
    : awaiting
      ? 'bg-amber-500/15 text-amber-400'
      : 'bg-orange-500/15 text-orange-400';
  return <span className={`${base} ${tone}`}>{STATUS_STEPS[idx].label}</span>;
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------
function CartView({ c }: { c: Commerce }) {
  return (
    <motion.div key="cart" variants={stepVariants} initial="initial" animate="animate" exit="exit" transition={{ duration: 0.25 }} className="flex flex-col h-full">
      <PanelHeader title={`Cart · ${c.cartCount}`} onClose={() => c.setView('closed')} />
      {c.cart.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center text-center px-8 gap-4 text-zinc-400">
          <ShoppingBag size={48} className="text-zinc-600" />
          <p className="text-lg font-medium text-white">Your cart is empty</p>
          <p className="text-sm">Add a look from the collection to get started.</p>
          <button onClick={() => c.setView('closed')} className="mt-2 px-6 py-2.5 rounded-full text-sm font-semibold bg-white text-black hover:bg-orange-500 hover:text-white transition-colors">
            Continue shopping
          </button>
        </div>
      ) : (
        <>
          <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
            {c.cart.map(item => (
              <div key={item.uid} className="flex gap-4 items-center bg-white/5 rounded-2xl p-3">
                <div className="w-20 h-20 rounded-xl bg-black/40 flex items-center justify-center shrink-0 overflow-hidden">
                  <img src={item.image} alt={item.name} loading="lazy" decoding="async" className="w-full h-full object-contain" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="font-semibold truncate">{item.name}</p>
                  <p className="text-xs text-zinc-400 uppercase tracking-wider">Size {item.size} · {item.color}</p>
                  <p className="text-sm font-bold mt-1">{fmtMoney(item.price)}</p>
                </div>
                <div className="flex flex-col items-end gap-2">
                  <button onClick={() => c.removeItem(item.uid)} aria-label="Remove" className="text-zinc-500 hover:text-red-400 transition-colors">
                    <Trash2 size={16} />
                  </button>
                  <div className="flex items-center gap-1 border border-white/15 rounded-full p-1">
                    <button onClick={() => c.updateQty(item.uid, -1)} aria-label="Decrease" className="w-8 h-8 rounded-full flex items-center justify-center text-zinc-300 hover:bg-white/10 hover:text-white transition-colors"><Minus size={16} /></button>
                    <span className="w-6 text-center text-sm font-semibold">{item.qty}</span>
                    <button onClick={() => c.updateQty(item.uid, 1)} aria-label="Increase" className="w-8 h-8 rounded-full flex items-center justify-center text-zinc-300 hover:bg-white/10 hover:text-white transition-colors"><Plus size={16} /></button>
                  </div>
                </div>
              </div>
            ))}
          </div>
          <div className="border-t border-white/10 px-6 pt-6 pb-[calc(1.5rem_+_env(safe-area-inset-bottom))] space-y-4 shrink-0">
            <div className="flex justify-between text-sm text-zinc-400">
              <span>Subtotal</span><span className="text-white font-semibold">{fmtMoney(c.cartTotal)}</span>
            </div>
            <div className="flex justify-between text-sm text-zinc-400">
              <span>Shipping</span><span className="text-white font-semibold">Free</span>
            </div>
            <button onClick={() => c.setView('checkout')} className="w-full bg-white text-black py-4 rounded-full font-bold uppercase tracking-wide hover:bg-orange-500 hover:text-white transition-colors">
              Checkout · {fmtMoney(c.cartTotal)}
            </button>
          </div>
        </>
      )}
    </motion.div>
  );
}

function CheckoutView({ c }: { c: Commerce }) {
  const [name, setName] = useState('');
  const [address, setAddress] = useState('');
  const [phone, setPhone] = useState('');
  const [method, setMethod] = useState<PaymentMethod | null>(null);
  const [slipFile, setSlipFile] = useState<File | null>(null);
  const [slipPreview, setSlipPreview] = useState('');
  const fileRef = React.useRef<HTMLInputElement>(null);
  const [bank, setBank] = useState(BANK_DETAILS);
  const [ship, setShip] = useState<{ flat: number; threshold: number | null }>({ flat: 0, threshold: null });
  const [email, setEmail] = useState('');
  const [chapaEnabled, setChapaEnabled] = useState(false);

  // Discount code entry — validated server-side via the validate_discount RPC.
  const [code, setCode] = useState('');
  const [applied, setApplied] = useState<{ code: string; amount: number; label: string } | null>(null);
  const [codeErr, setCodeErr] = useState<string | null>(null);
  const [checkingCode, setCheckingCode] = useState(false);

  // Live bank details + shipping rules + Chapa availability from settings (public read).
  useEffect(() => {
    supabase?.from('settings').select('bank_details,shipping_flat,free_ship_threshold,chapa_enabled').eq('id', 1).maybeSingle().then(({ data }) => {
      const s = data as any;
      const bd = s?.bank_details;
      if (bd?.bank && bd?.name && bd?.account) setBank(bd);
      if (s) setShip({ flat: Number(s.shipping_flat ?? 0), threshold: s.free_ship_threshold != null ? Number(s.free_ship_threshold) : null });
      setChapaEnabled(Boolean(s?.chapa_enabled));
    });
  }, []);

  const applyCode = async () => {
    const trimmed = code.trim();
    if (!trimmed || !supabase) return;
    setCheckingCode(true); setCodeErr(null);
    const { data, error } = await supabase.rpc('validate_discount', { p_code: trimmed, p_subtotal: c.cartTotal });
    setCheckingCode(false);
    const res = data as any;
    if (error || !res) { setCodeErr('Could not check the code — try again.'); return; }
    if (!res.valid) { setApplied(null); setCodeErr(res.message ?? 'Invalid code.'); return; }
    setApplied({ code: res.code, amount: Number(res.amount), label: res.label });
  };

  // Mirrors the server's shipping rule for display; the server recomputes at placement.
  const discountAmt = applied?.amount ?? 0;
  const shippingAmt = ship.threshold != null && (c.cartTotal - discountAmt) >= ship.threshold ? 0 : ship.flat;
  const grandTotal = Math.max(0, c.cartTotal - discountAmt) + shippingAmt;

  const onFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setSlipFile(file);
    setSlipPreview(prev => {
      if (prev) URL.revokeObjectURL(prev);
      return URL.createObjectURL(file);
    });
  };

  const valid = !!(name.trim() && address.trim() && (
    (method === 'bank_slip' && slipFile) ||
    (method === 'chapa' && /^\S+@\S+\.\S+$/.test(email.trim()))
  ));

  const placeOrder = () => {
    if (!valid || !method) return;
    c.submitOrder({
      name: name.trim(), address: address.trim(), phone: phone.trim(), email: email.trim(),
      method, slipFile, discountCode: applied?.code,
    });
  };

  // text-base (16px) is required on iOS — smaller fonts trigger auto-zoom on focus.
  const field = 'w-full bg-white/5 border border-white/15 rounded-xl px-4 py-3 text-base outline-none focus:border-orange-500 transition-colors placeholder:text-zinc-500';

  return (
    <motion.div key="checkout" variants={stepVariants} initial="initial" animate="animate" exit="exit" transition={{ duration: 0.25 }} className="flex flex-col h-full">
      <PanelHeader title="Checkout" onClose={() => c.setView('closed')} onBack={() => c.setView('cart')} />
      <div className="flex-1 overflow-y-auto px-6 py-5 space-y-6">
        {c.lastError && (
          <div className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">
            {c.lastError}
          </div>
        )}
        <section className="space-y-3">
          <h4 className="text-xs font-semibold uppercase tracking-[0.2em] text-zinc-400 flex items-center gap-2"><MapPin size={14} /> Shipping</h4>
          <input className={field} placeholder="Full name" value={name} onChange={e => setName(e.target.value)} />
          <input className={field} placeholder="Address, city" value={address} onChange={e => setAddress(e.target.value)} />
          <input className={field} placeholder="Phone (optional)" value={phone} onChange={e => setPhone(e.target.value)} />
          <input className={field} type="email" placeholder={method === 'chapa' ? 'Email (required for Chapa)' : 'Email (optional)'} value={email} onChange={e => setEmail(e.target.value)} />
        </section>

        <section className="space-y-3">
          <h4 className="text-xs font-semibold uppercase tracking-[0.2em] text-zinc-400 flex items-center gap-2"><Wallet size={14} /> Payment method</h4>

          {/* Chapa — live when the admin toggle is on, otherwise "Coming soon" */}
          {chapaEnabled ? (
            <button
              type="button" onClick={() => setMethod('chapa')}
              className={`w-full flex items-center gap-3 border rounded-xl px-4 py-3 text-left transition-colors ${method === 'chapa' ? 'border-orange-500 bg-orange-500/10' : 'border-white/15 hover:border-white/30'}`}
            >
              <Wallet size={20} className="text-orange-400 shrink-0" />
              <div className="flex-1">
                <p className="text-sm font-semibold">Chapa</p>
                <p className="text-[11px] text-zinc-500">Cards, telebirr, mobile money — secure hosted checkout</p>
              </div>
              <span className={`w-4 h-4 rounded-full border-2 ${method === 'chapa' ? 'border-orange-500 bg-orange-500' : 'border-zinc-500'}`} />
            </button>
          ) : (
            <button
              type="button" disabled
              className="w-full flex items-center gap-3 border border-white/10 rounded-xl px-4 py-3 text-left opacity-60 cursor-not-allowed"
            >
              <Wallet size={20} className="text-zinc-400 shrink-0" />
              <div className="flex-1">
                <p className="text-sm font-semibold">Chapa</p>
                <p className="text-[11px] text-zinc-500">Cards, mobile money & more</p>
              </div>
              <span className="text-[10px] font-bold uppercase tracking-wider bg-zinc-700 text-zinc-200 px-2 py-1 rounded-full">Coming soon</span>
            </button>
          )}
          {method === 'chapa' && (
            <p className="text-[11px] text-zinc-500 px-1">
              You'll be redirected to Chapa's secure page to pay, then brought back here to track your order.
            </p>
          )}

          {/* Bank slip — active */}
          <button
            type="button" onClick={() => setMethod('bank_slip')}
            className={`w-full flex items-center gap-3 border rounded-xl px-4 py-3 text-left transition-colors ${method === 'bank_slip' ? 'border-orange-500 bg-orange-500/10' : 'border-white/15 hover:border-white/30'}`}
          >
            <Landmark size={20} className="text-orange-400 shrink-0" />
            <div className="flex-1">
              <p className="text-sm font-semibold">Bank transfer slip</p>
              <p className="text-[11px] text-zinc-500">Transfer, then upload your screenshot</p>
            </div>
            <span className={`w-4 h-4 rounded-full border-2 ${method === 'bank_slip' ? 'border-orange-500 bg-orange-500' : 'border-zinc-500'}`} />
          </button>

          {method === 'bank_slip' && (
            <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} className="space-y-3 overflow-hidden">
              <div className="bg-white/5 rounded-xl p-4 text-sm space-y-1.5">
                <p className="text-[11px] uppercase tracking-wider text-zinc-400 mb-1">Transfer {fmtMoney(grandTotal)} to</p>
                <div className="flex justify-between"><span className="text-zinc-400">Bank</span><span className="font-medium text-right">{bank.bank}</span></div>
                <div className="flex justify-between"><span className="text-zinc-400">Account name</span><span className="font-medium text-right">{bank.name}</span></div>
                <div className="flex justify-between"><span className="text-zinc-400">Account no.</span><span className="font-mono font-medium text-right">{bank.account}</span></div>
              </div>

              <input ref={fileRef} type="file" accept="image/*" onChange={onFile} className="hidden" />
              {slipFile ? (
                <div className="flex items-center gap-3 bg-white/5 rounded-xl p-3">
                  <img src={slipPreview} alt="Payment slip" className="w-14 h-14 rounded-lg object-cover bg-black/40" />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium flex items-center gap-1.5"><CheckCircle2 size={14} className="text-green-400" /> Screenshot ready</p>
                    <p className="text-[11px] text-zinc-500">Will be reviewed for payment approval</p>
                  </div>
                  <button onClick={() => fileRef.current?.click()} className="text-xs font-semibold text-orange-400 hover:text-orange-300">Replace</button>
                </div>
              ) : (
                <button onClick={() => fileRef.current?.click()}
                  className="w-full flex items-center justify-center gap-2 border border-dashed border-white/25 rounded-xl px-4 py-5 text-sm text-zinc-300 hover:border-orange-500 hover:text-white transition-colors">
                  <Upload size={18} /> Upload payment screenshot
                </button>
              )}
            </motion.div>
          )}
        </section>

        {/* Discount code */}
        <section className="space-y-2">
          <h4 className="text-xs font-semibold uppercase tracking-[0.2em] text-zinc-400">Discount code</h4>
          <div className="flex gap-2">
            <input
              className={`${field} font-mono uppercase`} placeholder="e.g. WELCOME10" value={code}
              onChange={e => { setCode(e.target.value.toUpperCase()); setCodeErr(null); }}
              onKeyDown={e => { if (e.key === 'Enter') applyCode(); }}
            />
            <button onClick={applyCode} disabled={!code.trim() || checkingCode}
              className="shrink-0 px-5 rounded-xl border border-white/20 text-sm font-semibold hover:bg-white hover:text-black transition-colors disabled:opacity-40">
              {checkingCode ? <Loader2 size={16} className="animate-spin" /> : 'Apply'}
            </button>
          </div>
          {codeErr && <p className="text-xs text-red-400">{codeErr}</p>}
          {applied && (
            <p className="text-xs text-green-400 flex items-center gap-1.5">
              <CheckCircle2 size={13} /> {applied.code} applied — {applied.label}
              <button onClick={() => { setApplied(null); setCode(''); }} className="text-zinc-500 hover:text-white underline ml-1">remove</button>
            </p>
          )}
        </section>
      </div>
      <div className="border-t border-white/10 px-6 pt-5 pb-[calc(1.5rem_+_env(safe-area-inset-bottom))] space-y-3 shrink-0">
        <div className="space-y-1.5 text-sm">
          <div className="flex justify-between text-zinc-400">
            <span>Subtotal</span><span className="text-white">{fmtMoney(c.cartTotal)}</span>
          </div>
          {applied && (
            <div className="flex justify-between text-green-400">
              <span>Discount ({applied.code})</span><span>−{fmtMoney(discountAmt)}</span>
            </div>
          )}
          <div className="flex justify-between text-zinc-400">
            <span>Shipping</span><span className="text-white">{shippingAmt === 0 ? 'Free' : fmtMoney(shippingAmt)}</span>
          </div>
          <div className="flex justify-between pt-1.5 border-t border-white/10">
            <span className="text-zinc-400">Total</span>
            <span className="text-xl font-bold">{fmtMoney(grandTotal)}</span>
          </div>
        </div>
        <button onClick={placeOrder} disabled={!valid}
          className="w-full bg-white text-black py-4 rounded-full font-bold uppercase tracking-wide hover:bg-orange-500 hover:text-white transition-colors disabled:opacity-40 disabled:hover:bg-white disabled:hover:text-black disabled:cursor-not-allowed">
          Place order
        </button>
      </div>
    </motion.div>
  );
}

function ProcessingView() {
  return (
    <motion.div key="processing" variants={stepVariants} initial="initial" animate="animate" exit="exit" transition={{ duration: 0.25 }} className="flex flex-col items-center justify-center h-full gap-5 text-center px-8">
      <Loader2 size={44} className="text-orange-400 animate-spin" />
      <p className="text-lg font-medium">Submitting your order…</p>
      <p className="text-sm text-zinc-400">Uploading your slip and reserving your items.</p>
    </motion.div>
  );
}

function SuccessView({ c }: { c: Commerce }) {
  const order = c.orders.find(o => o.id === c.activeOrderId);
  return (
    <motion.div key="success" variants={stepVariants} initial="initial" animate="animate" exit="exit" transition={{ duration: 0.25 }} className="flex flex-col h-full">
      <PanelHeader title="Order received" onClose={() => c.setView('closed')} />
      <div className="flex-1 flex flex-col items-center justify-center text-center px-8 gap-4">
        <motion.div initial={{ scale: 0 }} animate={{ scale: 1 }} transition={{ type: 'spring', stiffness: 260, damping: 18, delay: 0.1 }}>
          <CheckCircle2 size={72} className="text-green-400" />
        </motion.div>
        <h2 className="text-2xl font-bold">Order received</h2>
        <p className="text-sm text-zinc-400">Thanks! Your bank slip is now pending <span className="text-amber-400 font-medium">payment approval</span> — we'll review it and confirm your order shortly.</p>
        {order && (
          <div className="w-full bg-white/5 rounded-2xl p-4 mt-2 text-left">
            <div className="flex justify-between text-sm"><span className="text-zinc-400">Order</span><span className="font-mono font-semibold">{order.humanId}</span></div>
            <div className="flex justify-between text-sm mt-1"><span className="text-zinc-400">Total</span><span className="font-semibold">{fmtMoney(order.total)}</span></div>
            <div className="flex justify-between text-sm mt-1"><span className="text-zinc-400">Payment</span><span className="font-semibold">Bank transfer slip</span></div>
            <div className="flex justify-between text-sm mt-1"><span className="text-zinc-400">Status</span><span className="font-semibold text-orange-400">Payment approval</span></div>
          </div>
        )}
      </div>
      <div className="border-t border-white/10 px-6 pt-6 pb-[calc(1.5rem_+_env(safe-area-inset-bottom))] space-y-3 shrink-0">
        <button onClick={() => order && c.openTracking(order.id)} className="w-full bg-white text-black py-4 rounded-full font-bold uppercase tracking-wide hover:bg-orange-500 hover:text-white transition-colors">
          Track order
        </button>
        <button onClick={() => c.setView('closed')} className="w-full py-3 rounded-full text-sm font-semibold text-zinc-300 hover:text-white transition-colors">
          Continue shopping
        </button>
      </div>
    </motion.div>
  );
}

function AccountView({ c }: { c: Commerce }) {
  // Live statuses for each stub, fetched once when the panel opens.
  const [live, setLive] = useState<Record<string, LiveOrder | null>>({});
  useEffect(() => {
    let alive = true;
    (async () => {
      const entries = await Promise.all(c.orders.map(async o => [o.id, await fetchLiveOrder(o)] as const));
      if (alive) setLive(Object.fromEntries(entries));
    })();
    return () => { alive = false; };
  }, [c.orders]);

  return (
    <motion.div key="account" variants={stepVariants} initial="initial" animate="animate" exit="exit" transition={{ duration: 0.25 }} className="flex flex-col h-full">
      <PanelHeader title="My Orders" onClose={() => c.setView('closed')} />
      {c.orders.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center text-center px-8 gap-4 text-zinc-400">
          <ClipboardList size={48} className="text-zinc-600" />
          <p className="text-lg font-medium text-white">No orders yet</p>
          <p className="text-sm">Your placed orders and delivery tracking will appear here.</p>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-3 pb-[calc(1rem_+_env(safe-area-inset-bottom))]">
          {c.orders.map(order => (
            <button key={order.id} onClick={() => c.openTracking(order.id)}
              className="w-full text-left bg-white/5 hover:bg-white/10 rounded-2xl p-4 transition-colors flex items-center gap-4">
              <div className="flex -space-x-3 shrink-0">
                {order.items.slice(0, 3).map(it => (
                  <div key={it.uid} className="w-12 h-12 rounded-lg bg-black/50 border border-white/10 overflow-hidden flex items-center justify-center">
                    <img src={it.image} alt="" loading="lazy" decoding="async" className="w-full h-full object-contain" />
                  </div>
                ))}
              </div>
              <div className="flex-1 min-w-0">
                <p className="font-mono text-xs text-zinc-400">{order.humanId}</p>
                <p className="text-sm font-medium">{fmtDate(order.placedAt)} · {fmtMoney(order.total)}</p>
                <div className="mt-1.5"><StatusBadge order={live[order.id] ?? null} /></div>
              </div>
              <ChevronRight size={18} className="text-zinc-500 shrink-0" />
            </button>
          ))}
        </div>
      )}
    </motion.div>
  );
}

function TrackingView({ c }: { c: Commerce }) {
  const stub = c.orders.find(o => o.id === c.activeOrderId);
  const [order, setOrder] = useState<LiveOrder | null>(null);
  const [loading, setLoading] = useState(true);
  const back = c.orders.length > 0 ? () => c.setView('account') : undefined;

  // Poll the live order every 8s while the panel is open — the admin advancing
  // fulfillment shows up here without a refresh.
  const refresh = useCallback(async () => {
    if (!stub) { setLoading(false); return; }
    const data = await fetchLiveOrder(stub);
    setOrder(data);
    setLoading(false);
  }, [stub?.id, stub?.token]);

  useEffect(() => {
    setLoading(true);
    refresh();
    const id = setInterval(refresh, 8000);
    return () => clearInterval(id);
  }, [refresh]);

  if (!stub || (!loading && !order)) {
    return (
      <motion.div key="tracking" variants={stepVariants} initial="initial" animate="animate" exit="exit" transition={{ duration: 0.25 }} className="flex flex-col h-full">
        <PanelHeader title="Tracking" onClose={() => c.setView('closed')} onBack={back} />
        <div className="flex-1 flex items-center justify-center text-zinc-400">Order not found.</div>
      </motion.div>
    );
  }

  if (loading || !order) {
    return (
      <motion.div key="tracking" variants={stepVariants} initial="initial" animate="animate" exit="exit" transition={{ duration: 0.25 }} className="flex flex-col h-full">
        <PanelHeader title="Track Order" onClose={() => c.setView('closed')} onBack={back} />
        <div className="flex-1 flex items-center justify-center">
          <Loader2 size={28} className="text-orange-400 animate-spin" />
        </div>
      </motion.div>
    );
  }

  const rejected = order.payment_status === 'failed';
  const cancelled = order.fulfillment_status === 'cancelled';
  const idx = cancelled ? 0 : stepIndexOf(order.fulfillment_status);
  const pending = !rejected && !cancelled && order.fulfillment_status === 'pending_approval';
  const delivered = order.fulfillment_status === 'delivered';

  return (
    <motion.div key="tracking" variants={stepVariants} initial="initial" animate="animate" exit="exit" transition={{ duration: 0.25 }} className="flex flex-col h-full">
      <PanelHeader title="Track Order" onClose={() => c.setView('closed')} onBack={back} />
      <div className="flex-1 overflow-y-auto px-6 py-5 pb-[calc(1.5rem_+_env(safe-area-inset-bottom))]">
        <div className="bg-white/5 rounded-2xl p-4 mb-6">
          <div className="flex justify-between items-center">
            <span className="font-mono text-xs text-zinc-400">{order.human_id}</span>
            <StatusBadge order={order} />
          </div>
          <p className="text-sm mt-2 text-zinc-300">{order.address}</p>
          <p className="text-sm mt-1 text-zinc-400">
            {rejected
              ? 'Payment was not approved. Please place a new order with a valid slip.'
              : cancelled
                ? 'This order was cancelled.'
                : delivered
                  ? 'Delivered — enjoy!'
                  : pending
                    ? 'Waiting for payment approval…'
                    : `Est. delivery ${fmtDate(new Date(order.placed_at).getTime() + 3 * 86400000)}`}
          </p>
        </div>

        {/* Payment */}
        <div className="flex items-center gap-3 bg-white/5 rounded-2xl p-3 mb-6">
          <div className="w-12 h-12 rounded-lg bg-black/40 flex items-center justify-center overflow-hidden shrink-0">
            <Landmark size={18} className="text-zinc-400" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium">{order.payment_method === 'chapa' ? 'Chapa' : 'Bank transfer slip'}</p>
            <p className={`text-xs ${rejected ? 'text-red-400' : pending ? 'text-amber-400' : 'text-green-400'}`}>
              {rejected ? 'Payment rejected'
                : pending ? (order.payment_method === 'chapa' ? 'Awaiting payment' : 'Awaiting payment approval')
                : (order.payment_method === 'chapa' ? 'Paid via Chapa' : 'Payment approved')}
            </p>
          </div>
        </div>

        {/* Timeline */}
        <div className="relative pl-2">
          {STATUS_STEPS.map((step, i) => {
            const failedHere = (rejected || cancelled) && i === 0;
            const done = !rejected && !cancelled && i <= idx;
            const current = !rejected && !cancelled && i === idx && !delivered;
            const Icon = failedHere ? XCircle : step.icon;
            const last = i === STATUS_STEPS.length - 1;
            return (
              <div key={step.key} className="flex gap-4 relative">
                {!last && (
                  <span className={`absolute left-[19px] top-10 bottom-0 w-[2px] ${done && i < idx ? 'bg-orange-500' : 'bg-white/10'}`} />
                )}
                <div className={`relative z-10 w-10 h-10 rounded-full flex items-center justify-center shrink-0 transition-colors ${failedHere ? 'bg-red-500 text-white' : done ? 'bg-orange-500 text-black' : 'bg-white/10 text-zinc-500'} ${current ? 'ring-4 ring-orange-500/25' : ''}`}>
                  <Icon size={18} />
                </div>
                <div className={`pb-8 pt-1.5 ${failedHere || done ? '' : 'opacity-50'}`}>
                  <p className="font-semibold leading-tight">{failedHere ? (rejected ? 'Payment rejected' : 'Cancelled') : step.label}</p>
                  <p className="text-xs text-zinc-400 mt-0.5">
                    {failedHere ? (rejected ? 'Slip not accepted' : 'Order cancelled') : done ? (current ? 'In progress…' : 'Completed') : 'Pending'}
                  </p>
                </div>
              </div>
            );
          })}
        </div>

        {/* Items */}
        <div className="mt-2 border-t border-white/10 pt-5 space-y-3">
          <h4 className="text-xs font-semibold uppercase tracking-[0.2em] text-zinc-400">Items</h4>
          {order.items.map((it, i) => (
            <div key={i} className="flex items-center gap-3">
              <div className="w-12 h-12 rounded-lg bg-black/40 overflow-hidden flex items-center justify-center">
                {it.image && <img src={it.image} alt="" loading="lazy" decoding="async" className="w-full h-full object-contain" />}
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium truncate">{it.name}</p>
                <p className="text-xs text-zinc-400">Size {it.size} · {it.color} · Qty {it.qty}</p>
              </div>
              <span className="text-sm font-semibold">{fmtMoney(Number(it.unit_price) * it.qty)}</span>
            </div>
          ))}
        </div>
      </div>
    </motion.div>
  );
}

// ---------------------------------------------------------------------------
// Overlay layer — render once near the App root
// ---------------------------------------------------------------------------
export function CommerceLayer({ c }: { c: Commerce }) {
  const open = c.view !== 'closed';
  return (
    <AnimatePresence>
      {open && (
        <motion.div
          key="commerce-backdrop"
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
          transition={{ duration: 0.3 }}
          onClick={() => c.setView('closed')}
          className="fixed inset-0 bg-black/70 z-[115] pointer-events-auto"
        />
      )}
      {open && (
        <motion.div
          key="commerce-panel"
          initial={{ x: '100%' }} animate={{ x: 0 }} exit={{ x: '100%' }}
          transition={{ duration: 0.45, ease: [0.25, 0.1, 0.25, 1] }}
          className="fixed right-0 top-0 bottom-0 w-full sm:w-[460px] bg-zinc-950/95 z-[120] border-l border-white/10 pointer-events-auto text-white overflow-hidden will-change-transform transform-gpu"
        >
          <AnimatePresence mode="wait">
            {c.view === 'cart' && <CartView c={c} />}
            {c.view === 'checkout' && <CheckoutView c={c} />}
            {c.view === 'processing' && <ProcessingView />}
            {c.view === 'success' && <SuccessView c={c} />}
            {c.view === 'account' && <AccountView c={c} />}
            {c.view === 'tracking' && <TrackingView c={c} />}
          </AnimatePresence>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
