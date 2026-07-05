// Telegram Mini App integration. The official script is injected ONLY when the
// site is actually running inside Telegram's webview, so normal visitors keep
// the slim first-load payload.

export type TgUser = { id: number; first_name?: string; last_name?: string; username?: string };

type TgWebApp = {
  initData: string;
  initDataUnsafe?: { user?: TgUser };
  ready: () => void;
  expand: () => void;
  colorScheme?: 'light' | 'dark';
};

declare global {
  interface Window {
    Telegram?: { WebApp?: TgWebApp };
    TelegramWebviewProxy?: unknown;
  }
}

// Telegram webviews expose a proxy object and/or launch params in the URL hash
// before the official script is loaded.
export function isTelegramContext(): boolean {
  if (typeof window === 'undefined') return false;
  return Boolean(
    window.TelegramWebviewProxy ||
    window.location.hash.includes('tgWebAppData') ||
    window.Telegram?.WebApp?.initData
  );
}

let initPromise: Promise<TgWebApp | null> | null = null;

// Idempotent: injects telegram-web-app.js (Telegram context only), then signals
// ready + expands the webview to full height.
export function initTelegram(): Promise<TgWebApp | null> {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    if (!isTelegramContext()) return null;
    if (!window.Telegram?.WebApp) {
      await new Promise<void>(resolve => {
        const s = document.createElement('script');
        s.src = 'https://telegram.org/js/telegram-web-app.js';
        s.onload = () => resolve();
        s.onerror = () => resolve(); // degrade to a normal web session
        document.head.appendChild(s);
      });
    }
    const wa = window.Telegram?.WebApp ?? null;
    if (wa) {
      try { wa.ready(); wa.expand(); } catch { /* older clients */ }
    }
    return wa;
  })();
  return initPromise;
}

// Signed init payload — verified server-side (telegram_verify_init) before any
// order is linked to a chat. Null outside Telegram.
export function getTgInitData(): string | null {
  const d = window.Telegram?.WebApp?.initData;
  return d && d.length > 0 ? d : null;
}

// UNVERIFIED user info — fine for UI niceties (prefilling a name), never for auth.
export function tgUser(): TgUser | null {
  return window.Telegram?.WebApp?.initDataUnsafe?.user ?? null;
}
