import React, { useEffect, useState } from 'react';
import { supabase } from './lib/supabase';
import { fmtMoney, setCurrencyCode } from './lib/currency';

// Printable receipt, opened via /?receipt=<orderId>:<token> — the same secure
// (id, token) pair used for tracking links. Rendered instead of the storefront
// (see main.tsx) as a light, print-friendly document; the browser's print
// dialog turns it into a PDF on every platform.

type ReceiptOrder = {
  id: string;
  human_id: string;
  subtotal: number;
  discount: number;
  shipping: number;
  total: number;
  placed_at: string;
  approved_at: string | null;
  payment_status: 'pending' | 'paid' | 'failed' | 'refunded';
  fulfillment_status: string;
  payment_method: 'chapa' | 'bank_slip';
  address: string;
  items: { name: string; size: string; color: string; unit_price: number; qty: number }[];
};

const fmtDate = (s: string) =>
  new Date(s).toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' });

export default function ReceiptPage() {
  const [order, setOrder] = useState<ReceiptOrder | null>(null);
  const [storeName, setStoreName] = useState('Melelo Brands');
  const [contact, setContact] = useState<string | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'notfound'>('loading');

  useEffect(() => {
    const raw = new URLSearchParams(window.location.search).get('receipt') ?? '';
    const [id, token] = raw.split(':');
    if (!id || !token || !supabase) { setState('notfound'); return; }

    supabase.from('settings').select('store_name,currency,contact_email').eq('id', 1).maybeSingle().then(({ data }) => {
      const s = data as any;
      if (s?.currency) setCurrencyCode(s.currency);
      if (s?.store_name) setStoreName(s.store_name);
      if (s?.contact_email) setContact(s.contact_email);
    });

    supabase.rpc('get_order_by_token', { p_id: id, p_token: token }).then(({ data, error }) => {
      if (error || !data) { setState('notfound'); return; }
      const o = data as ReceiptOrder;
      setOrder(o);
      setState('ready');
      document.title = `Receipt ${o.human_id}`; // becomes the saved PDF's filename
    });
  }, []);

  if (state === 'loading') {
    return <div className="min-h-[100dvh] bg-white flex items-center justify-center text-zinc-500 text-sm">Loading receipt…</div>;
  }
  if (state === 'notfound' || !order) {
    return (
      <div className="min-h-[100dvh] bg-white flex items-center justify-center p-6">
        <p className="text-zinc-600 text-sm text-center">This receipt link is invalid or has expired.<br />Open the receipt from your order confirmation email or Telegram.</p>
      </div>
    );
  }

  const paid = order.payment_status === 'paid';
  const method = order.payment_method === 'chapa' ? 'Chapa' : 'Bank transfer';

  return (
    <div className="min-h-[100dvh] bg-zinc-100 text-zinc-900 py-8 px-4 print:bg-white print:py-0">
      {/* Print/download — hidden on paper */}
      <div className="max-w-2xl mx-auto mb-4 flex justify-end print:hidden">
        <button
          onClick={() => window.print()}
          className="bg-zinc-900 text-white text-sm font-semibold px-5 py-2.5 rounded-full hover:bg-zinc-700 transition-colors"
        >
          Print / Save as PDF
        </button>
      </div>

      <div className="max-w-2xl mx-auto bg-white rounded-2xl shadow-sm border border-zinc-200 p-8 md:p-10 print:shadow-none print:border-0 print:rounded-none">
        {/* Header */}
        <div className="flex items-start justify-between gap-4 pb-6 border-b border-zinc-200">
          <div>
            <p className="text-xl font-black uppercase tracking-tight">{storeName}</p>
            <p className="text-xs text-zinc-500 mt-0.5">Addis Ababa, Ethiopia{contact ? ` · ${contact}` : ''}</p>
          </div>
          <span className={`text-[11px] font-bold uppercase tracking-wider rounded-full px-3 py-1 ${
            paid ? 'bg-emerald-100 text-emerald-700'
              : order.payment_status === 'refunded' ? 'bg-blue-100 text-blue-700'
              : order.payment_status === 'failed' ? 'bg-red-100 text-red-700'
              : 'bg-amber-100 text-amber-700'
          }`}>
            {paid ? 'Paid' : order.payment_status}
          </span>
        </div>

        {/* Meta */}
        <div className="grid grid-cols-2 gap-6 py-6 border-b border-zinc-200 text-sm">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400 mb-1">Receipt for order</p>
            <p className="font-mono font-semibold">{order.human_id}</p>
            <p className="text-zinc-500 mt-2 text-xs">Placed {fmtDate(order.placed_at)}</p>
            {paid && order.approved_at && <p className="text-zinc-500 text-xs">Paid {fmtDate(order.approved_at)}</p>}
          </div>
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400 mb-1">Billed to</p>
            <p className="text-zinc-700 leading-relaxed">{order.address}</p>
          </div>
        </div>

        {/* Items */}
        <table className="w-full text-sm my-6">
          <thead>
            <tr className="text-left text-[11px] font-semibold uppercase tracking-wider text-zinc-400">
              <th className="pb-2 font-semibold">Item</th>
              <th className="pb-2 font-semibold text-center">Qty</th>
              <th className="pb-2 font-semibold text-right">Amount</th>
            </tr>
          </thead>
          <tbody>
            {order.items.map((it, i) => (
              <tr key={i} className="border-t border-zinc-100">
                <td className="py-2.5">
                  {it.name}
                  <span className="block text-xs text-zinc-500">{it.color} · Size {it.size}</span>
                </td>
                <td className="py-2.5 text-center text-zinc-600">{it.qty}</td>
                <td className="py-2.5 text-right whitespace-nowrap">{fmtMoney(Number(it.unit_price) * it.qty)}</td>
              </tr>
            ))}
          </tbody>
        </table>

        {/* Totals */}
        <div className="ml-auto max-w-[260px] text-sm space-y-1.5 pb-6 border-b border-zinc-200">
          <div className="flex justify-between text-zinc-600"><span>Subtotal</span><span>{fmtMoney(Number(order.subtotal))}</span></div>
          {Number(order.discount) > 0 && (
            <div className="flex justify-between text-emerald-700"><span>Discount</span><span>−{fmtMoney(Number(order.discount))}</span></div>
          )}
          <div className="flex justify-between text-zinc-600"><span>Shipping</span><span>{Number(order.shipping) === 0 ? 'Free' : fmtMoney(Number(order.shipping))}</span></div>
          <div className="flex justify-between font-bold text-base pt-1.5"><span>Total</span><span>{fmtMoney(Number(order.total))}</span></div>
        </div>

        {/* Payment */}
        <div className="pt-5 text-xs text-zinc-500 leading-relaxed">
          <p>{paid ? 'Paid via' : 'Payment method:'} <span className="text-zinc-700 font-medium">{method}</span> · Reference <span className="font-mono text-zinc-700">{order.human_id}</span></p>
          <p className="mt-3">Thank you for shopping with {storeName}.{contact ? ` Questions? ${contact}` : ''}</p>
        </div>
      </div>
    </div>
  );
}
