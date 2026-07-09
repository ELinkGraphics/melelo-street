import { useEffect, useRef } from 'react';

// Google AdSense — verification lives in index.html (the google-adsense-account
// meta tag). Ads are served ONLY where an <AdSlot> is placed (the About and
// Search overlays), and the AdSense script is loaded lazily the first time a
// slot mounts — so the immersive storefront, collection and checkout never
// download it and stay fast.
export const ADSENSE = {
  client: 'ca-pub-1068851952133830',
  // Fill these AFTER AdSense approves the site: create a Display ad unit
  // (AdSense → Ads → By ad unit → Display) and paste its data-ad-slot id here.
  // Until a slot is set, <AdSlot> renders nothing and loads no script.
  slots: {
    about: '',
    search: '',
  } as Record<string, string>,
};

declare global {
  interface Window { adsbygoogle?: unknown[]; }
}

let scriptRequested = false;
function loadAdSenseScript() {
  if (scriptRequested || typeof document === 'undefined') return;
  scriptRequested = true;
  const s = document.createElement('script');
  s.async = true;
  s.crossOrigin = 'anonymous';
  s.src = `https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${ADSENSE.client}`;
  document.head.appendChild(s);
}

// A single responsive display ad. No-op (renders null, loads nothing) until its
// slot id is configured above — safe to place before approval.
export function AdSlot({ slot, className }: { slot: string; className?: string }) {
  const ref = useRef<HTMLModElement>(null);
  useEffect(() => {
    if (!slot) return;
    loadAdSenseScript();
    const t = window.setTimeout(() => {
      try { (window.adsbygoogle = window.adsbygoogle || []).push({}); } catch { /* not ready yet */ }
    }, 200);
    return () => window.clearTimeout(t);
  }, [slot]);

  if (!slot) return null;
  return (
    <div className={className}>
      <p className="text-[10px] uppercase tracking-wider text-white/25 mb-1 text-center">Advertisement</p>
      <ins
        ref={ref}
        className="adsbygoogle"
        style={{ display: 'block' }}
        data-ad-client={ADSENSE.client}
        data-ad-slot={slot}
        data-ad-format="auto"
        data-full-width-responsive="true"
      />
    </div>
  );
}
