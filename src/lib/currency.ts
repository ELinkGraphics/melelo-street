// Currency display for the storefront. The store's currency code lives in
// settings.currency (also what Chapa charges in — see chapa_init). Amounts in
// the DB are plain numerics; only the symbol shown to shoppers changes here.
// App.tsx / CheckoutView call setCurrencyCode() when they fetch settings.

const SYMBOLS: Record<string, string> = {
  USD: '$', ETB: 'Br ', EUR: '€', GBP: '£', KES: 'KSh ', NGN: '₦',
};

let symbol = '$';

export function setCurrencyCode(code?: string | null) {
  const c = (code ?? 'USD').trim().toUpperCase();
  symbol = SYMBOLS[c] ?? (c ? `${c} ` : '$');
}

export function moneySymbol() {
  return symbol;
}

export function fmtMoney(n: number) {
  return `${symbol}${n.toFixed(2)}`;
}
