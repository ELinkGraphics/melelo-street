// Currency display for the storefront. The store's currency code lives in
// settings.currency (also what Chapa charges in — see chapa_init). Amounts in
// the DB are plain numerics; only the symbol shown to shoppers changes here.
// App.tsx / CheckoutView call setCurrencyCode() when they fetch settings.

const SYMBOLS: Record<string, string> = {
  USD: '$', ETB: 'Br ', EUR: '€', GBP: '£', KES: 'KSh ', NGN: '₦',
};

let symbol = '$';
let code = 'USD';

export function setCurrencyCode(c?: string | null) {
  code = (c ?? 'USD').trim().toUpperCase() || 'USD';
  symbol = SYMBOLS[code] ?? `${code} `;
}

export function moneySymbol() {
  return symbol;
}

// ISO code (e.g. "ETB", "USD") — for structured data / schema.org offers.
export function currencyCode() {
  return code;
}

export function fmtMoney(n: number) {
  return `${symbol}${n.toFixed(2)}`;
}
