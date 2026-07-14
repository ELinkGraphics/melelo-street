import {StrictMode, lazy, Suspense} from 'react';
import {createRoot} from 'react-dom/client';
import {BrowserRouter, Routes, Route} from 'react-router-dom';
import App from './App.tsx';
import './index.css';

// Admin is code-split so the storefront never downloads the dashboard bundle.
const AdminApp = lazy(() => import('./admin/AdminApp.tsx'));

// Vendor production dashboard — code-split; only the production partner uses it.
const VendorApp = lazy(() => import('./vendor/VendorApp.tsx'));

// Printable receipt (/?receipt=<id>:<token>) — a standalone light document,
// also code-split since it's only opened from emails/Telegram.
const ReceiptPage = lazy(() => import('./receipt.tsx'));
const wantsReceipt = new URLSearchParams(window.location.search).has('receipt');

// Production-only service worker: repeat opens serve images/assets from disk
// (dev is excluded so local changes are never masked by a stale cache).
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => { /* non-fatal */ });
  });
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        {/* Admin dashboard — guarded inside AdminApp */}
        <Route
          path="/admin/*"
          element={
            <Suspense fallback={<div className="min-h-[100dvh] bg-zinc-950" />}>
              <AdminApp />
            </Suspense>
          }
        />
        {/* Vendor production dashboard — guarded inside VendorApp */}
        <Route
          path="/vendor/*"
          element={
            <Suspense fallback={<div className="min-h-[100dvh] bg-zinc-950" />}>
              <VendorApp />
            </Suspense>
          }
        />
        {/* Storefront — or the printable receipt when the URL asks for one */}
        <Route
          path="/*"
          element={wantsReceipt
            ? <Suspense fallback={<div className="min-h-[100dvh] bg-white" />}><ReceiptPage /></Suspense>
            : <App />}
        />
      </Routes>
    </BrowserRouter>
  </StrictMode>,
);
