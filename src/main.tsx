import {StrictMode, lazy, Suspense} from 'react';
import {createRoot} from 'react-dom/client';
import {BrowserRouter, Routes, Route} from 'react-router-dom';
import App from './App.tsx';
import './index.css';

// Admin is code-split so the storefront never downloads the dashboard bundle.
const AdminApp = lazy(() => import('./admin/AdminApp.tsx'));

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
        {/* Storefront (unchanged) */}
        <Route path="/*" element={<App />} />
      </Routes>
    </BrowserRouter>
  </StrictMode>,
);
