import React, { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import {
  X, Plus, Minus, Trash2, ShoppingBag, CheckCircle2,
  Package, Truck, MapPin, ChevronLeft, ChevronRight,
  Loader2, ClipboardList, Landmark, Upload, ReceiptText, BadgeCheck, Wallet,
  ShieldCheck, XCircle,
} from 'lucide-react';

// ---------------------------------------------------------------------------
// Types & model
// ---------------------------------------------------------------------------
export interface CartItem {
  uid: string;       // designId + size + color, unique per line
  designId: string;
  name: string;
  image: string;
  size: string;
  color: string;
  price: number;
  qty: number;
}

export type PaymentMethod = 'bank_slip' | 'chapa';

export interface Order {
  id: string;
  items: CartItem[];
  total: number;
  placedAt: number;  // ms epoch
  address: string;
  paymentMethod: PaymentMethod;
  slip?: string;     // uploaded bank-transfer screenshot (data URL)
  approvedAt?: number; // set when an admin approves the slip; drives the delivery sim
  rejected?: boolean;  // admin rejected the slip
}

export type CommerceView =
  | 'closed' | 'cart' | 'checkout' | 'processing' | 'success' | 'account' | 'tracking' | 'admin';

export const UNIT_PRICE = 149;
const SHIPPING = 0;

// Bank transfer target shown for the slip payment.
export const BANK_DETAILS = {
  bank: 'Commercial Bank of Ethiopia',
  name: 'Melelo Brands PLC',
  account: '1000 2345 6789 01',
};

// Delivery simulation: order advances one step every STEP_MS while you watch.
// Step 0 is the bank-slip "Payment approval" review stage.
const STEP_MS = 6000;
const STATUS_STEPS = [
  { label: 'Payment approval', icon: ReceiptText },
  { label: 'Order confirmed', icon: BadgeCheck },
  { label: 'Packed', icon: Package },
  { label: 'Shipped', icon: Truck },
  { label: 'Out for delivery', icon: MapPin },
  { label: 'Delivered', icon: CheckCircle2 },
];

// Step 0 (Payment approval) holds until an admin approves; the rest are timed from approval.
function statusIndexFor(order: Order, now: number) {
  if (!order.approvedAt) return 0;
  const steps = Math.floor((now - order.approvedAt) / STEP_MS);
  return Math.min(STATUS_STEPS.length - 1, 1 + steps);
}

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

// ---------------------------------------------------------------------------
// State hook — single source of truth for cart, orders and the overlay view
// ---------------------------------------------------------------------------
export interface Commerce {
  cart: CartItem[];
  orders: Order[];
  view: CommerceView;
  setView: (v: CommerceView) => void;
  activeOrderId: string | null;
  cartCount: number;
  cartTotal: number;
  addToCart: (item: Omit<CartItem, 'uid'>) => void;
  updateQty: (uid: string, delta: number) => void;
  removeItem: (uid: string) => void;
  placeOrder: (address: string, slip: string) => Order;
  approveOrder: (orderId: string) => void;
  rejectOrder: (orderId: string) => void;
  pendingCount: number;
  openCart: () => void;
  openAccount: () => void;
  openAdmin: () => void;
  openTracking: (orderId: string) => void;
}

export function useCommerce(): Commerce {
  const [cart, setCart] = useState<CartItem[]>(() => load('mlb_cart', []));
  const [orders, setOrders] = useState<Order[]>(() => load('mlb_orders', []));
  const [view, setView] = useState<CommerceView>('closed');
  const [activeOrderId, setActiveOrderId] = useState<string | null>(null);

  useEffect(() => { try { localStorage.setItem('mlb_cart', JSON.stringify(cart)); } catch { /* quota */ } }, [cart]);
  useEffect(() => { try { localStorage.setItem('mlb_orders', JSON.stringify(orders)); } catch { /* quota — slip images can be large */ } }, [orders]);

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

  const placeOrder: Commerce['placeOrder'] = (address, slip) => {
    const stamp = new Date();
    const id = `MLB-${stamp.getFullYear()}${String(stamp.getMonth() + 1).padStart(2, '0')}${String(stamp.getDate()).padStart(2, '0')}-${Math.floor(1000 + Math.random() * 9000)}`;
    const order: Order = {
      id,
      items: cart,
      total: cartTotal + SHIPPING,
      placedAt: Date.now(),
      address,
      paymentMethod: 'bank_slip',
      slip,
    };
    setOrders(prev => [order, ...prev]);
    setCart([]);
    setActiveOrderId(id);
    return order;
  };

  const approveOrder: Commerce['approveOrder'] = (orderId) => {
    setOrders(prev => prev.map(o => o.id === orderId ? { ...o, approvedAt: Date.now(), rejected: false } : o));
  };

  const rejectOrder: Commerce['rejectOrder'] = (orderId) => {
    setOrders(prev => prev.map(o => o.id === orderId ? { ...o, rejected: true, approvedAt: undefined } : o));
  };

  const pendingCount = orders.filter(o => !o.approvedAt && !o.rejected).length;

  return {
    cart, orders, view, setView, activeOrderId, cartCount, cartTotal,
    addToCart, updateQty, removeItem, placeOrder, approveOrder, rejectOrder, pendingCount,
    openCart: () => setView('cart'),
    openAccount: () => setView('account'),
    openAdmin: () => setView('admin'),
    openTracking: (orderId) => { setActiveOrderId(orderId); setView('tracking'); },
  };
}

// ---------------------------------------------------------------------------
// Shared UI
// ---------------------------------------------------------------------------
function useNow(active: boolean) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

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
                  <img src={item.image} alt={item.name} className="w-full h-full object-contain" />
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
  const [method, setMethod] = useState<PaymentMethod | null>(null);
  const [slip, setSlip] = useState('');
  const fileRef = React.useRef<HTMLInputElement>(null);

  const onFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setSlip(reader.result as string);
    reader.readAsDataURL(file);
  };

  const valid = !!(name.trim() && address.trim() && method === 'bank_slip' && slip);

  const placeOrder = () => {
    if (!valid) return;
    c.setView('processing');
    setTimeout(() => {
      c.placeOrder(`${name}, ${address}`, slip);
      c.setView('success');
    }, 1500);
  };

  // text-base (16px) is required on iOS — smaller fonts trigger auto-zoom on focus.
  const field = 'w-full bg-white/5 border border-white/15 rounded-xl px-4 py-3 text-base outline-none focus:border-orange-500 transition-colors placeholder:text-zinc-500';

  return (
    <motion.div key="checkout" variants={stepVariants} initial="initial" animate="animate" exit="exit" transition={{ duration: 0.25 }} className="flex flex-col h-full">
      <PanelHeader title="Checkout" onClose={() => c.setView('closed')} onBack={() => c.setView('cart')} />
      <div className="flex-1 overflow-y-auto px-6 py-5 space-y-6">
        <section className="space-y-3">
          <h4 className="text-xs font-semibold uppercase tracking-[0.2em] text-zinc-400 flex items-center gap-2"><MapPin size={14} /> Shipping</h4>
          <input className={field} placeholder="Full name" value={name} onChange={e => setName(e.target.value)} />
          <input className={field} placeholder="Address, city" value={address} onChange={e => setAddress(e.target.value)} />
        </section>

        <section className="space-y-3">
          <h4 className="text-xs font-semibold uppercase tracking-[0.2em] text-zinc-400 flex items-center gap-2"><Wallet size={14} /> Payment method</h4>

          {/* Chapa — coming soon */}
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
                <p className="text-[11px] uppercase tracking-wider text-zinc-400 mb-1">Transfer {fmtMoney(c.cartTotal)} to</p>
                <div className="flex justify-between"><span className="text-zinc-400">Bank</span><span className="font-medium text-right">{BANK_DETAILS.bank}</span></div>
                <div className="flex justify-between"><span className="text-zinc-400">Account name</span><span className="font-medium text-right">{BANK_DETAILS.name}</span></div>
                <div className="flex justify-between"><span className="text-zinc-400">Account no.</span><span className="font-mono font-medium text-right">{BANK_DETAILS.account}</span></div>
              </div>

              <input ref={fileRef} type="file" accept="image/*" onChange={onFile} className="hidden" />
              {slip ? (
                <div className="flex items-center gap-3 bg-white/5 rounded-xl p-3">
                  <img src={slip} alt="Payment slip" className="w-14 h-14 rounded-lg object-cover bg-black/40" />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium flex items-center gap-1.5"><CheckCircle2 size={14} className="text-green-400" /> Screenshot uploaded</p>
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
      </div>
      <div className="border-t border-white/10 px-6 pt-6 pb-[calc(1.5rem_+_env(safe-area-inset-bottom))] space-y-3 shrink-0">
        <div className="flex justify-between text-sm">
          <span className="text-zinc-400">Total</span>
          <span className="text-xl font-bold">{fmtMoney(c.cartTotal)}</span>
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
      <p className="text-sm text-zinc-400">Sending your slip for payment approval.</p>
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
        <p className="text-sm text-zinc-400">Thanks! Your bank slip is now pending <span className="text-amber-400 font-medium">payment approval</span> — an admin will review and approve it before your order ships.</p>
        {order && (
          <div className="w-full bg-white/5 rounded-2xl p-4 mt-2 text-left">
            <div className="flex justify-between text-sm"><span className="text-zinc-400">Order</span><span className="font-mono font-semibold">{order.id}</span></div>
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

function StatusBadge({ order, now }: { order: Order; now: number }) {
  const base = 'text-[11px] font-semibold uppercase tracking-wider px-2.5 py-1 rounded-full';
  if (order.rejected) {
    return <span className={`${base} bg-red-500/15 text-red-400`}>Payment rejected</span>;
  }
  const index = statusIndexFor(order, now);
  const delivered = index >= STATUS_STEPS.length - 1;
  const awaiting = index === 0; // payment approval pending
  const tone = delivered
    ? 'bg-green-500/15 text-green-400'
    : awaiting
      ? 'bg-amber-500/15 text-amber-400'
      : 'bg-orange-500/15 text-orange-400';
  return <span className={`${base} ${tone}`}>{STATUS_STEPS[index].label}</span>;
}

function AccountView({ c }: { c: Commerce }) {
  const now = useNow(true);
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
        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-3">
          {c.orders.map(order => (
            <button key={order.id} onClick={() => c.openTracking(order.id)}
              className="w-full text-left bg-white/5 hover:bg-white/10 rounded-2xl p-4 transition-colors flex items-center gap-4">
              <div className="flex -space-x-3 shrink-0">
                {order.items.slice(0, 3).map(it => (
                  <div key={it.uid} className="w-12 h-12 rounded-lg bg-black/50 border border-white/10 overflow-hidden flex items-center justify-center">
                    <img src={it.image} alt="" className="w-full h-full object-contain" />
                  </div>
                ))}
              </div>
              <div className="flex-1 min-w-0">
                <p className="font-mono text-xs text-zinc-400">{order.id}</p>
                <p className="text-sm font-medium">{fmtDate(order.placedAt)} · {fmtMoney(order.total)}</p>
                <div className="mt-1.5"><StatusBadge order={order} now={now} /></div>
              </div>
              <ChevronRight size={18} className="text-zinc-500 shrink-0" />
            </button>
          ))}
        </div>
      )}
      <div className="border-t border-white/10 px-4 pt-4 pb-[calc(1rem_+_env(safe-area-inset-bottom))] shrink-0">
        <button onClick={c.openAdmin}
          className="w-full flex items-center justify-center gap-2 text-sm font-semibold text-zinc-300 hover:text-white transition-colors py-2">
          <ShieldCheck size={16} /> Admin · approvals
          {c.pendingCount > 0 && (
            <span className="bg-amber-500 text-black text-[10px] font-bold min-w-[18px] h-[18px] px-1 flex items-center justify-center rounded-full">{c.pendingCount}</span>
          )}
        </button>
      </div>
    </motion.div>
  );
}

function TrackingView({ c }: { c: Commerce }) {
  const now = useNow(true);
  const order = c.orders.find(o => o.id === c.activeOrderId);
  const back = c.orders.length > 0 ? () => c.setView('account') : undefined;

  if (!order) {
    return (
      <motion.div key="tracking" variants={stepVariants} initial="initial" animate="animate" exit="exit" transition={{ duration: 0.25 }} className="flex flex-col h-full">
        <PanelHeader title="Tracking" onClose={() => c.setView('closed')} onBack={back} />
        <div className="flex-1 flex items-center justify-center text-zinc-400">Order not found.</div>
      </motion.div>
    );
  }

  const idx = statusIndexFor(order, now);
  const rejected = !!order.rejected;
  const pending = !rejected && idx === 0;
  return (
    <motion.div key="tracking" variants={stepVariants} initial="initial" animate="animate" exit="exit" transition={{ duration: 0.25 }} className="flex flex-col h-full">
      <PanelHeader title="Track Order" onClose={() => c.setView('closed')} onBack={back} />
      <div className="flex-1 overflow-y-auto px-6 py-5">
        <div className="bg-white/5 rounded-2xl p-4 mb-6">
          <div className="flex justify-between items-center">
            <span className="font-mono text-xs text-zinc-400">{order.id}</span>
            <StatusBadge order={order} now={now} />
          </div>
          <p className="text-sm mt-2 text-zinc-300">{order.address}</p>
          <p className="text-sm mt-1 text-zinc-400">
            {rejected
              ? 'Payment was not approved. Please place a new order with a valid slip.'
              : idx >= STATUS_STEPS.length - 1
                ? `Delivered on ${fmtDate(now)}`
                : pending
                  ? 'Waiting for an admin to approve your payment…'
                  : `Est. delivery ${fmtDate(order.placedAt + 3 * 86400000)}`}
          </p>
        </div>

        {/* Payment */}
        <div className="flex items-center gap-3 bg-white/5 rounded-2xl p-3 mb-6">
          <div className="w-12 h-12 rounded-lg bg-black/40 flex items-center justify-center overflow-hidden shrink-0">
            {order.slip
              ? <img src={order.slip} alt="Payment slip" className="w-full h-full object-cover" />
              : <Landmark size={18} className="text-zinc-400" />}
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium">Bank transfer slip</p>
            <p className={`text-xs ${rejected ? 'text-red-400' : pending ? 'text-amber-400' : 'text-green-400'}`}>
              {rejected ? 'Payment rejected' : pending ? 'Awaiting payment approval' : 'Payment approved'}
            </p>
          </div>
        </div>

        {/* Timeline */}
        <div className="relative pl-2">
          {STATUS_STEPS.map((step, i) => {
            const isRejectedStep = rejected && i === 0;
            const done = !rejected && i <= idx;
            const current = !rejected && i === idx;
            const Icon = isRejectedStep ? XCircle : step.icon;
            const last = i === STATUS_STEPS.length - 1;
            return (
              <div key={step.label} className="flex gap-4 relative">
                {!last && (
                  <span className={`absolute left-[19px] top-10 bottom-0 w-[2px] ${!rejected && i < idx ? 'bg-orange-500' : 'bg-white/10'}`} />
                )}
                <div className={`relative z-10 w-10 h-10 rounded-full flex items-center justify-center shrink-0 transition-colors ${isRejectedStep ? 'bg-red-500 text-white' : done ? 'bg-orange-500 text-black' : 'bg-white/10 text-zinc-500'} ${current ? 'ring-4 ring-orange-500/25' : ''}`}>
                  <Icon size={18} />
                </div>
                <div className={`pb-8 pt-1.5 ${isRejectedStep || done ? '' : 'opacity-50'}`}>
                  <p className="font-semibold leading-tight">{isRejectedStep ? 'Payment rejected' : step.label}</p>
                  <p className="text-xs text-zinc-400 mt-0.5">
                    {isRejectedStep ? 'Slip not accepted' : done ? (current && !last ? 'In progress…' : 'Completed') : 'Pending'}
                  </p>
                </div>
              </div>
            );
          })}
        </div>

        {/* Items */}
        <div className="mt-2 border-t border-white/10 pt-5 space-y-3">
          <h4 className="text-xs font-semibold uppercase tracking-[0.2em] text-zinc-400">Items</h4>
          {order.items.map(it => (
            <div key={it.uid} className="flex items-center gap-3">
              <div className="w-12 h-12 rounded-lg bg-black/40 overflow-hidden flex items-center justify-center">
                <img src={it.image} alt="" className="w-full h-full object-contain" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium truncate">{it.name}</p>
                <p className="text-xs text-zinc-400">Size {it.size} · {it.color} · Qty {it.qty}</p>
              </div>
              <span className="text-sm font-semibold">{fmtMoney(it.price * it.qty)}</span>
            </div>
          ))}
        </div>
      </div>
    </motion.div>
  );
}

function AdminView({ c }: { c: Commerce }) {
  const now = useNow(true);
  return (
    <motion.div key="admin" variants={stepVariants} initial="initial" animate="animate" exit="exit" transition={{ duration: 0.25 }} className="flex flex-col h-full">
      <PanelHeader title="Admin · Approvals" onClose={() => c.setView('closed')} onBack={() => c.setView('account')} />
      {c.orders.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center text-center px-8 gap-4 text-zinc-400">
          <ShieldCheck size={48} className="text-zinc-600" />
          <p className="text-lg font-medium text-white">Nothing to review</p>
          <p className="text-sm">Bank-slip orders awaiting approval will show up here.</p>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-3">
          <p className="text-xs uppercase tracking-[0.2em] text-zinc-400">
            {c.pendingCount > 0 ? `${c.pendingCount} awaiting approval` : 'All caught up'}
          </p>
          {c.orders.map(order => {
            const isPending = !order.approvedAt && !order.rejected;
            return (
              <div key={order.id} className="bg-white/5 rounded-2xl p-4 space-y-3">
                <div className="flex gap-3">
                  <a href={order.slip || undefined} target="_blank" rel="noreferrer"
                    className="w-16 h-16 rounded-lg bg-black/40 overflow-hidden flex items-center justify-center shrink-0 ring-1 ring-white/10 hover:ring-orange-500 transition">
                    {order.slip
                      ? <img src={order.slip} alt="Payment slip" className="w-full h-full object-cover" />
                      : <Landmark size={20} className="text-zinc-400" />}
                  </a>
                  <div className="flex-1 min-w-0">
                    <p className="font-mono text-xs text-zinc-400">{order.id}</p>
                    <p className="text-sm font-medium truncate">{order.address}</p>
                    <p className="text-xs text-zinc-400">{order.items.reduce((n, i) => n + i.qty, 0)} item(s) · {fmtMoney(order.total)}</p>
                    <div className="mt-1.5"><StatusBadge order={order} now={now} /></div>
                  </div>
                </div>
                {isPending && (
                  <div className="flex gap-2">
                    <button onClick={() => c.approveOrder(order.id)}
                      className="flex-1 flex items-center justify-center gap-1.5 bg-green-500 text-black text-sm font-bold py-2.5 rounded-full hover:bg-green-400 transition-colors">
                      <BadgeCheck size={16} /> Approve
                    </button>
                    <button onClick={() => c.rejectOrder(order.id)}
                      className="flex-1 flex items-center justify-center gap-1.5 border border-red-500/50 text-red-400 text-sm font-bold py-2.5 rounded-full hover:bg-red-500/10 transition-colors">
                      <XCircle size={16} /> Reject
                    </button>
                  </div>
                )}
                {!isPending && (
                  <p className="text-xs text-zinc-500">
                    {order.rejected ? 'Rejected' : `Approved · slip verified`}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      )}
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
            {c.view === 'admin' && <AdminView c={c} />}
          </AnimatePresence>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
